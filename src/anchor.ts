/**
 * anchor.ts — locate a text quote inside a rendered PDF and return its page(s) +
 * PDF-user-space rectangles. Used to migrate legacy obsidian-annotator
 * highlights, which store only quoted text (no coordinates).
 *
 * Approach mirrors hypothes.is text-quote anchoring: build a normalized,
 * whitespace-stripped search string with a char->(page,item,char) map, locate
 * the quote, then reconstruct line rectangles from the participating text items'
 * geometry. We index the whole document into one concatenated string so a
 * selection that spans a page boundary still matches (it is then split back into
 * one rect-set per page). Because the legacy `exact` strings came from a
 * different pdf.js version, long passages can diverge by a character or two
 * (ligatures, curly quotes, hyphenation), so we normalize aggressively and fall
 * back to a head+tail span match when a whole-string match fails.
 *
 * Geometry is emitted in PDF user space (origin bottom-left, y-up), identical to
 * viewport.convertToPdfPoint for live selections, so imported and manual
 * highlights render through one code path.
 */
import type { PdfRect } from "./annotations";

interface ItemBox {
  str: string;
  x: number; // baseline-left x in PDF user space (transform[4])
  y: number; // baseline y in PDF user space (transform[5])
  w: number; // advance width in PDF units
  h: number; // glyph height (font size) in PDF units
}

interface PageData {
  page: number; // 0-based
  items: ItemBox[];
}

interface GPos {
  page: number;
  item: number;
  ch: number;
}

export interface DocIndex {
  pages: PageData[];
  search: string; // normalized, whitespace-stripped text for the whole document
  map: GPos[]; // search index -> (page, item, char-in-item)
}

/** Per-character normalization. Returns "" to drop the char, or 1+ chars. */
function normChar(c: string): string {
  if (/\s/.test(c)) return "";
  const code = c.charCodeAt(0);
  if (code === 0x00ad || code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff)
    return "";
  if (c === "‘" || c === "’" || c === "‚" || c === "‛" || c === "ʼ") return "'";
  if (c === "“" || c === "”" || c === "„" || c === "‟" || c === "«" || c === "»") return '"';
  // Drop hyphens/dashes: line-break hyphenation differs between pdf.js versions.
  if (c === "-" || c === "‐" || c === "‑" || c === "–" || c === "—" || c === "‒" || c === "―" || c === "−")
    return "";
  return c.normalize("NFKC").toLowerCase();
}

function normStr(s: string): string {
  let out = "";
  for (const c of s) out += normChar(c);
  return out;
}

/** Build a whole-document index. `onProgress(done,total)` is optional. */
export async function buildDocIndex(
  pdfDoc: any,
  onProgress?: (done: number, total: number) => void
): Promise<DocIndex> {
  const total: number = pdfDoc.numPages;
  const pages: PageData[] = [];
  let search = "";
  const map: GPos[] = [];
  for (let p = 0; p < total; p++) {
    const page = await pdfDoc.getPage(p + 1);
    const tc = await page.getTextContent();
    const items: ItemBox[] = [];
    for (const it of tc.items) {
      if (typeof it.str !== "string") continue;
      const t = it.transform as number[];
      const itemIndex = items.length;
      items.push({ str: it.str, x: t[4], y: t[5], w: it.width, h: it.height });
      let ch = 0;
      for (const c of it.str) {
        const n = normChar(c);
        for (let k = 0; k < n.length; k++) {
          search += n[k];
          map.push({ page: p, item: itemIndex, ch });
        }
        ch += c.length;
      }
    }
    pages.push({ page: p, items });
    // NOTE: do NOT call page.cleanup() — these PDFPageProxy objects are shared
    // with the view (same document); cleaning them corrupts the view's cached
    // and in-flight canvas renders.
    if (onProgress) onProgress(p + 1, total);
  }
  return { pages, search, map };
}

function itemHRange(b: ItemBox, fromCh: number, toChInclusive: number): [number, number] {
  const len = b.str.length || 1;
  const f = Math.max(0, Math.min(1, fromCh / len));
  const t = Math.max(0, Math.min(1, (toChInclusive + 1) / len));
  return [b.x + f * b.w, b.x + t * b.w];
}

/** Reconstruct line rects (PDF space) for an item range within a single page. */
function rectsFromRange(
  items: ItemBox[],
  startItem: number,
  startCh: number,
  endItem: number,
  endCh: number
): PdfRect[] {
  const rects: PdfRect[] = [];
  let cur: { x1: number; x2: number; top: number; bottom: number; y: number; h: number } | null = null;
  const flush = () => {
    if (cur) rects.push({ x1: cur.x1, y1: cur.bottom, x2: cur.x2, y2: cur.top });
    cur = null;
  };
  for (let i = startItem; i <= endItem; i++) {
    const b = items[i];
    if (!b || !b.str) continue;
    const from = i === startItem ? startCh : 0;
    const to = i === endItem ? endCh : b.str.length - 1;
    const [x1, x2] = itemHRange(b, from, to);
    const top = b.y + b.h * 0.9;
    const bottom = b.y - b.h * 0.18;
    if (cur && Math.abs(b.y - cur.y) <= b.h * 0.6) {
      cur.x1 = Math.min(cur.x1, x1);
      cur.x2 = Math.max(cur.x2, x2);
      cur.top = Math.max(cur.top, top);
      cur.bottom = Math.min(cur.bottom, bottom);
    } else {
      flush();
      cur = { x1, x2, top, bottom, y: b.y, h: b.h };
    }
  }
  flush();
  return rects;
}

export interface AnchorResult {
  page: number;
  rects: PdfRect[];
}

/** Split a global match span [gStart,gEnd] into one rect-set per page covered. */
function resultsFromSpan(doc: DocIndex, gStart: number, gEnd: number): AnchorResult[] {
  const out: AnchorResult[] = [];
  let i = gStart;
  while (i <= gEnd) {
    const page = doc.map[i].page;
    let j = i;
    while (j + 1 <= gEnd && doc.map[j + 1].page === page) j++;
    const items = doc.pages[page].items;
    const rects = rectsFromRange(items, doc.map[i].item, doc.map[i].ch, doc.map[j].item, doc.map[j].ch);
    if (rects.length) out.push({ page, rects });
    i = j + 1;
  }
  return out;
}

function contextScore(search: string, start: number, end: number, nPrefix?: string, nSuffix?: string): number {
  let score = 0;
  if (nPrefix) {
    const tail = nPrefix.slice(-12);
    const before = search.slice(Math.max(0, start - tail.length), start);
    if (tail && before.endsWith(tail)) score += 2;
    else if (tail.length >= 4 && before.slice(-4) === tail.slice(-4)) score += 1;
  }
  if (nSuffix) {
    const head = nSuffix.slice(0, 12);
    const after = search.slice(end + 1, end + 1 + head.length);
    if (head && after.startsWith(head)) score += 2;
    else if (head.length >= 4 && after.slice(0, 4) === head.slice(0, 4)) score += 1;
  }
  return score;
}

/**
 * Locate `exact` in the document, disambiguating duplicates with prefix/suffix.
 * Tries a whole-string match first, then a head+tail span match for passages
 * with minor extraction drift. Returns one result per page covered (a cross-page
 * selection yields multiple), or [] if not found.
 */
export function anchorQuote(
  doc: DocIndex,
  exact: string,
  prefix?: string,
  suffix?: string
): AnchorResult[] {
  const search = doc.search;
  const needle = normStr(exact);
  if (needle.length < 2) return [];
  const nPrefix = prefix ? normStr(prefix) : undefined;
  const nSuffix = suffix ? normStr(suffix) : undefined;

  // --- Pass 1: whole-string match, best disambiguated occurrence ---
  let best: { start: number; end: number; score: number } | null = null;
  let from = 0;
  for (;;) {
    const at = search.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length - 1;
    const score = contextScore(search, at, end, nPrefix, nSuffix);
    if (!best || score > best.score) best = { start: at, end, score };
    if (best.score >= 4) break;
    from = at + 1;
  }
  if (best) return resultsFromSpan(doc, best.start, best.end);

  // --- Pass 2: head + tail span fallback (handles internal drift) ---
  const hlen = Math.min(40, Math.max(12, Math.floor(needle.length * 0.35)));
  const head = needle.slice(0, hlen);
  const tail = needle.slice(-hlen);
  const lo = needle.length * 0.6;
  const hi = needle.length * 1.6;
  let fb: { start: number; end: number; score: number } | null = null;
  from = 0;
  for (;;) {
    const h = search.indexOf(head, from);
    if (h < 0) break;
    const t = search.indexOf(tail, h + head.length - 1);
    if (t >= 0) {
      const end = t + tail.length - 1;
      const span = end - h + 1;
      if (span >= lo && span <= hi) {
        const score = contextScore(search, h, end, nPrefix, nSuffix);
        if (!fb || score > fb.score) fb = { start: h, end, score };
      }
    }
    from = h + 1;
  }
  if (fb) return resultsFromSpan(doc, fb.start, fb.end);

  return [];
}
