/**
 * annotations.ts — Core data model, sidecar persistence, and serialization
 * for PDF Annotator.
 */
import { DataAdapter, Notice } from "obsidian";
import { LOG_TAG } from "./pdf-engine";

export const DEFAULT_COLOR = "#ffe066a6";
export const DEFAULT_ANNOTATION_FOLDER = "";

export type AnnotationStorageMode = "folder" | "flat" | "beside-pdf";

export interface PaletteColor {
  name: string;
  fill: string;
  ink: string;
  cardFill?: string;
  highlightAlpha?: number;
}

export const PALETTE: PaletteColor[] = [
  { name: "Yellow", fill: "#ffe066a6", ink: "#8b7500", highlightAlpha: 0.42 },
  { name: "Green", fill: "#b2f2bba6", ink: "#2b6e38", highlightAlpha: 0.4 },
  { name: "Blue", fill: "#a5d8ffa6", ink: "#1c5b88", highlightAlpha: 0.4 },
  { name: "Pink", fill: "#ffc9c9a6", ink: "#8f3838", highlightAlpha: 0.4 },
  { name: "Purple", fill: "#eebefaa6", ink: "#6b2c82", highlightAlpha: 0.4 },
];

export function resolvePalette(color: string): PaletteColor | undefined {
  const norm = color.trim().toLowerCase();
  return PALETTE.find((p) => p.fill.toLowerCase() === norm);
}

export type MarkStyle = "highlight" | "underline" | "squiggly" | "strikeout" | "dashed" | "dotted" | "comment";

export const MARK_STYLES: MarkStyle[] = [
  "highlight",
  "underline",
  "squiggly",
  "strikeout",
  "dashed",
  "dotted",
  "comment",
];

export const MARK_STYLE_LABELS: Record<MarkStyle, string> = {
  highlight: "Highlight",
  underline: "Underline",
  squiggly: "Squiggly",
  strikeout: "Strikeout",
  dashed: "Dashed line",
  dotted: "Dotted line",
  comment: "Comment line",
};

export function markStyleOf(h: Highlight | null | undefined): MarkStyle {
  if (!h) return "highlight";
  const st = h.style;
  if (st && MARK_STYLES.includes(st)) return st;
  return "highlight";
}

export interface PdfRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Highlight {
  id: string;
  type?: "highlight" | "tag";
  page: number;
  color: string;
  tagColor?: string;
  tagX?: number;
  tagY?: number;
  style?: MarkStyle;
  text: string;
  note?: string;
  noteContentCJK?: string;
  rects: PdfRect[];
  created: string;
  source?: "manual" | "import";
  marginSide?: "left" | "right" | "auto";
  isPinned?: boolean;
  context?: {
    prefix?: string;
    suffix?: string;
  };
}

export interface AnnotationDoc {
  version: number;
  pdf: string;
  fingerprint?: string;
  highlights: Highlight[];
}

export interface AnnotationPathOptions {
  storageFolder: "sidecar" | "vault" | "plugin" | string;
  storageMode?: AnnotationStorageMode;
  vaultSubfolder?: string;
}

export function sidecarPathFor(pdfPath: string, options?: AnnotationPathOptions): string {
  const base = pdfPath.replace(/\.pdf$/i, ".annot.json");
  const mode = options?.storageFolder ?? "sidecar";
  if (mode === "sidecar") {
    return base;
  }
  const folder = (options?.vaultSubfolder ?? "").trim().replace(/^\/+|\/+$/g, "");
  const fileName = base.split("/").pop() ?? base;
  if (mode === "plugin") {
    const pluginFolder = ".obsidian/plugins/local-pdf-annotator/annotations";
    return folder ? `${pluginFolder}/${folder}/${fileName}` : `${pluginFolder}/${fileName}`;
  }
  return folder ? `${folder}/${fileName}` : fileName;
}

export function legacySidecarPathFor(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, ".annotations.json");
}

export function normalizeAnnotationStorageFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

export function parseAnnotations(raw: string): AnnotationDoc | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.highlights)) {
      if (!parsed.pdf && parsed.pdfPath) {
        parsed.pdf = parsed.pdfPath;
      }
      return parsed as AnnotationDoc;
    }
  } catch {}
  return null;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

export class AnnotationStore {
  doc: AnnotationDoc;
  private dirty = false;
  private saveTimer: number | null = null;

  constructor(
    private adapter: DataAdapter,
    private annotationPath: string,
    private pdfName: string,
    private pdfPath: string,
    private fileFingerprint?: string,
    private fallbackPaths: string[] = [],
    private migrateFallback = false,
    private backupPath?: string,
    private wrapExtractedNotesWithMark = true
  ) {
    this.doc = {
      version: 1,
      pdf: pdfPath,
      fingerprint: fileFingerprint,
      highlights: [],
    };
  }

  setPdfPath(pdfPath: string, pdfName: string): void {
    this.doc.pdf = pdfPath;
    this.dirty = true;
    this.scheduleFlush();
  }

  async load(): Promise<void> {
    const pathsToTry = [this.annotationPath, ...this.fallbackPaths];
    let loaded: AnnotationDoc | null = null;
    let foundPath: string | null = null;

    for (const p of pathsToTry) {
      try {
        if (await this.adapter.exists(p)) {
          const raw = await this.adapter.read(p);
          const parsed = parseAnnotations(raw);
          if (parsed) {
            loaded = parsed;
            foundPath = p;
            break;
          }
        }
      } catch (e) {
        console.error(`${LOG_TAG} failed to read annotations from ${p}`, e);
      }
    }

    if (loaded) {
      this.doc = loaded;
      if (!this.doc.version) this.doc.version = 1;
      if (!this.doc.pdf && this.pdfPath) {
        this.doc.pdf = this.pdfPath;
      }
      if (!this.doc.fingerprint && this.fileFingerprint) {
        this.doc.fingerprint = this.fileFingerprint;
      }
      if (foundPath && foundPath !== this.annotationPath) {
        this.dirty = true;
        if (this.migrateFallback) {
          await this.flush();
        }
      }
      return;
    }

    if (this.backupPath) {
      try {
        if (await this.adapter.exists(this.backupPath)) {
          const raw = await this.adapter.read(this.backupPath);
          const parsed = parseAnnotations(raw);
          if (parsed) {
            this.doc = parsed;
            this.dirty = true;
            await this.flush();
            return;
          }
        }
      } catch (e) {
        console.error(`${LOG_TAG} failed to read annotation backup from ${this.backupPath}`, e);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;

    if (this.fileFingerprint && !this.doc.fingerprint) {
      this.doc.fingerprint = this.fileFingerprint;
    }
    if (this.pdfPath && !this.doc.pdf) {
      this.doc.pdf = this.pdfPath;
    }

    try {
      const dir = this.annotationPath.substring(0, this.annotationPath.lastIndexOf("/"));
      if (dir && !(await this.adapter.exists(dir))) {
        await this.adapter.mkdir(dir);
      }
      const payload = JSON.stringify(this.doc, null, 2);
      await this.adapter.write(this.annotationPath, payload);
      if (this.backupPath) {
        const backupDir = this.backupPath.substring(0, this.backupPath.lastIndexOf("/"));
        if (backupDir && !(await this.adapter.exists(backupDir))) {
          await this.adapter.mkdir(backupDir);
        }
        await this.adapter.write(this.backupPath, payload);
      }
    } catch (e) {
      this.dirty = true;
      console.error(`${LOG_TAG} failed to save annotations to ${this.annotationPath}`, e);
      new Notice("PDF Annotator: failed to save annotations to disk.");
    }
  }

  private scheduleFlush(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 800);
  }

  get(id: string): Highlight | undefined {
    return this.doc.highlights.find((h) => h.id === id);
  }

  byPage(pageIndex: number): Highlight[] {
    return this.doc.highlights.filter((h) => h.page === pageIndex);
  }

  add(h: Highlight): void {
    this.doc.highlights.push(h);
    this.dirty = true;
    this.scheduleFlush();
  }

  addMany(items: Highlight[]): void {
    if (items.length === 0) return;
    this.doc.highlights.push(...items);
    this.dirty = true;
    this.scheduleFlowInternal();
  }

  private scheduleFlowInternal(): void {
    this.dirty = true;
    this.scheduleFlush();
  }

  update(id: string, patch: Partial<Highlight>): boolean {
    const h = this.get(id);
    if (!h) return false;
    Object.assign(h, patch);
    this.dirty = true;
    this.scheduleFlush();
    return true;
  }

  remove(id: string): boolean {
    const idx = this.doc.highlights.findIndex((h) => h.id === id);
    if (idx < 0) {
      return false;
    }
    this.doc.highlights.splice(idx, 1);
    this.dirty = true;
    this.scheduleFlush();
    return true;
  }

  formatExtractedNote(h: Highlight): string {
    const text = (h.text || "").replace(/\s+/g, " ").trim();
    const noteText = (h.note || h.noteContentCJK || "").replace(/\s+/g, " ").trim();
    
    if (this.wrapExtractedNotesWithMark) {
      let formatted = `<mark style="background: ${h.color};">${text}</mark>`;
      if (noteText) {
        formatted += `\n<mark style="background: ${h.color};">_*nota*: ${noteText}_</mark>`;
      }
      return formatted;
    }
    
    if (noteText) {
      return `${text}\n*nota*: ${noteText}`;
    }
    return text;
  }
}