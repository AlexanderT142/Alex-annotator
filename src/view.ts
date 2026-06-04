/**
 * view.ts — PdfAnnotatorView: a FileView that renders a PDF as a vertical,
 * scrollable column of pages using our OWN bundled pdf.js (see pdf-engine.ts),
 * with persistent text-highlight annotations stored in a sidecar file.
 *
 * Layers per page (z-order): canvas (raster) < highlight layer (visual only) <
 * text layer (selectable). Highlight geometry is stored in PDF user space and
 * re-projected to the current viewport on every render, so it tracks zoom and
 * resize. Highlight clicks are hit-tested in JS so they never block text
 * selection.
 */
import { FileView, TFile, WorkspaceLeaf, Notice } from "obsidian";
import { pdfjsLib, initPdfEngine, getPdfEngineStatus, createDedicatedWorker, LOG_TAG } from "./pdf-engine";
import {
  AnnotationStore,
  DEFAULT_COLOR,
  PALETTE,
  resolvePalette,
  MARK_STYLES,
  MARK_STYLE_LABELS,
  markStyleOf,
  newId,
  sidecarPathFor,
  type Highlight,
  type MarkStyle,
  type PdfRect,
} from "./annotations";
import { buildDocIndex, anchorQuote } from "./anchor";
import { parseLegacyNote, targetBasename, type LegacyAnnotation } from "./legacy-import";

export const VIEW_TYPE_PDF_ANNOTATOR = "local-pdf-annotator-view";

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const ZOOM_STEP = 1.2;
const DEFAULT_SCALE = 1.25;
const PREFETCH_MARGIN = "1000px";
const MAX_HIGHLIGHT_ALPHA = 0.28;

interface Size {
  w: number;
  h: number;
}

interface PageView {
  index: number;
  el: HTMLElement;
  hlLayer: HTMLElement;
  canvas: HTMLCanvasElement | null;
  textLayerEl: HTMLElement | null;
  page: any | null;
  rendered: boolean;
  rendering: boolean;
  renderTask: any | null;
  textTask: any | null;
}

interface HighlightPaintRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  color: string;
  order: number;
  ids: Set<string>;
  notes: Set<string>;
}

export class PdfAnnotatorView extends FileView {
  private rootEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;
  private statusDotEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private pagesEl!: HTMLElement;
  private sidebarEl!: HTMLElement;
  private annotationListEl!: HTMLElement;
  private annotationCountEl!: HTMLElement;
  private swatchEls: HTMLElement[] = [];
  private styleBtnEls: HTMLElement[] = [];

  private pdfDoc: any | null = null;
  private pdfWorker: any | null = null;
  private store: AnnotationStore | null = null;
  private currentColor = DEFAULT_COLOR;
  private currentStyle: MarkStyle = "highlight";
  private markPopoverCleanup: (() => void) | null = null;

  private pageViews: PageView[] = [];
  private pageSizes: (Size | null)[] = [];
  private defaultSize: Size = { w: 612, h: 792 };
  private scale = DEFAULT_SCALE;

  private io: IntersectionObserver | null = null;
  private visible = new Set<number>();
  private renderEpoch = 0;
  private loadToken = 0;
  private activeHighlightId: string | null = null;
  private hoverHighlightId: string | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = true;
    this.allowNoFile = false;
  }

  getViewType(): string {
    return VIEW_TYPE_PDF_ANNOTATOR;
  }
  getIcon(): string {
    return "highlighter";
  }
  getDisplayText(): string {
    return this.file ? this.file.basename : "PDF Annotator";
  }
  canAcceptExtension(extension: string): boolean {
    return extension === "pdf";
  }

  async onOpen(): Promise<void> {
    initPdfEngine();
    this.buildSkeleton();
    // Capture text selections / highlight clicks. Auto-removed on unload.
    this.registerDomEvent(this.pagesEl, "mouseup", (evt) => this.onMouseUp(evt));
    this.registerDomEvent(this.pagesEl, "mousemove", (evt) => this.onPageMouseMove(evt));
    this.registerDomEvent(this.pagesEl, "mouseleave", () => this.setHoveredHighlight(null));
  }

  async onClose(): Promise<void> {
    await this.flushStore();
    this.teardownDocument();
  }

  // ---- DOM skeleton -------------------------------------------------------

  private buildSkeleton(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("lpa-container");

    this.rootEl = container.createDiv({ cls: "lpa-root" });
    this.toolbarEl = this.rootEl.createDiv({ cls: "lpa-toolbar" });
    this.titleEl = this.toolbarEl.createSpan({ cls: "lpa-title", text: "PDF Annotator" });

    // The "pen": pick a STYLE and a COLOR (two small additive rows, never a
    // style×color grid). Drag-select then applies the current pen in one gesture.
    const pen = this.toolbarEl.createDiv({ cls: "lpa-pen" });

    const styles = pen.createDiv({ cls: "lpa-styles", attr: { role: "radiogroup", "aria-label": "Mark style" } });
    this.styleBtnEls = [];
    for (const st of MARK_STYLES) {
      const btn = styles.createEl("button", {
        cls: "lpa-style-btn",
        attr: { "aria-label": MARK_STYLE_LABELS[st], title: MARK_STYLE_LABELS[st] },
      });
      btn.dataset.style = st;
      buildStylePreview(btn, st);
      btn.onclick = () => this.setActiveStyle(st);
      this.styleBtnEls.push(btn);
    }

    const swatches = pen.createDiv({ cls: "lpa-swatches" });
    this.swatchEls = [];
    for (const p of PALETTE) {
      const sw = swatches.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name } });
      sw.style.background = p.fill;
      sw.dataset.color = p.fill;
      sw.onclick = () => this.setActiveColor(p.fill);
      this.swatchEls.push(sw);
    }
    this.setActiveColor(this.currentColor);
    this.setActiveStyle(this.currentStyle);

    const zoomOut = this.toolbarEl.createEl("button", { text: "−", attr: { "aria-label": "Zoom out" } });
    zoomOut.onclick = () => this.zoomBy(1 / ZOOM_STEP);
    this.zoomLabelEl = this.toolbarEl.createSpan({ cls: "lpa-zoom-label", text: "125%" });
    const zoomIn = this.toolbarEl.createEl("button", { text: "+", attr: { "aria-label": "Zoom in" } });
    zoomIn.onclick = () => this.zoomBy(ZOOM_STEP);
    const zoomReset = this.toolbarEl.createEl("button", { text: "Reset", attr: { "aria-label": "Reset zoom" } });
    zoomReset.onclick = () => this.setScale(DEFAULT_SCALE);

    this.statusDotEl = this.toolbarEl.createSpan({ cls: "lpa-status-dot" });
    this.refreshStatusDot();

    this.bodyEl = this.rootEl.createDiv({ cls: "lpa-body" });
    this.pagesEl = this.bodyEl.createDiv({ cls: "lpa-pages" });
    this.sidebarEl = this.bodyEl.createDiv({ cls: "lpa-sidebar" });
    const sidebarHeader = this.sidebarEl.createDiv({ cls: "lpa-sidebar-header" });
    sidebarHeader.createDiv({ cls: "lpa-sidebar-title", text: "Annotations" });
    this.annotationCountEl = sidebarHeader.createDiv({ cls: "lpa-sidebar-count", text: "0" });
    this.annotationListEl = this.sidebarEl.createDiv({ cls: "lpa-annotation-list" });
    this.renderAnnotationSidebar();
  }

  private setActiveColor(value: string): void {
    this.currentColor = value;
    for (const sw of this.swatchEls) sw.toggleClass("is-active", sw.dataset.color === value);
    this.tintStylePreviews();
  }

  private setActiveStyle(style: MarkStyle): void {
    this.currentStyle = style;
    for (const b of this.styleBtnEls) {
      const on = b.dataset.style === style;
      b.toggleClass("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    }
  }

  /** Paint the style-preview chips in the currently selected ink so the pen
   * reads as "this style, this color" at a glance. */
  private tintStylePreviews(): void {
    const pal = resolvePalette(this.currentColor);
    const ink = pal?.ink ?? this.currentColor;
    const fill = pal?.fill ?? this.currentColor;
    for (const b of this.styleBtnEls) {
      b.style.setProperty("--lpa-ink", ink);
      b.style.setProperty("--lpa-fill", fill);
    }
  }

  private refreshStatusDot(): void {
    const st = getPdfEngineStatus();
    if (!this.statusDotEl) return;
    if (st?.ok) {
      this.statusDotEl.setText(`pdf.js ${st.apiVersion} ✓`);
      this.statusDotEl.setAttribute(
        "aria-label",
        `pdf.js ${st.apiVersion}: API & worker versions match (bundled, no conflict possible)`
      );
      this.statusDotEl.style.color = "var(--text-success, var(--text-muted))";
    } else if (st) {
      this.statusDotEl.setText(`pdf.js ${st.apiVersion} ⚠`);
      this.statusDotEl.style.color = "var(--text-error)";
    } else {
      this.statusDotEl.setText("");
    }
  }

  // ---- file load / unload -------------------------------------------------

  async onLoadFile(file: TFile): Promise<void> {
    if (!this.rootEl) this.buildSkeleton();
    this.titleEl.setText(file.basename);
    this.refreshStatusDot();

    const token = ++this.loadToken;
    await this.flushStore();
    this.teardownDocument();
    this.setStatus(`Loading ${file.name}…`);

    let data: ArrayBuffer;
    try {
      data = await this.app.vault.readBinary(file);
    } catch (e: any) {
      this.setError(`Could not read PDF file:\n${e?.message ?? e}`);
      return;
    }
    if (token !== this.loadToken) return;

    try {
      // Dedicated worker per document (never shared) so a 2nd open PDF can't
      // blank this one's canvas, and so we never touch Obsidian's global worker.
      this.pdfWorker = createDedicatedWorker();
      const params: any = { data: new Uint8Array(data), useSystemFonts: true };
      if (this.pdfWorker) params.worker = this.pdfWorker;
      const loadingTask = pdfjsLib.getDocument(params);
      this.pdfDoc = await loadingTask.promise;
    } catch (e: any) {
      console.error(`${LOG_TAG} getDocument failed`, e);
      this.setError(`Failed to open PDF with pdf.js:\n${e?.message ?? e}`);
      return;
    }
    if (token !== this.loadToken) {
      try { this.pdfDoc?.destroy(); } catch {}
      try { this.pdfWorker?.destroy(); } catch {}
      this.pdfDoc = null;
      this.pdfWorker = null;
      return;
    }

    // Annotation store keyed to this PDF.
    const fingerprint = Array.isArray(this.pdfDoc.fingerprints)
      ? this.pdfDoc.fingerprints[0]
      : this.pdfDoc.fingerprint;
    this.store = new AnnotationStore(
      this.app.vault.adapter,
      sidecarPathFor(file.path),
      file.basename,
      file.path,
      fingerprint
    );
    await this.store.load();

    await this.buildPages();
    this.renderAnnotationSidebar();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.flushStore();
    this.teardownDocument();
  }

  private async flushStore(): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.flush();
    } catch (e) {
      console.error(`${LOG_TAG} failed to save annotations`, e);
    }
  }

  // ---- page layout + lazy render -----------------------------------------

  private async buildPages(): Promise<void> {
    if (!this.pdfDoc) return;
    this.clearPagesDom();
    this.pagesEl.empty();
    this.pageViews = [];
    this.visible.clear();
    this.renderEpoch++;

    const n: number = this.pdfDoc.numPages;
    const p1 = await this.pdfDoc.getPage(1);
    const base = p1.getViewport({ scale: 1 });
    this.defaultSize = { w: base.width, h: base.height };
    this.pageSizes = new Array(n).fill(null);
    this.pageSizes[0] = { w: base.width, h: base.height };

    this.io?.disconnect();
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.pagesEl,
      rootMargin: `${PREFETCH_MARGIN} 0px`,
      threshold: 0,
    });

    for (let i = 0; i < n; i++) {
      const el = this.pagesEl.createDiv({ cls: "lpa-page" });
      el.dataset.index = String(i);
      const sz = this.pageSizes[i] ?? this.defaultSize;
      el.style.width = `${Math.floor(sz.w * this.scale)}px`;
      el.style.height = `${Math.floor(sz.h * this.scale)}px`;
      const hlLayer = el.createDiv({ cls: "lpa-highlight-layer" });
      const pv: PageView = {
        index: i, el, hlLayer, canvas: null, textLayerEl: null,
        page: i === 0 ? p1 : null, rendered: false, rendering: false, renderTask: null, textTask: null,
      };
      this.pageViews.push(pv);
      this.io.observe(el);
    }
    this.updateZoomLabel();
  }

  private renderAnnotationSidebar(): void {
    if (!this.annotationListEl || !this.annotationCountEl) return;
    this.annotationListEl.empty();
    const highlights = [...(this.store?.doc.highlights ?? [])].sort(
      (a, b) => a.page - b.page || a.created.localeCompare(b.created)
    );
    const ids = new Set(highlights.map((h) => h.id));
    if (this.activeHighlightId && !ids.has(this.activeHighlightId)) this.activeHighlightId = null;
    if (this.hoverHighlightId && !ids.has(this.hoverHighlightId)) this.hoverHighlightId = null;
    this.annotationCountEl.setText(String(highlights.length));
    if (highlights.length === 0) {
      this.annotationListEl.createDiv({
        cls: "lpa-empty-annotations",
        text: "No annotations yet. Drag across PDF text to highlight it.",
      });
      this.syncHighlightBindingState();
      return;
    }

    for (const h of highlights) {
      const item = this.annotationListEl.createDiv({ cls: "lpa-annotation-item" });
      item.dataset.hlId = h.id;
      item.toggleClass("is-active", h.id === this.activeHighlightId);
      item.toggleClass("is-hover", h.id === this.hoverHighlightId);
      item.addEventListener("mouseenter", () => this.setHoveredHighlight(h.id));
      item.addEventListener("mouseleave", () => this.setHoveredHighlight(null));
      const head = item.createDiv({ cls: "lpa-annotation-head" });
      const pageButton = head.createEl("button", {
        cls: "lpa-annotation-page",
        text: `p.${h.page + 1}`,
        attr: { "aria-label": `Go to page ${h.page + 1}` },
      });
      pageButton.onclick = () => void this.revealHighlight(h.id, { scrollSidebar: false });
      const st = markStyleOf(h);
      const pal = resolvePalette(h.color);
      const color = head.createDiv({
        cls: `lpa-annotation-color lpa-mark-chip lpa-mark--${st}`,
        attr: { title: MARK_STYLE_LABELS[st] },
      });
      color.style.setProperty("--lpa-ink", pal?.ink ?? markInkColor(h.color));
      color.style.setProperty("--lpa-fill", pal?.fill ?? h.color);
      const actions = head.createDiv({ cls: "lpa-annotation-actions" });
      const copy = actions.createEl("button", { text: "Copy", attr: { "aria-label": "Copy annotation text" } });
      copy.onclick = async () => {
        await navigator.clipboard.writeText(h.text);
        new Notice("Copied annotation text");
      };
      const del = actions.createEl("button", { text: "Delete", attr: { "aria-label": "Delete annotation" } });
      del.onclick = () => {
        this.store?.remove(h.id);
        if (this.activeHighlightId === h.id) this.activeHighlightId = null;
        if (this.hoverHighlightId === h.id) this.hoverHighlightId = null;
        const pv = this.pageViews[h.page];
        if (pv?.rendered) this.renderHighlights(pv);
        this.renderAnnotationSidebar();
      };

      const text = item.createDiv({ cls: "lpa-annotation-text", text: shortAnnotationText(h.text, 360) });
      text.onclick = () => void this.revealHighlight(h.id, { scrollSidebar: false });

      const note = item.createEl("textarea", {
        cls: "lpa-annotation-note",
        attr: { placeholder: "Note", rows: "2", "aria-label": "Annotation note" },
      });
      note.value = h.note ?? "";
      note.oninput = () => {
        this.store?.update(h.id, { note: note.value.trim() ? note.value : undefined });
        const pv = this.pageViews[h.page];
        if (pv?.rendered) this.renderHighlights(pv);
      };
    }
    this.syncHighlightBindingState();
  }

  private activateHighlight(
    id: string | null,
    options: { scrollSidebar?: boolean; focusNote?: boolean } = {}
  ): void {
    this.activeHighlightId = id;
    if (id && !this.store?.get(id)) this.activeHighlightId = null;
    this.syncHighlightBindingState();
    if (this.activeHighlightId && options.scrollSidebar) {
      this.scrollSidebarCard(this.activeHighlightId, !!options.focusNote);
    } else if (this.activeHighlightId && options.focusNote) {
      this.focusSidebarNote(this.activeHighlightId);
    }
  }

  private setHoveredHighlight(id: string | null): void {
    const next = id && this.store?.get(id) ? id : null;
    if (this.hoverHighlightId === next) return;
    this.hoverHighlightId = next;
    this.syncHighlightBindingState();
  }

  private syncHighlightBindingState(): void {
    this.rootEl?.toggleClass("has-active-highlight", !!this.activeHighlightId);
    if (this.annotationListEl) {
      for (const item of this.annotationListEl.querySelectorAll<HTMLElement>(".lpa-annotation-item")) {
        const id = item.dataset.hlId ?? "";
        item.toggleClass("is-active", !!id && id === this.activeHighlightId);
        item.toggleClass("is-hover", !!id && id === this.hoverHighlightId);
      }
    }
    if (this.pagesEl) {
      for (const mark of this.pagesEl.querySelectorAll<HTMLElement>(".lpa-highlight")) {
        const ids = highlightIdsForElement(mark);
        mark.toggleClass("is-active", !!this.activeHighlightId && ids.includes(this.activeHighlightId));
        mark.toggleClass("is-hover", !!this.hoverHighlightId && ids.includes(this.hoverHighlightId));
      }
    }
  }

  private scrollSidebarCard(id: string, focusNote: boolean): void {
    const item = this.sidebarCardFor(id);
    if (!item) return;
    item.scrollIntoView({ block: "nearest" });
    if (focusNote) this.focusSidebarNote(id);
  }

  private focusSidebarNote(id: string): void {
    window.setTimeout(() => {
      const note = this.sidebarCardFor(id)?.querySelector<HTMLTextAreaElement>(".lpa-annotation-note");
      note?.focus({ preventScroll: true });
    }, 0);
  }

  private sidebarCardFor(id: string): HTMLElement | null {
    return this.annotationListEl?.querySelector<HTMLElement>(
      `.lpa-annotation-item[data-hl-id="${cssEscape(id)}"]`
    ) ?? null;
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const idx = Number((entry.target as HTMLElement).dataset.index);
      const pv = this.pageViews[idx];
      if (!pv) continue;
      if (entry.isIntersecting) {
        this.visible.add(idx);
        void this.renderPageContent(pv);
      } else {
        this.visible.delete(idx);
        this.teardownPageContent(pv);
      }
    }
  }

  private async renderPageContent(pv: PageView): Promise<void> {
    if (!this.pdfDoc || pv.rendered || pv.rendering) return;
    pv.rendering = true;
    const epoch = this.renderEpoch;
    try {
      const page = pv.page ?? (await this.pdfDoc.getPage(pv.index + 1));
      if (epoch !== this.renderEpoch) return;
      pv.page = page;

      const base = page.getViewport({ scale: 1 });
      this.pageSizes[pv.index] = { w: base.width, h: base.height };
      const viewport = page.getViewport({ scale: this.scale });

      pv.el.style.width = `${Math.floor(viewport.width)}px`;
      pv.el.style.height = `${Math.floor(viewport.height)}px`;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      pv.el.insertBefore(canvas, pv.hlLayer);
      pv.canvas = canvas;

      const ctx = canvas.getContext("2d");
      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      pv.renderTask = renderTask;
      await renderTask.promise;
      if (epoch !== this.renderEpoch) { this.teardownPageContent(pv); return; }

      const textLayerEl = pv.el.createDiv({ cls: "lpa-text-layer" });
      textLayerEl.style.setProperty("--scale-factor", String(this.scale));
      pv.textLayerEl = textLayerEl;
      const textContent = await page.getTextContent();
      if (epoch !== this.renderEpoch) { this.teardownPageContent(pv); return; }
      const textTask = pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayerEl,
        viewport,
        textDivs: [],
      });
      pv.textTask = textTask;
      await textTask.promise;
      if (epoch !== this.renderEpoch) { this.teardownPageContent(pv); return; }

      this.renderHighlights(pv);
      pv.rendered = true;
    } catch (e: any) {
      if (e?.name !== "RenderingCancelledException") {
        console.error(`${LOG_TAG} failed to render page ${pv.index + 1}`, e);
      }
      this.teardownPageContent(pv);
    } finally {
      pv.rendering = false;
    }
  }

  private teardownPageContent(pv: PageView): void {
    try { pv.renderTask?.cancel(); } catch {}
    try { pv.textTask?.cancel(); } catch {}
    pv.renderTask = null;
    pv.textTask = null;
    pv.canvas?.remove();
    pv.canvas = null;
    pv.textLayerEl?.remove();
    pv.textLayerEl = null;
    pv.hlLayer.empty();
    pv.rendered = false;
  }

  // ---- highlights ---------------------------------------------------------

  private renderHighlights(pv: PageView): void {
    pv.hlLayer.empty();
    if (!this.store || !pv.page) return;
    const vp = pv.page.getViewport({ scale: this.scale });
    const marks = this.store.byPage(pv.index);

    // ---- Fill highlights: coalesce same-color rects + occlude overlaps so
    // overlapping fills never compound into a dark muddy patch. ----
    const fillRects: HighlightPaintRect[] = [];
    let order = 0;
    for (const h of marks) {
      if (markStyleOf(h) !== "highlight") continue;
      order++;
      for (const r of this.rectToViewport(vp, h.rects)) {
        if (r.right - r.left < 0.5 || r.bottom - r.top < 0.5) continue;
        fillRects.push({
          left: r.left, top: r.top, right: r.right, bottom: r.bottom,
          color: h.color, order,
          ids: new Set([h.id]),
          notes: h.note ? new Set([h.note]) : new Set(),
        });
      }
    }
    for (const r of occludeHighlightRects(coalesceHighlightRects(fillRects))) {
      const div = pv.hlLayer.createDiv({ cls: "lpa-highlight lpa-mark--highlight" });
      div.style.left = `${r.left}px`;
      div.style.top = `${r.top}px`;
      div.style.width = `${r.right - r.left}px`;
      div.style.height = `${r.bottom - r.top}px`;
      div.style.setProperty("--lpa-hl-color", highlightPaintColor(r.color));
      const ids = Array.from(r.ids);
      div.dataset.hlIds = ids.join(" ");
      if (ids.length === 1) div.dataset.hlId = ids[0];
      if (r.notes.size === 1) div.setAttribute("aria-label", Array.from(r.notes)[0]);
      div.toggleClass("is-active", !!this.activeHighlightId && ids.includes(this.activeHighlightId));
      div.toggleClass("is-hover", !!this.hoverHighlightId && ids.includes(this.hoverHighlightId));
    }

    // ---- Decorative styles (underline / dashed / dotted / strike / box /
    // comment): rendered per-mark, one continuous stroke per visual line. ----
    const metrics = this.lineMetrics();
    for (const h of marks) {
      const st = markStyleOf(h);
      if (st === "highlight") continue;
      const lines = mergeLineRects(this.rectToViewport(vp, h.rects));
      for (const lr of lines) {
        this.paintDecorativeLine(pv.hlLayer, h, st, lr, metrics);
      }
    }
  }

  /** Convert PDF-space rects to viewport rects (left/top/right/bottom px). */
  private rectToViewport(
    vp: any,
    rects: PdfRect[]
  ): Array<{ left: number; top: number; right: number; bottom: number }> {
    const out: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    for (const r of rects) {
      const a = vp.convertToViewportPoint(r.x1, r.y1);
      const b = vp.convertToViewportPoint(r.x2, r.y2);
      out.push({
        left: Math.min(a[0], b[0]),
        top: Math.min(a[1], b[1]),
        right: Math.max(a[0], b[0]),
        bottom: Math.max(a[1], b[1]),
      });
    }
    return out;
  }

  /** Stroke weight + dash geometry, scaled with zoom for consistent weight. */
  private lineMetrics(): {
    weight: number;
    dash: number;
    dashGap: number;
    dot: number;
    dotGap: number;
  } {
    const s = this.scale;
    return {
      weight: clamp(1.4, s * 1.35, 3),
      dash: Math.max(4, Math.round(s * 5)),
      dashGap: Math.max(3, Math.round(s * 4)),
      dot: Math.max(1.4, +(s * 1.6).toFixed(2)),
      dotGap: Math.max(2.4, +(s * 2.8).toFixed(2)),
    };
  }

  private paintDecorativeLine(
    layer: HTMLElement,
    h: Highlight,
    st: MarkStyle,
    lr: { left: number; top: number; right: number; bottom: number },
    m: { weight: number; dash: number; dashGap: number; dot: number; dotGap: number }
  ): void {
    const el = layer.createDiv({ cls: `lpa-highlight lpa-mark lpa-mark--${st}` });
    el.style.left = `${lr.left}px`;
    el.style.top = `${lr.top}px`;
    el.style.width = `${lr.right - lr.left}px`;
    el.style.height = `${lr.bottom - lr.top}px`;

    const pal = resolvePalette(h.color);
    const ink = pal?.ink ?? markInkColor(h.color);
    el.style.setProperty("--lpa-ink", ink);
    el.style.setProperty("--lpa-w", `${m.weight}px`);

    if (st === "dashed") {
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${ink} 0 ${m.dash}px, transparent ${m.dash}px ${m.dash + m.dashGap}px)`
      );
    } else if (st === "dotted") {
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${ink} 0 ${m.dot}px, transparent ${m.dot}px ${m.dot + m.dotGap}px)`
      );
    } else if (st === "comment") {
      // Quiet: a faint dotted underline in low-alpha ink, no fill.
      const faint = withAlpha(ink, 0.5);
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${faint} 0 ${m.dot}px, transparent ${m.dot}px ${m.dot + m.dotGap}px)`
      );
    } else {
      // underline / strike: solid stroke
      el.style.setProperty("--lpa-deco", ink);
    }

    el.dataset.hlIds = h.id;
    el.dataset.hlId = h.id;
    if (h.note) el.setAttribute("aria-label", h.note);
    el.toggleClass("is-active", h.id === this.activeHighlightId);
    el.toggleClass("is-hover", h.id === this.hoverHighlightId);
  }

  private onMouseUp(evt: MouseEvent): void {
    if (!this.store) return;
    const doc = this.pagesEl.ownerDocument;
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      this.captureSelection(sel);
    } else {
      this.handleHighlightClick(evt);
    }
  }

  private pageViewAtPoint(clientX: number, clientY: number): PageView | null {
    const doc = this.pagesEl.ownerDocument;
    const el = doc.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const pageEl = el?.closest(".lpa-page") as HTMLElement | null;
    if (!pageEl) return null;
    return this.pageViews[Number(pageEl.dataset.index)] ?? null;
  }

  private highlightAtPoint(
    clientX: number,
    clientY: number
  ): { highlight: Highlight; pageView: PageView } | null {
    if (!this.store) return null;
    const pv = this.pageViewAtPoint(clientX, clientY);
    if (!pv || !pv.page) return null;
    const vp = pv.page.getViewport({ scale: this.scale });
    const pageRect = pv.el.getBoundingClientRect();
    const pt = vp.convertToPdfPoint(clientX - pageRect.left, clientY - pageRect.top);
    const hits = this.store.byPage(pv.index).filter((h) =>
      h.rects.some(
        (r) =>
          pt[0] >= Math.min(r.x1, r.x2) && pt[0] <= Math.max(r.x1, r.x2) &&
          pt[1] >= Math.min(r.y1, r.y2) && pt[1] <= Math.max(r.y1, r.y2)
      )
    );
    const highlight = hits[hits.length - 1];
    return highlight ? { highlight, pageView: pv } : null;
  }

  private onPageMouseMove(evt: MouseEvent): void {
    if (evt.buttons !== 0) return;
    const sel = this.pagesEl.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed) return;
    this.setHoveredHighlight(this.highlightAtPoint(evt.clientX, evt.clientY)?.highlight.id ?? null);
  }

  private pageViewForClientRect(rect: DOMRect): PageView | null {
    const direct = this.pageViewAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (direct) return direct;

    let best: { pv: PageView; area: number } | null = null;
    for (const pv of this.pageViews) {
      if (!pv.page) continue;
      const pr = pv.el.getBoundingClientRect();
      const w = Math.min(rect.right, pr.right) - Math.max(rect.left, pr.left);
      const h = Math.min(rect.bottom, pr.bottom) - Math.max(rect.top, pr.top);
      const area = w > 0 && h > 0 ? w * h : 0;
      if (area > 0 && (!best || area > best.area)) best = { pv, area };
    }
    return best?.pv ?? null;
  }

  private captureSelection(sel: Selection): void {
    const text = sel.toString().trim();
    const byPage = new Map<number, PdfRect[]>();
    const createdIds: string[] = [];
    for (let ri = 0; ri < sel.rangeCount; ri++) {
      const range = sel.getRangeAt(ri);
      for (const cr of Array.from(range.getClientRects())) {
        if (cr.width < 1 || cr.height < 1) continue;
        const pv = this.pageViewForClientRect(cr);
        if (!pv || !pv.page) continue;
        const vp = pv.page.getViewport({ scale: this.scale });
        const pageRect = pv.el.getBoundingClientRect();
        const p1 = vp.convertToPdfPoint(cr.left - pageRect.left, cr.top - pageRect.top);
        const p2 = vp.convertToPdfPoint(cr.right - pageRect.left, cr.bottom - pageRect.top);
        const arr = byPage.get(pv.index) ?? [];
        arr.push({ x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] });
        byPage.set(pv.index, arr);
      }
    }
    if (byPage.size === 0) return;
    for (const [pageIndex, rects] of byPage) {
      const h: Highlight = {
        id: newId(), page: pageIndex, color: this.currentColor, style: this.currentStyle, text,
        rects, created: new Date().toISOString(), source: "manual",
      };
      this.store!.add(h);
      createdIds.push(h.id);
      const pv = this.pageViews[pageIndex];
      if (pv) this.renderHighlights(pv);
    }
    this.renderAnnotationSidebar();
    if (createdIds.length) this.activateHighlight(createdIds[0], { scrollSidebar: true, focusNote: true });
    sel.removeAllRanges();
  }

  private handleHighlightClick(evt: MouseEvent): void {
    if (!this.store) return;
    const hit = this.highlightAtPoint(evt.clientX, evt.clientY);
    if (hit) {
      evt.preventDefault();
      this.activateHighlight(hit.highlight.id, { scrollSidebar: true });
      this.openMarkPopover(hit.highlight, evt, hit.pageView);
    } else {
      this.closeMarkPopover();
    }
  }

  /**
   * The post-hoc editor: a calm, non-modal popover with the SAME two axes as the
   * pen — change style and/or color on an existing mark, live, in one click each.
   * Plus copy + delete. No native menu, no dialog.
   */
  private openMarkPopover(h: Highlight, evt: MouseEvent, pv: PageView): void {
    this.closeMarkPopover();
    const doc = this.pagesEl.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-mark-popover" });

    const rerender = () => {
      const cur = this.store?.get(h.id);
      if (!cur) return;
      const target = this.pageViews[cur.page] ?? pv;
      if (target?.rendered) this.renderHighlights(target);
      this.renderAnnotationSidebar();
    };

    // Row 1 — style
    const styleRow = pop.createDiv({ cls: "lpa-styles", attr: { role: "radiogroup", "aria-label": "Mark style" } });
    const syncStyleChecks = () => {
      const cur = markStyleOf(this.store?.get(h.id));
      for (const b of Array.from(styleRow.children) as HTMLElement[]) {
        b.toggleClass("is-active", b.dataset.style === cur);
      }
    };
    for (const st of MARK_STYLES) {
      const btn = styleRow.createEl("button", {
        cls: "lpa-style-btn",
        attr: { "aria-label": MARK_STYLE_LABELS[st], title: MARK_STYLE_LABELS[st] },
      });
      btn.dataset.style = st;
      const pal = resolvePalette(this.store?.get(h.id)?.color ?? h.color);
      buildStylePreview(btn, st);
      btn.style.setProperty("--lpa-ink", pal?.ink ?? h.color);
      btn.style.setProperty("--lpa-fill", pal?.fill ?? h.color);
      btn.onclick = () => {
        this.store?.update(h.id, { style: st });
        rerender();
        syncStyleChecks();
      };
    }

    // Row 2 — color
    const colorRow = pop.createDiv({ cls: "lpa-swatches" });
    const syncColorChecks = () => {
      const cur = this.store?.get(h.id)?.color;
      for (const sw of Array.from(colorRow.children) as HTMLElement[]) {
        sw.toggleClass("is-active", sw.dataset.color === cur);
      }
    };
    for (const p of PALETTE) {
      const sw = colorRow.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name } });
      sw.style.background = p.fill;
      sw.dataset.color = p.fill;
      sw.onclick = () => {
        this.store?.update(h.id, { color: p.fill });
        rerender();
        // restyle the style previews to the new ink
        for (const b of Array.from(styleRow.children) as HTMLElement[]) {
          b.style.setProperty("--lpa-ink", p.ink);
          b.style.setProperty("--lpa-fill", p.fill);
        }
        syncColorChecks();
      };
    }

    // Row 3 — actions
    const actions = pop.createDiv({ cls: "lpa-popover-actions" });
    const copyBtn = actions.createEl("button", { text: "Copy" });
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(this.store?.get(h.id)?.text ?? h.text);
      new Notice("Copied mark text");
    };
    const noteBtn = actions.createEl("button", { text: "Note" });
    noteBtn.onclick = () => {
      this.closeMarkPopover();
      this.activateHighlight(h.id, { scrollSidebar: true, focusNote: true });
    };
    const delBtn = actions.createEl("button", { cls: "lpa-danger", text: "Delete" });
    delBtn.onclick = () => {
      this.store?.remove(h.id);
      if (this.activeHighlightId === h.id) this.activeHighlightId = null;
      if (this.hoverHighlightId === h.id) this.hoverHighlightId = null;
      this.closeMarkPopover();
      rerender();
    };

    syncStyleChecks();
    syncColorChecks();

    // Position near the click, clamped into the viewport.
    pop.style.visibility = "hidden";
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const pr = pop.getBoundingClientRect();
    let x = evt.clientX + 6;
    let y = evt.clientY + 10;
    if (x + pr.width > vw - 8) x = Math.max(8, vw - pr.width - 8);
    if (y + pr.height > vh - 8) y = Math.max(8, evt.clientY - pr.height - 10);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    pop.style.visibility = "visible";

    const onDocPointer = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node)) this.closeMarkPopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeMarkPopover();
    };
    // defer so the opening click doesn't immediately dismiss it
    window.setTimeout(() => doc.addEventListener("mousedown", onDocPointer, true), 0);
    doc.addEventListener("keydown", onKey, true);
    this.markPopoverCleanup = () => {
      doc.removeEventListener("mousedown", onDocPointer, true);
      doc.removeEventListener("keydown", onKey, true);
      pop.remove();
    };
  }

  private closeMarkPopover(): void {
    this.markPopoverCleanup?.();
    this.markPopoverCleanup = null;
  }

  /** Scroll to a highlight and flash it (used by markdown back-links, Phase 2). */
  async revealHighlight(
    id: string,
    options: { scrollSidebar?: boolean; focusNote?: boolean } = { scrollSidebar: true }
  ): Promise<void> {
    const h = this.store?.get(id);
    if (!h) return;
    this.activateHighlight(id, {
      scrollSidebar: options.scrollSidebar ?? true,
      focusNote: !!options.focusNote,
    });
    const pv = this.pageViews[h.page];
    if (!pv) return;
    pv.el.scrollIntoView({ block: "center" });
    await this.renderPageContent(pv);
    const div = Array.from(pv.hlLayer.querySelectorAll<HTMLElement>(".lpa-highlight"))
      .find((el) => (el.dataset.hlIds ?? "").split(/\s+/).includes(id));
    if (div) {
      div.addClass("lpa-flash");
      window.setTimeout(() => div.removeClass("lpa-flash"), 1200);
    }
  }

  // ---- legacy import ------------------------------------------------------

  async importLegacyAnnotations(): Promise<void> {
    if (!this.pdfDoc || !this.store || !this.file) {
      new Notice("Open a PDF in the annotator first.");
      return;
    }
    const pdfName = this.file.name.normalize("NFC").toLowerCase();
    const notes = this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as any;
      const tgt = fm?.["annotation-target"];
      if (!tgt) return false;
      const tval = Array.isArray(tgt) ? tgt[0] : tgt;
      return targetBasename(String(tval)) === pdfName;
    });
    if (notes.length === 0) {
      new Notice("No obsidian-annotator notes target this PDF.");
      return;
    }

    const legacy: LegacyAnnotation[] = [];
    for (const n of notes) {
      legacy.push(...parseLegacyNote(await this.app.vault.read(n)).annotations);
    }
    if (legacy.length === 0) {
      new Notice("Found note(s) but no highlights to import.");
      return;
    }

    const notice = new Notice(`Indexing ${this.pdfDoc.numPages} pages…`, 0);
    let docIndex;
    try {
      docIndex = await buildDocIndex(this.pdfDoc, (d, t) => {
        if (d % 25 === 0 || d === t) notice.setMessage(`Indexing pages ${d}/${t}…`);
      });
    } catch (e: any) {
      notice.hide();
      console.error(`${LOG_TAG} legacy import indexing failed`, e);
      new Notice("Import failed while indexing the PDF (see console).");
      return;
    }

    const seen = new Set(
      this.store.doc.highlights.map((h) => `${h.page}|${dedupeKey(h.text)}`)
    );
    const created: Highlight[] = [];
    const affected = new Set<number>();
    let matched = 0;
    const unmatched: string[] = [];

    for (const a of legacy) {
      const results = anchorQuote(docIndex, a.exact, a.prefix, a.suffix);
      if (results.length === 0) {
        unmatched.push(a.exact);
        continue;
      }
      matched++;
      const cleanText = a.exact.replace(/\s+/g, " ").trim();
      for (const r of results) {
        const key = `${r.page}|${dedupeKey(cleanText)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        created.push({
          id: newId(),
          page: r.page,
          color: this.currentColor,
          text: cleanText,
          note: a.note,
          rects: r.rects,
          created: a.created ?? new Date().toISOString(),
          source: "import",
          context: { prefix: a.prefix, suffix: a.suffix },
        });
        affected.add(r.page);
      }
    }

    notice.hide();
    if (created.length === 0) {
      new Notice(`Nothing new to import (matched ${matched}/${legacy.length}; already present).`);
      return;
    }
    this.store.addMany(created);
    await this.store.flush();
    for (const p of affected) {
      const pv = this.pageViews[p];
      if (pv?.rendered) this.renderHighlights(pv);
    }
    this.renderAnnotationSidebar();
    new Notice(
      `Imported ${created.length} highlight(s) from ${notes.length} note(s). ` +
        `Matched ${matched}/${legacy.length}` +
        (unmatched.length ? `, ${unmatched.length} unmatched (see console).` : ".")
    );
    if (unmatched.length) {
      console.warn(`${LOG_TAG} ${unmatched.length} legacy quote(s) could not be anchored:`);
      unmatched.forEach((u) => console.warn("  •", u.slice(0, 90).replace(/\s+/g, " ")));
    }
  }

  // ---- zoom ---------------------------------------------------------------

  private zoomBy(factor: number): void {
    this.setScale(this.scale * factor);
  }

  private setScale(next: number): void {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (Math.abs(clamped - this.scale) < 1e-3) return;
    this.closeMarkPopover();

    const anchorIdx = [...this.visible].sort((a, b) => a - b)[0] ?? 0;
    const anchor = this.pageViews[anchorIdx];
    const scroller = this.pagesEl;
    let within = 0;
    if (anchor) {
      const oldH = anchor.el.offsetHeight || 1;
      within = (scroller.scrollTop - anchor.el.offsetTop) / oldH;
    }

    this.scale = clamped;
    this.renderEpoch++;

    for (const pv of this.pageViews) {
      this.teardownPageContent(pv);
      const sz = this.pageSizes[pv.index] ?? this.defaultSize;
      pv.el.style.width = `${Math.floor(sz.w * this.scale)}px`;
      pv.el.style.height = `${Math.floor(sz.h * this.scale)}px`;
    }

    if (anchor) {
      scroller.scrollTop = anchor.el.offsetTop + within * (anchor.el.offsetHeight || 1);
    }

    for (const idx of this.visible) {
      const pv = this.pageViews[idx];
      if (pv) void this.renderPageContent(pv);
    }
    this.updateZoomLabel();
  }

  private updateZoomLabel(): void {
    if (this.zoomLabelEl) this.zoomLabelEl.setText(`${Math.round(this.scale * 100)}%`);
  }

  // ---- status helpers -----------------------------------------------------

  private setStatus(msg: string): void {
    this.pagesEl?.empty();
    this.pagesEl?.createDiv({ cls: "lpa-status", text: msg });
    this.renderAnnotationSidebar();
  }
  private setError(msg: string): void {
    this.pagesEl?.empty();
    this.pagesEl?.createDiv({ cls: "lpa-status lpa-error", text: msg });
    this.renderAnnotationSidebar();
    new Notice("Local PDF Annotator: failed to open PDF (see view).");
  }

  // ---- teardown -----------------------------------------------------------

  private clearPagesDom(): void {
    for (const pv of this.pageViews) this.teardownPageContent(pv);
  }

  private teardownDocument(): void {
    this.closeMarkPopover();
    this.renderEpoch++;
    this.io?.disconnect();
    this.io = null;
    this.clearPagesDom();
    this.pageViews = [];
    this.visible.clear();
    this.pageSizes = [];
    this.store = null;
    this.activeHighlightId = null;
    this.hoverHighlightId = null;
    if (this.pdfDoc) {
      try { this.pdfDoc.destroy(); } catch {}
      this.pdfDoc = null;
    }
    if (this.pdfWorker) {
      try { this.pdfWorker.destroy(); } catch {}
      this.pdfWorker = null;
    }
    this.pagesEl?.empty();
    this.renderAnnotationSidebar();
  }
}

function shortAnnotationText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function coalesceHighlightRects(rects: HighlightPaintRect[]): HighlightPaintRect[] {
  const out: HighlightPaintRect[] = [];
  const sorted = [...rects].sort(
    (a, b) => a.color.localeCompare(b.color) || a.top - b.top || a.left - b.left || a.order - b.order
  );

  for (const rect of sorted) {
    let cur = cloneHighlightPaintRect(rect);
    for (;;) {
      const i = out.findIndex((candidate) => canMergeHighlightRects(cur, candidate));
      if (i < 0) break;
      cur = mergeHighlightPaintRects(cur, out[i]);
      out.splice(i, 1);
    }
    out.push(cur);
  }

  return out.sort((a, b) => a.top - b.top || a.left - b.left);
}

function cloneHighlightPaintRect(r: HighlightPaintRect): HighlightPaintRect {
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    color: r.color,
    order: r.order,
    ids: new Set(r.ids),
    notes: new Set(r.notes),
  };
}

function canMergeHighlightRects(a: HighlightPaintRect, b: HighlightPaintRect): boolean {
  if (a.color !== b.color) return false;
  const minHeight = Math.min(a.bottom - a.top, b.bottom - b.top);
  const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (verticalOverlap < Math.max(1, minHeight * 0.45)) return false;

  const aCenter = (a.top + a.bottom) / 2;
  const bCenter = (b.top + b.bottom) / 2;
  if (Math.abs(aCenter - bCenter) > Math.max(2, minHeight * 0.6)) return false;

  const horizontalGap = Math.max(a.left, b.left) - Math.min(a.right, b.right);
  return horizontalGap <= Math.max(2, minHeight * 0.25);
}

function mergeHighlightPaintRects(a: HighlightPaintRect, b: HighlightPaintRect): HighlightPaintRect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
    color: a.color,
    order: Math.min(a.order, b.order),
    ids: new Set([...a.ids, ...b.ids]),
    notes: new Set([...a.notes, ...b.notes]),
  };
}

function occludeHighlightRects(rects: HighlightPaintRect[]): HighlightPaintRect[] {
  const out: HighlightPaintRect[] = [];
  const painted: HighlightPaintRect[] = [];
  const sorted = [...rects].sort((a, b) => a.order - b.order || a.top - b.top || a.left - b.left);

  for (const rect of sorted) {
    let pieces = [cloneHighlightPaintRect(rect)];
    for (const blocker of painted) {
      const next: HighlightPaintRect[] = [];
      for (const piece of pieces) next.push(...subtractHighlightPaintRect(piece, blocker));
      pieces = next;
      if (pieces.length === 0) break;
    }
    out.push(...pieces);
    painted.push(...pieces);
  }

  return out.sort((a, b) => a.top - b.top || a.left - b.left || a.order - b.order);
}

function subtractHighlightPaintRect(
  rect: HighlightPaintRect,
  blocker: HighlightPaintRect
): HighlightPaintRect[] {
  const left = Math.max(rect.left, blocker.left);
  const top = Math.max(rect.top, blocker.top);
  const right = Math.min(rect.right, blocker.right);
  const bottom = Math.min(rect.bottom, blocker.bottom);
  if (right - left <= 0.5 || bottom - top <= 0.5) return [rect];

  const pieces: HighlightPaintRect[] = [];
  pushHighlightPiece(pieces, rect, rect.left, rect.top, rect.right, top);
  pushHighlightPiece(pieces, rect, rect.left, bottom, rect.right, rect.bottom);
  pushHighlightPiece(pieces, rect, rect.left, top, left, bottom);
  pushHighlightPiece(pieces, rect, right, top, rect.right, bottom);
  return pieces;
}

function pushHighlightPiece(
  pieces: HighlightPaintRect[],
  source: HighlightPaintRect,
  left: number,
  top: number,
  right: number,
  bottom: number
): void {
  if (right - left <= 0.5 || bottom - top <= 0.5) return;
  pieces.push({
    left,
    top,
    right,
    bottom,
    color: source.color,
    order: source.order,
    ids: new Set(source.ids),
    notes: new Set(source.notes),
  });
}

interface Rgba { r: number; g: number; b: number; a: number; }

function parseColor(color: string): Rgba | null {
  const rgb = color.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+)\s*)?\)$/i
  );
  if (rgb) {
    return {
      r: clampCssByte(Number(rgb[1])),
      g: clampCssByte(Number(rgb[2])),
      b: clampCssByte(Number(rgb[3])),
      a: rgb[4] === undefined ? 1 : clampCssAlpha(Number(rgb[4])),
    };
  }
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const value = hex[1].length === 3 ? hex[1].split("").map((ch) => ch + ch).join("") : hex[1];
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
      a: 1,
    };
  }
  return null;
}

/** Fill color for a highlight: normalized to the muted palette, alpha-capped so
 * stacked fills can't darken into a muddy patch and text stays readable. */
function highlightPaintColor(color: string): string {
  const fill = resolvePalette(color)?.fill ?? color;
  const c = parseColor(fill);
  if (!c) return fill;
  const a = Math.min(c.a === 1 ? MAX_HIGHLIGHT_ALPHA : c.a, MAX_HIGHLIGHT_ALPHA);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(a)})`;
}

/** Crisp stroke color for line/box styles when a stored color has no palette
 * entry (custom colors): darken the hue and make it near-opaque. */
function markInkColor(color: string): string {
  const c = parseColor(color);
  if (!c) return color;
  const k = 0.62;
  return `rgba(${Math.round(c.r * k)}, ${Math.round(c.g * k)}, ${Math.round(c.b * k)}, 0.95)`;
}

function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(alpha)})`;
}

function clampCssByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampCssAlpha(value: number): number {
  if (!Number.isFinite(value)) return MAX_HIGHLIGHT_ALPHA;
  return Math.min(1, Math.max(0, value));
}

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Merge a mark's viewport rects into one continuous rect per visual line, so a
 * decorative stroke (underline/strike/box) is unbroken across word gaps and
 * wraps cleanly line-by-line.
 */
function mergeLineRects(
  rects: Array<{ left: number; top: number; right: number; bottom: number }>
): Array<{ left: number; top: number; right: number; bottom: number }> {
  const clean = rects.filter((r) => r.right - r.left >= 0.5 && r.bottom - r.top >= 0.5);
  const lines: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  for (const r of [...clean].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const rCenter = (r.top + r.bottom) / 2;
    const minH = r.bottom - r.top;
    const line = lines.find((l) => {
      const lCenter = (l.top + l.bottom) / 2;
      const h = Math.min(minH, l.bottom - l.top);
      const overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top);
      return overlap >= h * 0.5 && Math.abs(lCenter - rCenter) <= Math.max(2, h * 0.6);
    });
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ ...r });
    }
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

/**
 * Build a tiny WYSIWYG preview of a mark style inside a chooser button: the
 * letter "A" wearing that exact decoration, in the current ink. Lets the chooser
 * present style and color as two small additive rows (no style×color grid).
 */
function buildStylePreview(btn: HTMLElement, style: MarkStyle): void {
  btn.empty();
  const s = btn.createSpan({ cls: `lpa-style-sample lpa-style-sample--${style}`, text: "A" });
  s.setAttribute("aria-hidden", "true");
}

function highlightIdsForElement(el: HTMLElement): string[] {
  return (el.dataset.hlIds ?? "").split(/\s+/).filter(Boolean);
}

function cssEscape(value: string): string {
  const escape = typeof CSS !== "undefined" ? (CSS as any).escape : null;
  if (typeof escape === "function") return escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function dedupeKey(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase().slice(0, 80);
}
