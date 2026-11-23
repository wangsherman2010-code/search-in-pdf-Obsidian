/**
 * Finds Obsidian's own search button in the mobile bottom bar, without relying
 * on Obsidian's internal class names (which differ between versions).
 *
 * A button qualifies only if it:
 *  - shows a plain magnifying-glass icon,
 *  - sits within the bottom 160px of the screen,
 *  - is NOT inside a sidebar, dialog, menu, toolbar or our own UI, and
 *  - sits in a horizontal row with at least two other icon buttons (the bar).
 *    A vertical list, like the sidebar's Files / Search / Tags menu, never matches.
 *
 * No Obsidian imports, so it can be tested in a plain browser.
 */

/** Places where a search icon must never be hidden. */
export const PROTECTED =
	".workspace-drawer, .workspace-sidedock, .mod-left-split, .mod-right-split, .side-dock-ribbon, " +
	".workspace-tab-header-container, .view-header, .modal-container, .menu, .suggestion-container, " +
	".mobile-toolbar, .pdf-toolbar, .pdf-search-nav, .pdf-search-header-btn";

const ICON = /(^|\s)(lucide-)?search(\s|$)/;
const BUTTON = "button, .clickable-icon, [role='button'], .mobile-navbar-action";

function iconButton(svg: Element): HTMLElement | null {
	return (svg.closest(BUTTON) ?? svg.parentElement) as HTMLElement | null;
}

/** True if `btn` has at least `min` other visible icon buttons beside it on the same line. */
function inHorizontalRow(btn: HTMLElement, min: number): boolean {
	const row = btn.parentElement;
	if (!row) return false;
	const me = btn.getBoundingClientRect();
	let beside = 0;
	for (const sib of Array.from(row.children)) {
		if (sib === btn || !sib.querySelector("svg")) continue;
		const r = sib.getBoundingClientRect();
		if (!r.width) continue;
		const sameLine = Math.abs(r.top + r.height / 2 - (me.top + me.height / 2)) < me.height / 2;
		const apart = Math.abs(r.left - me.left) >= me.width / 2;
		if (sameLine && apart) beside++;
	}
	return beside >= min;
}

export function findBottomBarSearchButtons(doc: Document, viewportHeight: number): HTMLElement[] {
	const out: HTMLElement[] = [];
	doc.querySelectorAll("svg").forEach((svg) => {
		if (!ICON.test(svg.getAttribute("class") ?? "")) return;
		if (svg.closest(PROTECTED)) return;
		const r = svg.getBoundingClientRect();
		if (!r.width || r.top < viewportHeight - 160) return;
		const btn = iconButton(svg);
		if (btn && inHorizontalRow(btn, 2)) out.push(btn);
	});
	return out;
}
