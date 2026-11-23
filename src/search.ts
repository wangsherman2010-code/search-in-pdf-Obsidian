/**
 * Pure text-matching logic, kept free of Obsidian imports so it can be unit-tested.
 */

export interface PageText {
	/** 1-based page number */
	page: number;
	text: string;
}

export interface Match {
	page: number;
	/** start offset in the original page text */
	start: number;
	/** end offset (exclusive) in the original page text */
	end: number;
}

interface Normalized {
	norm: string;
	/** map[i] = index in the original text of norm[i] */
	map: number[];
}

const WS = /\s/;

/**
 * Lower-cases the text and either removes all whitespace (ignoreWhitespace)
 * or collapses whitespace runs to a single space. Keeps a map back to the
 * original offsets so matches can be highlighted in the original text.
 *
 * Removing whitespace makes search robust to PDF line breaks, hyphen-free
 * word wraps and Chinese/Japanese text where pdf.js inserts stray spaces.
 */
export function normalize(text: string, ignoreWhitespace: boolean): Normalized {
	const out: string[] = [];
	const map: number[] = [];
	let lastWasSpace = true; // trims leading whitespace in collapse mode
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (WS.test(ch)) {
			if (!ignoreWhitespace && !lastWasSpace) {
				out.push(" ");
				map.push(i);
				lastWasSpace = true;
			}
			continue;
		}
		lastWasSpace = false;
		// NFKC folds ligatures (ﬁ → fi) and full-width forms so they match plain typing.
		const lc = ch.normalize("NFKC").toLowerCase();
		for (let j = 0; j < lc.length; j++) {
			out.push(lc[j]);
			map.push(i);
		}
	}
	// trim trailing space in collapse mode
	if (out.length && out[out.length - 1] === " ") {
		out.pop();
		map.pop();
	}
	return { norm: out.join(""), map };
}

export function normalizeQuery(query: string, ignoreWhitespace: boolean): string {
	return normalize(query, ignoreWhitespace).norm;
}

/** Find all (non-overlapping) matches of the query across the given pages. */
export function findMatches(
	pages: PageText[],
	query: string,
	ignoreWhitespace: boolean,
	limit = Infinity,
): Match[] {
	const q = normalizeQuery(query, ignoreWhitespace);
	const results: Match[] = [];
	if (!q) return results;
	for (const p of pages) {
		const { norm, map } = normalize(p.text, ignoreWhitespace);
		let from = 0;
		while (from <= norm.length - q.length) {
			const idx = norm.indexOf(q, from);
			if (idx === -1) break;
			results.push({
				page: p.page,
				start: map[idx],
				end: map[idx + q.length - 1] + 1,
			});
			if (results.length >= limit) return results;
			from = idx + q.length;
		}
	}
	return results;
}

export interface Snippet {
	before: string;
	match: string;
	after: string;
}

/** Cut a short, single-line snippet around a match. */
export function makeSnippet(text: string, start: number, end: number, context: number): Snippet {
	const flat = (s: string) => s.replace(/\s+/g, " ");
	const from = Math.max(0, start - context);
	const to = Math.min(text.length, end + context);
	return {
		before: (from > 0 ? "…" : "") + flat(text.slice(from, start)).trimStart(),
		match: flat(text.slice(start, end)),
		after: flat(text.slice(end, to)).trimEnd() + (to < text.length ? "…" : ""),
	};
}


/**
 * Fingerprint of a file's bytes (two independent 32-bit hashes plus the size).
 * Used to name saved text, so the same PDF matches on every device and after
 * renames, and an edited PDF gets a new fingerprint. Not for security.
 */
export function fingerprint(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let h1 = 0x811c9dc5; // FNV-1a
	let h2 = 0x9e3779b9; // a second, differently mixed hash
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		h1 = Math.imul(h1 ^ b, 0x01000193);
		h2 = Math.imul(h2 ^ b, 0x5bd1e995);
		h2 ^= h2 >>> 15;
	}
	const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
	return `${hex(h1)}${hex(h2)}-${bytes.length.toString(16)}`;
}
