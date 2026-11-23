/**
 * Saves extracted PDF text as small JSON files in the plugin's folder
 * (.obsidian/plugins/pdf-search-in-note/saved-text/), so a PDF only has to be
 * read once. Files are named by a fingerprint of the PDF's contents, so they
 * stay valid across devices (e.g. when the vault is synced), renames and moves.
 */
import { DataAdapter, normalizePath } from "obsidian";
import { PageText } from "./search";

const FORMAT = 1;

interface SavedFile {
	format: number;
	/** last known path, for information only */
	path: string;
	size: number;
	pages: string[];
}

export class TextStore {
	constructor(
		private adapter: DataAdapter,
		private dir: string,
	) {
		this.dir = normalizePath(dir);
	}

	private fileFor(key: string) {
		return normalizePath(`${this.dir}/${key}.json`);
	}

	async load(key: string): Promise<PageText[] | null> {
		const f = this.fileFor(key);
		try {
			if (!(await this.adapter.exists(f))) return null;
			const saved = JSON.parse(await this.adapter.read(f)) as SavedFile;
			if (saved.format !== FORMAT || !Array.isArray(saved.pages)) return null;
			return saved.pages.map((text, i) => ({ page: i + 1, text }));
		} catch (err) {
			console.warn("PDF Search: ignoring unreadable saved text", f, err);
			return null;
		}
	}

	async save(key: string, path: string, size: number, pages: PageText[]): Promise<void> {
		try {
			if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
			const data: SavedFile = { format: FORMAT, path, size, pages: pages.map((p) => p.text) };
			await this.adapter.write(this.fileFor(key), JSON.stringify(data));
		} catch (err) {
			// Saving is only a speed-up; searching still works without it.
			console.warn("PDF Search: could not save extracted text", err);
		}
	}

	/** How many PDFs have saved text, and how much space it takes. */
	async stats(): Promise<{ count: number; bytes: number }> {
		try {
			if (!(await this.adapter.exists(this.dir))) return { count: 0, bytes: 0 };
			const { files } = await this.adapter.list(this.dir);
			let bytes = 0;
			let count = 0;
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				count++;
				bytes += (await this.adapter.stat(f))?.size ?? 0;
			}
			return { count, bytes };
		} catch {
			return { count: 0, bytes: 0 };
		}
	}

	async clear(): Promise<void> {
		if (!(await this.adapter.exists(this.dir))) return;
		const { files } = await this.adapter.list(this.dir);
		for (const f of files) if (f.endsWith(".json")) await this.adapter.remove(f);
	}
}
