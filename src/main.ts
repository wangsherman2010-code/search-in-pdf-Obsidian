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
	ItemView,
	View,
	setIcon,
	getLinkpath,
	loadPdfJs,
} from "obsidian";
import { Match, PageText, findMatches, fingerprint, makeSnippet } from "./search";
import { TextStore } from "./store";
import { clearHighlights, highlightWhenReady, keepHighlight } from "./highlight";

interface PdfSearchSettings {
	ignoreWhitespace: boolean;
	maxResults: number;
	snippetContext: number;
	openInNewTab: boolean;
	highlightInPdf: boolean;
	navAtTop: boolean;
	hideMobileSearchButton: boolean;
	showHeaderButton: boolean;
	saveExtractedText: boolean;
}

const DEFAULT_SETTINGS: PdfSearchSettings = {
	ignoreWhitespace: true,
	maxResults: 300,
	snippetContext: 50,
	openInNewTab: true,
	highlightInPdf: true,
	navAtTop: false,
	hideMobileSearchButton: false,
	showHeaderButton: true,
	saveExtractedText: true,
};

interface PdfIndex {
	mtime: number;
	size: number;
	pages: PageText[];
}

type Progress = (file: TFile, done: number, total: number) => void;

/** One search result, in the order shown in the results list. */
interface ResultRef {
	file: TFile;
	page: number;
	/** which match on its page this is (0 = first) */
	occurrence: number;
}

/** The result list you are stepping through with the Previous / Next bar. */
interface NavState {
	results: ResultRef[];
	index: number;
	query: string;
	note: TFile;
	pdfs: TFile[];
}

export default class PdfSearchPlugin extends Plugin {
	settings: PdfSearchSettings = DEFAULT_SETTINGS;
	private cache = new Map<string, PdfIndex>();
	private pending = new Map<string, Promise<PdfIndex>>();
	/** remembered so re-opening the search after jumping to a page keeps your results */
	lastQuery = "";
	lastNotePath = "";
	nav: NavState | null = null;
	private highlightToken = 0;
	store!: TextStore;
	/** stops re-drawing the current highlight after zoom; null when nothing is kept */
	private stopKeeping: (() => void) | null = null;
	private keptFilePath = "";

	async onload() {
		await this.loadSettings();
		this.store = new TextStore(this.app.vault.adapter, `${this.manifest.dir ?? this.app.vault.configDir + "/plugins/" + this.manifest.id}/saved-text`);
		this.applyBodyClasses();

		this.addRibbonIcon("file-search", "Search PDFs in this note", () => this.openSearch());

		// "Search PDFs in this note" in the tab's ⋮ menu and the file's right-click menu.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || this.getPdfsFor(file).pdfs.length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle("Search PDFs in this note")
						.setIcon("file-search")
						.setSection("action")
						.onClick(() => this.openSearch(file)),
				);
			}),
		);

		// A button in the top-right of the tab, shown when the note has PDFs.
		const refresh = () => this.refreshHeaderButtons();
		this.app.workspace.onLayoutReady(refresh);
		this.registerEvent(this.app.workspace.on("layout-change", refresh));
		this.registerEvent(this.app.workspace.on("active-leaf-change", refresh));
		this.registerEvent(this.app.workspace.on("file-open", refresh));
		this.registerEvent(this.app.metadataCache.on("resolved", refresh));

		this.addCommand({
			id: "search-pdfs-in-note",
			name: "Search PDFs in current note",
			checkCallback: (checking) => {
				const ok = this.getPdfsForActiveNote().pdfs.length > 0;
				if (ok && !checking) this.openSearch();
				return ok;
			},
		});

		this.addCommand({
			id: "next-match",
			name: "Go to next match",
			checkCallback: (checking) => {
				if (!this.nav) return false;
				if (!checking) this.goToResult(this.nav.index + 1);
				return true;
			},
		});

		this.addCommand({
			id: "previous-match",
			name: "Go to previous match",
			checkCallback: (checking) => {
				if (!this.nav) return false;
				if (!checking) this.goToResult(this.nav.index - 1);
				return true;
			},
		});

		this.addCommand({
			id: "copy-bottom-bar-info",
			name: "Troubleshooting: copy bottom bar details",
			callback: () => this.copyBottomBarInfo(),
		});

		this.addSettingTab(new PdfSearchSettingTab(this.app, this));

		// Re-check the bottom bar whenever the layout changes, in case Obsidian rebuilt it.
		this.app.workspace.onLayoutReady(() => this.hideNavbarSearchButtons());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.hideNavbarSearchButtons()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.hideNavbarSearchButtons()));

		// Hide the Previous / Next bar when you leave the PDFs you were searching.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				// Stop re-drawing the highlight once another file is shown.
				if (this.keptFilePath && file?.path !== this.keptFilePath) this.stopKeepingHighlight();
				if (!this.nav) return;
				if (!file || !this.nav.results.some((r) => r.file.path === file.path)) this.removeNavBars();
			}),
		);

		const invalidate = (f: TAbstractFile, oldPath?: string) => {
			this.cache.delete(f.path);
			if (oldPath) this.cache.delete(oldPath);
		};
		this.registerEvent(this.app.vault.on("modify", (f) => invalidate(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => invalidate(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => invalidate(f, old)));
	}

	onunload() {
		this.removeHeaderButtons();
		document.body.removeClass(HIDE_SEARCH_CLASS);
		document.querySelectorAll("." + HIDDEN_BTN_CLASS).forEach((el) => el.removeClass(HIDDEN_BTN_CLASS));
		this.cache.clear();
		this.removeNavBars();
		this.stopKeepingHighlight();
		document.querySelectorAll(".pdf-search-hit-layer").forEach((el) => el.remove());
	}

	/** PDFs embedded (![[x.pdf]]) or linked ([[x.pdf]], [x](x.pdf)) in the active note, in order of appearance. */
	getPdfsForActiveNote(): { note: TFile | null; pdfs: TFile[] } {
		return this.getPdfsFor(this.app.workspace.getActiveFile());
	}

	/** PDFs embedded or linked in `note` (or the note itself if it is a PDF). */
	getPdfsFor(note: TFile | null): { note: TFile | null; pdfs: TFile[] } {
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

	private headerButtons = new Map<View, { el: HTMLElement; path: string }>();

	/** Add or remove the header 🔍 button on each open note / PDF tab. */
	refreshHeaderButtons() {
		const seen = new Set<View>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			const type = view.getViewType();
			if (type !== "markdown" && type !== "pdf") return;
			seen.add(view);
			const file = (view as { file?: TFile | null }).file ?? null;
			const want = this.settings.showHeaderButton && !!file && this.getPdfsFor(file).pdfs.length > 0;
			const have = this.headerButtons.get(view);
			if (have && (!want || have.path !== file?.path || !have.el.isConnected)) {
				have.el.remove();
				this.headerButtons.delete(view);
			}
			if (want && file && !this.headerButtons.has(view)) {
				const el = (view as ItemView).addAction("file-search", "Search PDFs in this note", () => {
					const f = (view as { file?: TFile | null }).file;
					if (f) this.openSearch(f);
				});
				el.addClass("pdf-search-header-btn");
				this.headerButtons.set(view, { el, path: file.path });
			}
		});
		for (const [view, b] of this.headerButtons) {
			if (!seen.has(view)) {
				b.el.remove();
				this.headerButtons.delete(view);
			}
		}
	}

	removeHeaderButtons() {
		for (const b of this.headerButtons.values()) b.el.remove();
		this.headerButtons.clear();
	}

	openSearch(file?: TFile) {
		const { note, pdfs } = file ? this.getPdfsFor(file) : this.getPdfsForActiveNote();
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
			const data = await this.app.vault.readBinary(file);
			const key = fingerprint(data);
			if (this.settings.saveExtractedText) {
				const saved = await this.store.load(key);
				if (saved) {
					const index: PdfIndex = { mtime: file.stat.mtime, size: file.stat.size, pages: saved };
					this.cache.set(file.path, index);
					return index;
				}
			}
			const pdfjs = await loadPdfJs();
			const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
			const pages: PageText[] = [];
			try {
				const total: number = doc.numPages;
				for (let i = 1; i <= total; i++) {
					const page = await doc.getPage(i);
					// disableNormalization reads the text the same way the PDF viewer's text layer does.
					const content = await page.getTextContent({ disableNormalization: true });
					let text = "";
					for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
						if (typeof item.str !== "string") continue;
						text += item.str;
						if (item.hasEOL) text += "\n";
					}
					pages.push({ page: i, text });
					page.cleanup();
					onProgress?.(file, i, total);
				}
			} finally {
				await doc.destroy();
			}
			const index: PdfIndex = { mtime: file.stat.mtime, size: file.stat.size, pages };
			this.cache.set(file.path, index);
			if (this.settings.saveExtractedText) await this.store.save(key, file.path, file.stat.size, pages);
			return index;
		})();

		this.pending.set(file.path, job);
		job.finally(() => this.pending.delete(file.path)).catch(() => {});
		return job;
	}

	/** Start stepping through `results` from `index` (called when you tap a result). */
	startNavigation(results: ResultRef[], index: number, query: string, note: TFile, pdfs: TFile[]) {
		this.nav = { results, index, query, note, pdfs };
		return this.goToResult(index);
	}

	/** Open result `i` of the current list. Wraps around at either end. */
	async goToResult(i: number) {
		const nav = this.nav;
		if (!nav || !nav.results.length) return;
		const n = nav.results.length;
		nav.index = ((i % n) + n) % n;
		const r = nav.results[nav.index];
		await this.openResult(r.file, r.page, nav.note.path, nav.query, r.occurrence);
	}

	/** Open the PDF at `page`, then highlight the `occurrence`-th match of `query` on that page. */
	async openResult(file: TFile, page: number, sourcePath: string, query: string, occurrence: number) {
		const token = ++this.highlightToken;
		this.stopKeepingHighlight();
		const subpath = `#page=${page}`;
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
		} else {
			const newTab = this.settings.openInNewTab && !Platform.isMobile ? "tab" : false;
			await this.app.workspace.openLinkText(file.path + subpath, sourcePath, newTab);
		}
		const pdfLeaf = this.findPdfLeaf(file);
		if (!pdfLeaf) return;
		if (this.nav) this.showNavBar(pdfLeaf);
		if (!this.settings.highlightInPdf) return;

		const ok = await highlightWhenReady(
			pdfLeaf.view.containerEl,
			page,
			query,
			occurrence,
			8000,
			() => token === this.highlightToken,
		);
		if (!ok) {
			console.debug("PDF Search: could not find the match in the rendered page to highlight");
			return;
		}
		if (token !== this.highlightToken) return;
		this.stopKeeping = keepHighlight(pdfLeaf.view.containerEl, page, query, occurrence);
		this.keptFilePath = file.path;
	}

	stopKeepingHighlight() {
		this.stopKeeping?.();
		this.stopKeeping = null;
		this.keptFilePath = "";
	}

	removeNavBars() {
		document.querySelectorAll(".pdf-search-nav").forEach((el) => el.remove());
	}

	/** Floating "◀ 3 / 12 ▶" bar over the PDF. */
	private showNavBar(leaf: WorkspaceLeaf) {
		this.removeNavBars();
		const nav = this.nav;
		if (!nav) return;
		const host = leaf.view.containerEl;
		host.addClass("pdf-search-nav-host");
		const bar = host.createDiv({ cls: "pdf-search-nav" });
		const button = (icon: string, label: string, onClick: () => void) => {
			const b = bar.createEl("button", { cls: "clickable-icon pdf-search-nav-btn", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				onClick();
			});
		};
		const current = nav.results[nav.index];
		const manyPdfs = new Set(nav.results.map((r) => r.file.path)).size > 1;

		button("chevron-left", "Previous match", () => this.goToResult(nav.index - 1));
		const label = bar.createDiv({ cls: "pdf-search-nav-label" });
		label.createDiv({ cls: "pdf-search-nav-count", text: `${nav.index + 1} / ${nav.results.length}` });
		label.createDiv({
			cls: "pdf-search-nav-where",
			text: (manyPdfs ? current.file.basename + " · " : "") + `p. ${current.page}`,
		});
		button("chevron-right", "Next match", () => this.goToResult(nav.index + 1));
		button("list", "Back to search results", () => {
			new PdfSearchModal(this.app, this, nav.note, nav.pdfs).open();
		});
		button("x", "Close", () => {
			this.nav = null;
			this.removeNavBars();
			this.stopKeepingHighlight();
			clearHighlights(host);
		});

		// On phones, Obsidian's bottom toolbar floats over the bottom of the view,
		// so put the bar at the top, just under the PDF viewer's own toolbar.
		if (Platform.isMobile || this.settings.navAtTop) {
			bar.addClass("is-top");
			const place = () => {
				if (!bar.isConnected) return;
				const hostTop = host.getBoundingClientRect().top;
				const anchor =
					host.querySelector(".pdf-toolbar") ?? host.querySelector(".view-header") ?? null;
				const below = anchor ? anchor.getBoundingClientRect().bottom - hostTop : 0;
				bar.style.top = Math.max(0, below) + 8 + "px";
			};
			place();
			// The PDF toolbar may not have been laid out yet right after opening.
			window.setTimeout(place, 300);
			window.setTimeout(place, 1200);
		}
	}

	/** The leaf showing this PDF, preferring the active one. */
	private findPdfLeaf(file: TFile): WorkspaceLeaf | null {
		const isIt = (leaf: WorkspaceLeaf | null) =>
			!!leaf && leaf.view.getViewType() === "pdf" && (leaf.view as { file?: TFile }).file?.path === file.path;
		const active = this.app.workspace.getMostRecentLeaf();
		if (isIt(active)) return active;
		let found: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && isIt(leaf)) found = leaf;
		});
		return found;
	}

	/** Turn on or off hiding Obsidian's search button in the mobile bottom bar. */
	applyBodyClasses() {
		document.body.toggleClass(HIDE_SEARCH_CLASS, this.settings.hideMobileSearchButton);
		if (this.settings.hideMobileSearchButton) {
			this.hideNavbarSearchButtons();
			// Obsidian may build or rebuild the bar after the plugin loads.
			window.setTimeout(() => this.hideNavbarSearchButtons(), 500);
			window.setTimeout(() => this.hideNavbarSearchButtons(), 2000);
		} else {
			document.querySelectorAll("." + HIDDEN_BTN_CLASS).forEach((el) => el.removeClass(HIDDEN_BTN_CLASS));
		}
	}

	/** Magnifying-glass icons sitting in the bar along the bottom of the screen (not in dialogs or the PDF). */
	private bottomBarSearchIcons(): SVGElement[] {
		const h = window.innerHeight;
		const out: SVGElement[] = [];
		document.querySelectorAll<SVGElement>("svg").forEach((svg) => {
			const cls = svg.getAttribute("class") ?? "";
			if (!/(^|\s)(lucide-)?search(\s|$)/.test(cls)) return;
			if (svg.closest(".modal-container, .pdf-search-nav, .mobile-toolbar, .pdf-toolbar, .menu, .suggestion-container")) return;
			const r = svg.getBoundingClientRect();
			if (!r.width || r.top < h - 160) return;
			out.push(svg);
		});
		return out;
	}

	/** Hide Obsidian's search button in the mobile bottom bar, found by its icon and position. */
	hideNavbarSearchButtons() {
		if (!Platform.isMobile || !this.settings.hideMobileSearchButton) return;
		for (const svg of this.bottomBarSearchIcons()) {
			const btn = (svg.closest("button, .clickable-icon, [role='button'], .mobile-navbar-action") ??
				svg.parentElement) as HTMLElement | null;
			btn?.addClass(HIDDEN_BTN_CLASS);
		}
	}

	/** For troubleshooting: describe what is in the bottom bar and copy it to the clipboard. */
	async copyBottomBarInfo() {
		const h = window.innerHeight;
		const lines: string[] = [`v${this.manifest.version} mobile=${Platform.isMobile} h=${h} hide=${this.settings.hideMobileSearchButton}`];
		const describe = (el: Element | null) =>
			el ? `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").trim().replace(/\s+/g, ".")}` +
				(el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : "") : "";
		document.querySelectorAll<SVGElement>("svg").forEach((svg) => {
			const r = svg.getBoundingClientRect();
			if (!r.width || r.top < h - 160) return;
			const chain: string[] = [];
			let el: Element | null = svg;
			for (let i = 0; i < 4 && el; i++, el = el.parentElement) chain.push(describe(el));
			lines.push(chain.join(" < "));
		});
		const text = lines.join("\n");
		try {
			await navigator.clipboard.writeText(text);
			new Notice("Bottom bar details copied. Paste them to whoever is helping you.");
		} catch {
			new Notice(text, 15000);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

const ALL = "__all__";
const HIDE_SEARCH_CLASS = "pdf-search-hide-navbar-search";
const HIDDEN_BTN_CLASS = "pdf-search-hidden-navbar-btn";

class PdfSearchModal extends Modal {
	private inputEl!: HTMLInputElement;
	private scopeEl: HTMLSelectElement | null = null;
	private statusEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private indexes = new Map<string, PdfIndex>();
	private failed = new Map<string, string>();
	private progress = new Map<string, string>();
	private searchToken = 0;
	/** every result currently listed, in order, for Previous / Next */
	private results: ResultRef[] = [];

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
		this.results = [];

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
		const query = this.inputEl.value;
		const seenOnPage = new Map<number, number>();
		for (const m of matches) {
			// Which match on its page this is (0 = first), so the right one gets highlighted.
			const occurrence = seenOnPage.get(m.page) ?? 0;
			seenOnPage.set(m.page, occurrence + 1);
			const resultIndex = this.results.length;
			this.results.push({ file, page: m.page, occurrence });
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
				this.plugin.startNavigation(this.results.slice(), resultIndex, query, this.note, this.pdfs);
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
			.setName("Save extracted text")
			.setDesc(
				"Remember each PDF's text after the first search, so later searches start instantly, even after restarting Obsidian. If your vault's .obsidian folder syncs between devices, text read on one device is reused on the others.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.saveExtractedText).onChange(async (v) => {
					this.plugin.settings.saveExtractedText = v;
					await this.plugin.saveSettings();
				}),
			);

		const storeSetting = new Setting(containerEl).setName("Saved text").setDesc("Checking…");
		const refreshStats = async () => {
			const { count, bytes } = await this.plugin.store.stats();
			const mb = bytes / (1024 * 1024);
			storeSetting.setDesc(
				count
					? `${count} PDF${count === 1 ? "" : "s"} saved, ${mb < 0.1 ? "<0.1" : mb.toFixed(1)} MB. Clearing is safe: PDFs are simply read again next time.`
					: "Nothing saved yet.",
			);
		};
		storeSetting.addButton((b) =>
			b.setButtonText("Clear saved text").onClick(async () => {
				await this.plugin.store.clear();
				new Notice("Saved PDF text cleared.");
				refreshStats();
			}),
		);
		refreshStats();

		new Setting(containerEl)
			.setName("Show a search button in the note's header")
			.setDesc("Adds a 🔍 button at the top right of notes that contain PDFs.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showHeaderButton).onChange(async (v) => {
					this.plugin.settings.showHeaderButton = v;
					await this.plugin.saveSettings();
					this.plugin.refreshHeaderButtons();
				}),
			);

		new Setting(containerEl)
			.setName("Hide Obsidian's search button in the mobile bottom bar")
			.setDesc(
				"The magnifying glass in Obsidian's bottom bar on phones searches your vault, not the PDF. Turn this on to hide it. Has no effect on desktop.",
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.hideMobileSearchButton).onChange(async (v) => {
					this.plugin.settings.hideMobileSearchButton = v;
					this.plugin.applyBodyClasses();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Show the Previous / Next bar at the top (desktop)")
			.setDesc("On mobile it is always at the top, so Obsidian's bottom toolbar does not cover it.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.navAtTop).onChange(async (v) => {
					this.plugin.settings.navAtTop = v;
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
