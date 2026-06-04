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

export interface Highlight {
  id: string;
  page: number; // 0-based page index
  color: string; // rgba/hex
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

export const HL_COLORS: Record<string, string> = {
  yellow: "rgba(255, 214, 0, 0.40)",
  green: "rgba(106, 217, 126, 0.42)",
  blue: "rgba(90, 170, 255, 0.40)",
  pink: "rgba(255, 130, 200, 0.42)",
  red: "rgba(255, 110, 110, 0.42)",
};
export const DEFAULT_COLOR = HL_COLORS.yellow;

const COLOR_EMOJI: Array<[string, string]> = [
  ["yellow", "🟨"],
  ["green", "🟩"],
  ["blue", "🟦"],
  ["pink", "🟪"],
  ["red", "🟥"],
];

export function newId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function colorEmoji(color: string): string {
  for (const [name, emoji] of COLOR_EMOJI) {
    if (HL_COLORS[name] === color) return emoji;
  }
  return "🟨";
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
      let line = `- **p.${h.page + 1}** ${colorEmoji(h.color)} ^${h.id} — "${short}"`;
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
