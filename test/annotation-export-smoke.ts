import assert from "node:assert/strict";
import { parseAnnotations, serializeAnnotations, type AnnotationDoc, type Highlight } from "../src/annotations";

const highlight: Highlight = {
  id: "quote1", page: 1, color: "#FBF719", text: "Original passage ".repeat(30) + "THE END",
  note: "My separate commentary", noteContentCJK: "中文补充", rects: [], created: "2026-09-07T00:00:00Z",
};
const doc: AnnotationDoc = { version: 1, pdf: 'Books/a "quoted" title.pdf', highlights: [highlight] };
const output = serializeAnnotations(doc, "Test book");
const prose = output.split("\n```json\n")[0];
assert.ok(prose.startsWith("---\nlpa-annotations: 1\npdf: \"Books/a "));
assert.ok(prose.includes(`${highlight.text}</mark>`), "readable quote is complete, not replaced or truncated");
assert.equal(prose.match(/My separate commentary/g)?.length, 1, "note appears once, separately");
assert.ok(prose.includes("  - 📝 My separate commentary\n  - 中文补充\n\n"));
assert.ok(prose.includes('background-color: #FBF719;'));
assert.deepEqual(parseAnnotations(output), doc, "readability changes preserve all machine data exactly");

for (const color of ["rgba(72, 158, 255, 0.42)", "#abc", "#11223344", "rgb(0, 25, 255)"]) {
  const result = serializeAnnotations({ ...doc, highlights: [{ ...highlight, color }] }, "Test");
  assert.ok(result.includes(`background-color: ${color};`), `preserve valid colour ${color}`);
}
for (const color of ['red; background: url(https://example.test/tracker)', '" onmouseover="alert(1)', "rgb(999, 0, 0)"]) {
  const result = serializeAnnotations({ ...doc, highlights: [{ ...highlight, color }] }, "Test").split("\n```json\n")[0];
  assert.ok(!result.includes("<mark"), "invalid colour cannot inject CSS/HTML");
}

const unsafe = { ...highlight, text: '<img src="x" onerror="alert(1)"> **literal** & [[link]]', note: "```json <script> [x](https://example.test)" };
const safeOutput = serializeAnnotations({ ...doc, highlights: [unsafe] }, "Test");
const safeProse = safeOutput.split("\n```json\n")[0];
assert.ok(!safeProse.includes("<img") && !safeProse.includes("<script>"));
assert.ok(!safeProse.includes("[[link]]") && !safeProse.includes("**literal**"));
assert.deepEqual(parseAnnotations(safeOutput)?.highlights, [unsafe]);

const tag = { ...highlight, id: "tag1", type: "tag" as const, text: "", note: "Standalone page note" };
const underline = { ...highlight, id: "under1", style: "underline" as const, text: "Underlined passage", note: undefined };
const mixed = serializeAnnotations({ ...doc, highlights: [tag, underline] }, "Test").split("\n```json\n")[0];
assert.equal(mixed.match(/Standalone page note/g)?.length, 1);
assert.ok(mixed.includes("_(underline)_") && !mixed.includes("<mark"));
assert.ok(serializeAnnotations({ ...doc, highlights: [] }, "Empty").includes("_No highlights yet._"));

console.log("annotation export smoke tests passed (full quote, separate notes, colours, escaping, round trip)");
