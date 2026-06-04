import { parseLegacyNote, targetBasename } from "../src/legacy-import";
import { buildDocIndex, anchorQuote } from "../src/anchor";
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const fs = require("fs"); const path = require("path");
const ROOT = "/Users/tianchenhao/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian";
function allPdfs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allPdfs(p, acc);
    else if (e.name.toLowerCase().endsWith(".pdf")) acc.push(p);
  }
  return acc;
}
const PDFS = allPdfs(ROOT);
const resolvePdf = (t?: string) => { const b = targetBasename(t); return b ? PDFS.find(p => path.basename(p).normalize("NFC").toLowerCase() === b) : undefined; };
async function run(noteRel: string) {
  const parsed = parseLegacyNote(fs.readFileSync(path.join(ROOT, noteRel), "utf8"));
  const pdf = resolvePdf(parsed.target);
  if (!pdf) { console.log(`=== ${noteRel}: PDF NOT FOUND`); return; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)), verbosity: 0 }).promise;
  const di = await buildDocIndex(doc);
  let matched = 0, crosspage = 0;
  const misses: string[] = [];
  for (const a of parsed.annotations) {
    const rs = anchorQuote(di, a.exact, a.prefix, a.suffix);
    if (rs.length) { matched++; if (rs.length > 1) crosspage++; }
    else misses.push(a.exact.slice(0, 30).replace(/\n/g, " "));
  }
  console.log(`=== ${noteRel}  matched ${matched}/${parsed.annotations.length}  (cross-page: ${crosspage})`);
  misses.forEach(m => console.log(`      miss: "${m}…"`));
  await doc.destroy();
}
(async () => {
  for (const n of ["读书批注A/意崇.md","文献批注/剑批史 Formalism to Poststructuralism v8.md","读书批注B/有限性之后.md","读书批注B/弗洛伊德.md"]) await run(n);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
