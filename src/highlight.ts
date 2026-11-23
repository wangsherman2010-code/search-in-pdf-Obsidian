/**
 * Draws a highlight over a search match inside a rendered PDF page.
 *
 * Obsidian's PDF viewer is built on pdf.js, which renders an invisible
 * "text layer" (.textLayer) of positioned spans on top of each page canvas.
 * We find the match in that text, measure it with a DOM Range, and place
 * semi-transparent boxes over it. This does not depend on Obsidian's
 * `#selection=` links, so it behaves the same on desktop and mobile.
 *
 * No Obsidian imports here, so it can be tested against plain pdf.js.
 */
import { normalize, normalizeQuery } from "./search";

export const HIT_CLASS = "pdf-search-hit";
const LAYER_CLASS = "pdf-search-hit-layer";

interface TextMap {
	text: string;
	nodes: Text[];
	starts: number[];
}

function collectText(root: Element): TextMap {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	const starts: number[] = [];
	let text = "";
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const t = n as Text;
		nodes.push(t);
		starts.push(text.length);
		text += t.data;
	}
	return { text, nodes, starts };
}

function locate(map: TextMap, offset: number): { node: Text; offset: number } {
	let lo = 0;
	let hi = map.starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (map.starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { node: map.nodes[lo], offset: offset - map.starts[lo] };
}

/** Is the page's text layer rendered and filled in? */
export function textLayerReady(pageEl: Element): Element | null {
	const layer = pageEl.querySelector(".textLayer");
	if (!layer) return null;
	if (layer.querySelector(".endOfContent") || (layer.textContent ?? "").trim().length > 0) return layer;
	return null;
}

export function clearHighlights(container: Element) {
	container.querySelectorAll("." + HIT_CLASS).forEach((el) => el.remove());
}

/**
 * Highlight the `occurrence`-th (0-based) match of `query` on the page.
 * Falls back to the first match if there are fewer. Returns the first
 * highlight box, or null if the query was not found in the text layer.
 */
export function highlightInPage(pageEl: HTMLElement, query: string, occurrence: number): HTMLElement | null {
	const layer = textLayerReady(pageEl);
	if (!layer) return null;
	const map = collectText(layer);
	// Always ignore whitespace here: the text layer splits words into spans
	// differently from the extracted text, so spacing is not reliable.
	const { norm, map: idx } = normalize(map.text, true);
	const q = normalizeQuery(query, true);
	if (!q) return null;

	const found: number[] = [];
	for (let from = 0; ; ) {
		const i = norm.indexOf(q, from);
		if (i === -1) break;
		found.push(i);
		from = i + q.length;
	}
	if (!found.length) return null;
	const at = found[Math.min(occurrence, found.length - 1)];

	const start = locate(map, idx[at]);
	const end = locate(map, idx[at + q.length - 1]);
	const range = pageEl.ownerDocument.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset + 1);

	// Draw into our own layer that covers the page exactly like the text layer
	// does (inset 0 inside the page's border), and measure against that layer.
	// Measuring against the page itself would be off by the page border width.
	let hits = pageEl.querySelector<HTMLElement>(":scope > ." + LAYER_CLASS);
	if (!hits) {
		hits = pageEl.ownerDocument.createElement("div");
		hits.className = LAYER_CLASS;
		pageEl.appendChild(hits);
	}
	const base = hits.getBoundingClientRect();
	if (!base.width || !base.height) return null;
	let first: HTMLElement | null = null;
	for (const r of Array.from(range.getClientRects())) {
		if (r.width < 1 || r.height < 1) continue;
		const box = pageEl.ownerDocument.createElement("div");
		box.className = HIT_CLASS;
		// Percentages keep the box in place when the page is zoomed.
		box.style.left = ((r.left - base.left) / base.width) * 100 + "%";
		box.style.top = ((r.top - base.top) / base.height) * 100 + "%";
		box.style.width = (r.width / base.width) * 100 + "%";
		box.style.height = (r.height / base.height) * 100 + "%";
		hits.appendChild(box);
		first = first ?? box;
	}
	return first;
}

/**
 * Wait (polling) for the page to render inside `container`, then highlight.
 * Resolves true if a highlight was drawn.
 */
export function highlightWhenReady(
	container: HTMLElement,
	page: number,
	query: string,
	occurrence: number,
	timeoutMs = 8000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const tick = () => {
			const pageEl = container.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`);
			if (pageEl && textLayerReady(pageEl)) {
				clearHighlights(container);
				const box = highlightInPage(pageEl, query, occurrence);
				if (box) {
					box.scrollIntoView({ block: "center", inline: "nearest" });
					resolve(true);
					return;
				}
			}
			if (Date.now() > deadline) {
				resolve(false);
				return;
			}
			window.setTimeout(tick, 150);
		};
		tick();
	});
}
