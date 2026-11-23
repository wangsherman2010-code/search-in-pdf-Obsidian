import {
	App,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	debounce,
	getLinkpath,
	loadPdfJs,
} from "obsidian";
import { Match, PageText, findMatches, makeSnippet, toSelection } from "./search";

interface PdfSearchSettings {
	ignoreWhitespace: boolean;
	maxResults: number;
	snippetContext: number;
	openInNewTab: boolean;
	highlightInPdf: boolean;
}

const DEFAULT_SETTINGS: PdfSearchSettings = {
	ignoreWhitespace: true,
	maxResults: 300,
	snippetContext: 50,
	openInNewTab: true,
	highlightInPdf: true,
};

interface PdfIndex {
	mtime: number;
	size: number;
	pages: PageText[];
}

type Progress = (file: TFile, done: number, total: number) => void;

export default class PdfSearchPlugin extends Plugin {
	settings: PdfSearchSettings = DEFAULT_SETTINGS;
	private cache = new Map<string, PdfIndex>();
	private pending = new Map<string, Promise<PdfIndex>>();
	/** remembered so re-opening the search after jumping to a page keeps your results */
	lastQuery = "";
	lastNotePath = "";

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("file-search", "Search PDFs in this note", () => this.openSearch());

		this.addCommand({
			id: "search-pdfs-in-note",
			name: "Search PDFs in current note",
			checkCallback: (checking) => {
				const ok = this.getPdfsForActiveNote().pdfs.length > 0;
				if (ok && !checking) this.openSearch();
				return ok;
			},
		});

		this.addSettingTab(new PdfSearchSettingTab(this.app, this));

		const invalidate = (f: TAbstractFile, oldPath?: string) => {
			this.cache.delete(f.path);
			if (oldPath) this.cache.delete(oldPath);
		};
		this.registerEvent(this.app.vault.on("modify", (f) => invalidate(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => invalidate(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => invalidate(f, old)));
	}

	onunload() {
		this.cache.clear();
	}

	/** PDFs embedded (![[x.pdf]]) or linked ([[x.pdf]], [x](x.pdf)) in the active note, in order of appearance. */
	getPdfsForActiveNote(): { note: TFile | null; pdfs: TFile[] } {
		const note = this.app.workspace.getActiveFile();
		if (!note) return { note: null, pdfs: [] };
		if (note.extension.toLowerCase() === "pdf") return { note, pdfs: [note] };

		const fc = this.app.metadataCache.getFileCache(note);
		const refs = [...(fc?.embeds ?? []), ...(fc?.links ?? [])].sort(
			(a, b) => a.position.start.offset - b.position.start.offset,
		);
		const found = new Map<string, TFile>();
		for (const ref of refs) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(ref.link), note.path);
			if (dest && dest.extension.toLowerCase() === "pdf") found.set(dest.path, dest);
		}
		for (const fl of fc?.frontmatterLinks ?? []) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(fl.link), note.path);
			if (dest && dest.extension.toLowerCase() === "pdf") found.set(dest.path, dest);
		}
		return { note, pdfs: [...found.values()] };
	}

	openSearch() {
		const { note, pdfs } = this.getPdfsForActiveNote();
		if (!note) {
			new Notice("Open a note first.");
			return;
		}
		if (pdfs.length === 0) {
			new Notice("This note has no linked or embedded PDF files.");
			return;
		}
		if (note.path !== this.lastNotePath) {
			this.lastQuery = "";
			this.lastNotePath = note.path;
		}
		new PdfSearchModal(this.app, this, note, pdfs).open();
	}

	/** Extract (and cache) the text of every page. Uses Obsidian's bundled pdf.js, which works on mobile. */
	getIndex(file: TFile, onProgress?: Progress): Promise<PdfIndex> {
		const cached = this.cache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
			return Promise.resolve(cached);
		}
		const running = this.pending.get(file.path);
		if (running) return running;

		const job = (async () => {
			const pdfjs = await loadPdfJs();
			const data = await this.app.vault.readBinary(file);
			const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
			const pages: PageText[] = [];
			try {
				const total: number = doc.numPages;
				for (let i = 1; i <= total; i++) {
					const page = await doc.getPage(i);
					// disableNormalization matches how the PDF viewer's text layer reads the page,
					// so item indices and offsets line up for highlighting.
					const content = await page.getTextContent({ disableNormalization: true });
					let text = "";
					const itemStarts: number[] = [];
					const itemLens: number[] = [];
					for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
						if (typeof item.str !== "string") continue;
						itemStarts.push(text.length);
						itemLens.push(item.str.length);
						text += item.str;
						if (item.hasEOL) text += "\n";
					}
					pages.push({ page: i, text, itemStarts, itemLens });
					page.cleanup();
					onProgress?.(file, i, total);
				}
			} finally {
				await doc.destroy();
			}
			const index: PdfIndex = { mtime: file.stat.mtime, size: file.stat.size, pages };
			this.cache.set(file.path, index);
			return index;
		})();

		this.pending.set(file.path, job);
		job.finally(() => this.pending.delete(file.path)).catch(() => {});
		return job;
	}

	async openResult(file: TFile, page: number, sourcePath: string, selection: string | null) {
		const subpath = `#page=${page}` + (selection && this.settings.highlightInPdf ? `&selection=${selection}` : "");
		// Reuse a tab that already shows this PDF.
		let existing: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const vf = (leaf.view as { file?: TFile }).file;
			if (!existing && leaf.view.getViewType() === "pdf" && vf?.path === file.path) existing = leaf;
		});
		if (existing) {
			const leaf = existing as WorkspaceLeaf;
			await leaf.openFile(file, { active: true, eState: { subpath } });
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
			return;
		}
		const newTab = this.settings.openInNewTab && !Platform.isMobile ? "tab" : false;
		await this.app.workspace.openLinkText(file.path + subpath, sourcePath, newTab);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

const ALL = "__all__";

class PdfSearchModal extends Modal {
	private inputEl!: HTMLInputElement;
	private scopeEl: HTMLSelectElement | null = null;
	private statusEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private indexes = new Map<string, PdfIndex>();
	private failed = new Map<string, string>();
	private progress = new Map<string, string>();
	private searchToken = 0;

	constructor(
		app: App,
		private plugin: PdfSearchPlugin,
		private note: TFile,
		private pdfs: TFile[],
	) {
		super(app);
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.addClass("pdf-search-modal");
		this.setTitle?.(this.pdfs.length === 1 ? `Search in ${this.pdfs[0].basename}` : "Search PDFs in this note");

		if (this.pdfs.length > 1) {
			this.scopeEl = contentEl.createEl("select", { cls: "dropdown pdf-search-scope" });
			this.scopeEl.createEl("option", { value: ALL, text: `All ${this.pdfs.length} PDFs in this note` });
			for (const f of this.pdfs) this.scopeEl.createEl("option", { value: f.path, text: f.basename });
			this.scopeEl.addEventListener("change", () => this.runSearch());
		}

		this.inputEl = contentEl.createEl("input", {
			type: "search",
			cls: "pdf-search-input",
			attr: { placeholder: "Type to search…", enterkeyhint: "search", autocapitalize: "off" },
		});
		this.inputEl.value = this.plugin.lastQuery;
		const debounced = debounce(() => this.runSearch(), 250, true);
		this.inputEl.addEventListener("input", () => {
			this.plugin.lastQuery = this.inputEl.value;
			debounced();
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const first = this.resultsEl.querySelector<HTMLElement>(".pdf-search-result");
				if (first) first.click();
			}
		});

		this.statusEl = contentEl.createDiv({ cls: "pdf-search-status" });
		this.resultsEl = contentEl.createDiv({ cls: "pdf-search-results" });

		window.setTimeout(() => {
			this.inputEl.focus();
			this.inputEl.select();
		}, 50);

		this.indexAll();
		this.runSearch();
	}

	onClose() {
		this.searchToken++;
		this.contentEl.empty();
	}

	private selectedPdfs(): TFile[] {
		const v = this.scopeEl?.value ?? ALL;
		return v === ALL ? this.pdfs : this.pdfs.filter((f) => f.path === v);
	}

	private async indexAll() {
		for (const f of this.pdfs) {
			try {
				const idx = await this.plugin.getIndex(f, (file, done, total) => {
					this.progress.set(file.path, `${done}/${total}`);
					this.renderStatus();
				});
				this.indexes.set(f.path, idx);
			} catch (err) {
				console.error("PDF Search: could not read", f.path, err);
				this.failed.set(f.path, err instanceof Error ? err.message : String(err));
			}
			this.progress.delete(f.path);
			this.runSearch();
		}
	}

	private lastSummary = "";

	private renderStatus() {
		const parts: string[] = [];
		for (const f of this.selectedPdfs()) {
			const p = this.progress.get(f.path);
			if (p) parts.push(`Reading ${f.basename}… page ${p}`);
			else if (!this.indexes.has(f.path) && !this.failed.has(f.path)) parts.push(`Waiting to read ${f.basename}…`);
		}
		this.statusEl.setText([this.lastSummary, ...parts].filter(Boolean).join(" · "));
	}

	private runSearch() {
		const token = ++this.searchToken;
		const query = this.inputEl.value;
		const { ignoreWhitespace, maxResults, snippetContext } = this.plugin.settings;
		this.resultsEl.empty();

		const files = this.selectedPdfs();
		for (const f of files) {
			const reason = this.failed.get(f.path);
			if (reason) this.resultsEl.createDiv({ cls: "pdf-search-warning", text: `Could not read ${f.basename}: ${reason}` });
			const idx = this.indexes.get(f.path);
			if (idx && idx.pages.every((p) => !p.text.trim())) {
				this.resultsEl.createDiv({
					cls: "pdf-search-warning",
					text: `${f.basename} has no searchable text (probably a scanned image). Run OCR on it first.`,
				});
			}
		}

		if (!query.trim()) {
			this.lastSummary = "";
			this.renderStatus();
			return;
		}

		let total = 0;
		let pagesHit = 0;
		let truncated = false;
		for (const f of files) {
			if (token !== this.searchToken) return;
			const idx = this.indexes.get(f.path);
			if (!idx) continue;
			const remaining = maxResults - total;
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			const matches = findMatches(idx.pages, query, ignoreWhitespace, remaining);
			if (matches.length === remaining) truncated = true;
			if (!matches.length) continue;
			total += matches.length;
			pagesHit += new Set(matches.map((m) => m.page)).size;
			this.renderGroup(f, idx, matches, snippetContext, files.length > 1);
		}

		const n = (x: number, w: string) => `${x} ${w}${x === 1 ? "" : "s"}`;
		this.lastSummary = total
			? `${n(total, "match")} on ${n(pagesHit, "page")}${truncated ? " (showing first " + maxResults + ")" : ""}`
			: this.indexes.size
				? "No matches"
				: "";
		this.renderStatus();
	}

	private renderGroup(file: TFile, idx: PdfIndex, matches: Match[], context: number, showHeader: boolean) {
		const group = this.resultsEl.createDiv({ cls: "pdf-search-group" });
		if (showHeader) group.createDiv({ cls: "pdf-search-group-title", text: `${file.basename} (${matches.length})` });
		const byPage = new Map(idx.pages.map((p) => [p.page, p.text]));
		for (const m of matches) {
			const text = byPage.get(m.page) ?? "";
			const s = makeSnippet(text, m.start, m.end, context);
			const row = group.createDiv({ cls: "pdf-search-result", attr: { tabindex: "0", role: "button" } });
			row.createSpan({ cls: "pdf-search-page", text: `p. ${m.page}` });
			const snip = row.createSpan({ cls: "pdf-search-snippet" });
			snip.appendText(s.before);
			snip.createEl("mark", { text: s.match });
			snip.appendText(s.after);
			const open = () => {
				this.close();
				const pageText = idx.pages.find((p) => p.page === m.page);
				const selection = pageText ? toSelection(pageText, m.start, m.end) : null;
				this.plugin.openResult(file, m.page, this.note.path, selection);
			};
			row.addEventListener("click", open);
			row.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			});
		}
	}
}

class PdfSearchSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PdfSearchPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Ignore spaces and line breaks")
			.setDesc(
				"Recommended. Finds phrases even when the PDF breaks them across lines, and handles Chinese text with stray spaces. Turn off to match spacing exactly.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.ignoreWhitespace).onChange(async (v) => {
					this.plugin.settings.ignoreWhitespace = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Maximum results")
			.setDesc("Stop after this many matches.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.maxResults)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n > 0) {
						this.plugin.settings.maxResults = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Snippet length")
			.setDesc("Characters of context shown on each side of a match.")
			.addSlider((s) =>
				s
					.setLimits(10, 150, 10)
					.setValue(this.plugin.settings.snippetContext)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.snippetContext = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Highlight the match in the PDF")
			.setDesc("When you open a result, select the matched words on the page.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.highlightInPdf).onChange(async (v) => {
					this.plugin.settings.highlightInPdf = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Open results in a new tab (desktop)")
			.setDesc("On mobile, results always open in the current tab. Use Back to return to your note.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.openInNewTab).onChange(async (v) => {
					this.plugin.settings.openInNewTab = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}
