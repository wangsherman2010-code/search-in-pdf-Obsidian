import { test } from "node:test";
import * as assert from "node:assert/strict";
import { findMatches, makeSnippet, fingerprint } from "./search";

const pages = [
	{ page: 1, text: "Assertiveness is a\nskill you can learn." },
	{ page: 2, text: "Critical thinking: ASSERTIVENESS and clarity. Assertive-\nness again." },
	{ page: 3, text: "批判 性 思维\n是一种能力" },
];

test("case-insensitive, across line breaks", () => {
	const m = findMatches(pages, "a skill", true);
	assert.equal(m.length, 1);
	assert.equal(m[0].page, 1);
	assert.equal(pages[0].text.slice(m[0].start, m[0].end), "a\nskill");
});

test("finds every occurrence with page numbers", () => {
	const m = findMatches(pages, "assertiveness", true);
	assert.deepEqual(m.map((x) => x.page), [1, 2]);
});

test("Chinese text with stray spaces from PDF extraction", () => {
	const m = findMatches(pages, "批判性思维", true);
	assert.equal(m.length, 1);
	assert.equal(m[0].page, 3);
	assert.equal(pages[2].text.slice(m[0].start, m[0].end), "批判 性 思维");
});

test("exact-spacing mode does not join words", () => {
	assert.equal(findMatches(pages, "批判性思维", false).length, 0);
	assert.equal(findMatches(pages, "a   skill", false).length, 1);
});

test("limit and empty query", () => {
	assert.equal(findMatches(pages, "a", true, 3).length, 3);
	assert.equal(findMatches(pages, "   ", true).length, 0);
});

test("snippet", () => {
	const t = pages[0].text;
	const [m] = findMatches(pages, "skill", true);
	const s = makeSnippet(t, m.start, m.end, 5);
	assert.deepEqual(s, { before: "…is a ", match: "skill", after: " you…" });
});

test("ligatures match plain letters", () => {
	const m = findMatches([{ page: 1, text: "ﬁnd the ﬁle" }], "file", true);
	assert.equal(m.length, 1);
});


test("fingerprint is stable and changes with content", () => {
	const enc = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer;
	assert.equal(fingerprint(enc("same pdf bytes")), fingerprint(enc("same pdf bytes")));
	assert.notEqual(fingerprint(enc("same pdf bytes")), fingerprint(enc("same pdf bytez")));
	assert.match(fingerprint(enc("abc")), /^[0-9a-f]{16}-3$/);
});
