/**
 * annotations.ts — annotation data model + sidecar persistence.
 *
 * Storage: a human-readable sidecar next to the PDF, "<pdfname>.annotations.md".
 * It has a prose list (for skimming / future back-links) AND a fenced ```json
 * block that is the machine source of truth. Geometry is stored in PDF
 * USER-SPACE units (origin bottom-left, y-up) so it is scale-independent and
 * survives zoom / re-render / window resize.
 */
import type { DataAdapter } from "obsidian";
import { debounce } from "obsidian";

export interface PdfRect {
  // PDF user space (same convention as viewport.convertToPdfPoint).
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The visual STYLE axis, orthogonal to color/meaning. Stored on each mark.
 * Absent on legacy marks → treated as "highlight" (see markStyleOf), so old
 * sidecars stay fully valid without migration.
 */
export type MarkStyle =
  | "highlight" // semi-transparent fill
  | "underline" // solid underline
  | "dashed" // dashed underline
  | "dotted" // dotted underline
  | "strike" // strikethrough
  | "box" // outlined rectangle around the text
  | "comment"; // "naked" note anchored to a span (quiet dotted underline, no fill)

export const MARK_STYLES: MarkStyle[] = [
  "highlight",
  "underline",
  "dashed",
  "dotted",
  "strike",
  "box",
  "comment",
];

/** Human label for menus / prose. */
export const MARK_STYLE_LABELS: Record<MarkStyle, string> = {
  highlight: "Highlight",
  underline: "Underline",
  dashed: "Dashed underline",
  dotted: "Dotted underline",
  strike: "Strikethrough",
  box: "Box",
  comment: "Comment",
};

/** Coerce an unknown/absent style to a valid one (legacy marks default to fill). */
export function markStyleOf(h: { style?: string } | null | undefined): MarkStyle {
  const s = (h?.style ?? "highlight") as MarkStyle;
  return MARK_STYLES.includes(s) ? s : "highlight";
}

export interface Highlight {
  id: string;
  page: number; // 0-based page index
  color: string; // rgba/hex — the COLOR/meaning axis (a palette `fill` value)
  style?: MarkStyle; // the STYLE axis; absent ⇒ "highlight" (backward compatible)
  text: string; // selected / quoted text
  note?: string; // user comment (carried over from legacy import)
  rects: PdfRect[]; // one rect per visual line
  /** Quote context, kept for robustness / future re-anchoring. */
  context?: { prefix?: string; suffix?: string };
  created: string; // ISO timestamp
  source?: "manual" | "import";
}

export interface AnnotationDoc {
  version: 1;
  pdf: string; // vault-relative path of the PDF
  fingerprint?: string; // pdf.js document fingerprint (sanity only)
  highlights: Highlight[];
}

/**
 * The COLOR/meaning palette. Restrained, muted hues — legible over body text,
 * not neon. `fill` is the stored color (semi-transparent, used as a highlight
 * wash; painted alpha is additionally capped at render time). `ink` is a
 * near-opaque, slightly darker version used for line styles (underline / dashed
 * / strike / box), which need to read crisply as a thin stroke.
 */
export interface PaletteEntry {
  name: string;
  fill: string; // stored on the mark as `color`
  ink: string; // derived stroke color for line/box styles
  emoji: string;
}

export const PALETTE: PaletteEntry[] = [
  { name: "yellow", fill: "rgba(232, 194, 76, 0.42)", ink: "rgba(166, 124, 12, 0.95)", emoji: "🟨" },
  { name: "green", fill: "rgba(124, 178, 122, 0.42)", ink: "rgba(58, 122, 70, 0.95)", emoji: "🟩" },
  { name: "blue", fill: "rgba(120, 160, 208, 0.42)", ink: "rgba(52, 104, 168, 0.95)", emoji: "🟦" },
  { name: "pink", fill: "rgba(206, 138, 168, 0.44)", ink: "rgba(160, 70, 112, 0.95)", emoji: "🟪" },
  { name: "red", fill: "rgba(202, 110, 100, 0.44)", ink: "rgba(168, 60, 52, 0.95)", emoji: "🟥" },
];

/** name → fill, kept for any code that wants the simple map. */
export const HL_COLORS: Record<string, string> = Object.fromEntries(
  PALETTE.map((p) => [p.name, p.fill])
);
export const DEFAULT_COLOR = PALETTE[0].fill;

/**
 * Old (pre-refinement) saturated fills → current palette name. Lets legacy
 * marks render with the calmer palette WITHOUT rewriting the sidecar: we never
 * mutate the stored string, we only resolve it at paint time.
 */
const LEGACY_FILL_TO_NAME: Record<string, string> = {
  "rgba(255, 214, 0, 0.40)": "yellow",
  "rgba(106, 217, 126, 0.42)": "green",
  "rgba(90, 170, 255, 0.40)": "blue",
  "rgba(255, 130, 200, 0.42)": "pink",
  "rgba(255, 110, 110, 0.42)": "red",
};

/**
 * Resolve any stored color to a palette entry (current fills, legacy fills, or
 * a normalized key match). Returns null for genuinely custom colors.
 */
export function resolvePalette(color: string): PaletteEntry | null {
  const norm = color.replace(/\s+/g, "");
  for (const p of PALETTE) if (p.fill.replace(/\s+/g, "") === norm) return p;
  const legacyName = LEGACY_FILL_TO_NAME[color] ?? LEGACY_FILL_TO_NAME[norm];
  if (legacyName) return PALETTE.find((p) => p.name === legacyName) ?? null;
  for (const [legacy, name] of Object.entries(LEGACY_FILL_TO_NAME)) {
    if (legacy.replace(/\s+/g, "") === norm) return PALETTE.find((p) => p.name === name) ?? null;
  }
  return null;
}

export function newId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function colorEmoji(color: string): string {
  return resolvePalette(color)?.emoji ?? "🟨";
}

/** Derive the sidecar path from a PDF's vault path. */
export function sidecarPathFor(pdfVaultPath: string): string {
  return pdfVaultPath.replace(/\.pdf$/i, "") + ".annotations.md";
}

export function serializeAnnotations(doc: AnnotationDoc, pdfBasename: string): string {
  const ordered = [...doc.highlights].sort(
    (a, b) => a.page - b.page || a.created.localeCompare(b.created)
  );
  const lines: string[] = [];
  lines.push("---");
  lines.push("lpa-annotations: 1");
  lines.push(`pdf: ${JSON.stringify(doc.pdf)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Annotations — ${pdfBasename}`);
  lines.push("");
  lines.push(
    "<!-- Managed by Local PDF Annotator. The ```json block at the bottom is the " +
      "source of truth; the list above is for reading. Editing the prose is safe; " +
      "keep the json block intact. -->"
  );
  lines.push("");
  if (ordered.length === 0) {
    lines.push("_No highlights yet._");
  } else {
    for (const h of ordered) {
      const text = h.text.replace(/\s+/g, " ").trim();
      const short = text.length > 220 ? text.slice(0, 217) + "…" : text;
      const st = markStyleOf(h);
      const styleTag = st === "highlight" ? "" : ` _(${MARK_STYLE_LABELS[st].toLowerCase()})_`;
      let line = `- **p.${h.page + 1}** ${colorEmoji(h.color)}${styleTag} ^${h.id} — "${short}"`;
      if (h.note && h.note.trim()) line += `\n  - 📝 ${h.note.replace(/\s+/g, " ").trim()}`;
      lines.push(line);
    }
  }
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(doc, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/** Extract the last ```json fenced block and parse it. Tolerant of missing/garbled files. */
export function parseAnnotations(content: string): AnnotationDoc | null {
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(content)) !== null) last = match[1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.highlights)) return null;
    return parsed as AnnotationDoc;
  } catch {
    return null;
  }
}

/**
 * In-memory annotation store with debounced autosave to the sidecar.
 */
export class AnnotationStore {
  doc: AnnotationDoc;
  private dirty = false;
  private flushDebounced: () => void;

  constructor(
    private adapter: DataAdapter,
    private sidecarPath: string,
    private pdfBasename: string,
    pdfVaultPath: string,
    fingerprint?: string
  ) {
    this.doc = { version: 1, pdf: pdfVaultPath, fingerprint, highlights: [] };
    this.flushDebounced = debounce(() => void this.flush(), 600, true);
  }

  async load(): Promise<void> {
    try {
      if (await this.adapter.exists(this.sidecarPath)) {
        const content = await this.adapter.read(this.sidecarPath);
        const parsed = parseAnnotations(content);
        if (parsed) {
          this.doc.highlights = parsed.highlights;
          if (parsed.fingerprint) this.doc.fingerprint = parsed.fingerprint;
        }
      }
    } catch {
      /* start empty on any read/parse failure */
    }
  }

  byPage(page: number): Highlight[] {
    return this.doc.highlights.filter((h) => h.page === page);
  }

  get(id: string): Highlight | undefined {
    return this.doc.highlights.find((h) => h.id === id);
  }

  add(h: Highlight): void {
    this.doc.highlights.push(h);
    this.markDirty();
  }

  addMany(hs: Highlight[]): void {
    this.doc.highlights.push(...hs);
    this.markDirty();
  }

  remove(id: string): void {
    const i = this.doc.highlights.findIndex((h) => h.id === id);
    if (i >= 0) {
      this.doc.highlights.splice(i, 1);
      this.markDirty();
    }
  }

  update(id: string, patch: Partial<Highlight>): void {
    const h = this.get(id);
    if (h) {
      Object.assign(h, patch);
      this.markDirty();
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.flushDebounced();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const out = serializeAnnotations(this.doc, this.pdfBasename);
    await this.adapter.write(this.sidecarPath, out);
  }
}
