/**
 * Pure text-matching logic, kept free of Obsidian imports so it can be unit-tested.
 */

export interface PageText {
	/** 1-based page number */
	page: number;
	text: string;
	/**
	 * Where each pdf.js text item starts in `text`, and its length. Used to turn a
	 * match into Obsidian's `#page=N&selection=a,b,c,d` link, which highlights the
	 * words in the PDF viewer. Items are counted the same way as the viewer's text
	 * layer counts them.
	 */
	itemStarts?: number[];
	itemLens?: number[];
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

/** Index of the text item that contains `offset`, or -1 if it falls between items. */
function itemAt(starts: number[], lens: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (offset < starts[mid]) hi = mid - 1;
		else if (offset >= starts[mid] + lens[mid]) lo = mid + 1;
		else return mid;
	}
	return -1;
}

/**
 * Convert a match to the `selection=startItem,startOffset,endItem,endOffset`
 * value that Obsidian's PDF viewer uses to highlight text. Returns null when the
 * page has no item information.
 */
export function toSelection(page: PageText, start: number, end: number): string | null {
	const starts = page.itemStarts;
	const lens = page.itemLens;
	if (!starts || !lens || !starts.length || end <= start) return null;
	// Move inwards past characters we added ourselves (line breaks between items).
	let s = start;
	while (s < end && itemAt(starts, lens, s) === -1) s++;
	let e = end - 1;
	while (e >= s && itemAt(starts, lens, e) === -1) e--;
	if (s > e) return null;
	const si = itemAt(starts, lens, s);
	const ei = itemAt(starts, lens, e);
	return `${si},${s - starts[si]},${ei},${e - starts[ei] + 1}`;
}
