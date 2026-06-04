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
import { FileView, TFile, WorkspaceLeaf, Notice, Menu } from "obsidian";
import { pdfjsLib, initPdfEngine, getPdfEngineStatus, createDedicatedWorker, LOG_TAG } from "./pdf-engine";
import {
  AnnotationStore,
  DEFAULT_COLOR,
  HL_COLORS,
  newId,
  sidecarPathFor,
  type Highlight,
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

  private pdfDoc: any | null = null;
  private pdfWorker: any | null = null;
  private store: AnnotationStore | null = null;
  private currentColor = DEFAULT_COLOR;

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

    // color swatches (active color for new highlights)
    const swatches = this.toolbarEl.createDiv({ cls: "lpa-swatches" });
    this.swatchEls = [];
    for (const [name, value] of Object.entries(HL_COLORS)) {
      const sw = swatches.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": name } });
      sw.style.background = value;
      sw.dataset.color = value;
      sw.onclick = () => this.setActiveColor(value);
      this.swatchEls.push(sw);
    }
    this.setActiveColor(this.currentColor);

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
      const color = head.createDiv({ cls: "lpa-annotation-color" });
      color.style.background = highlightPaintColor(h.color);
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
    const rects: HighlightPaintRect[] = [];
    let order = 0;
    for (const h of this.store.byPage(pv.index)) {
      order++;
      for (const r of h.rects) {
        const a = vp.convertToViewportPoint(r.x1, r.y1);
        const b = vp.convertToViewportPoint(r.x2, r.y2);
        const left = Math.min(a[0], b[0]);
        const top = Math.min(a[1], b[1]);
        const right = Math.max(a[0], b[0]);
        const bottom = Math.max(a[1], b[1]);
        if (right - left < 0.5 || bottom - top < 0.5) continue;
        rects.push({
          left,
          top,
          right,
          bottom,
          color: h.color,
          order,
          ids: new Set([h.id]),
          notes: h.note ? new Set([h.note]) : new Set(),
        });
      }
    }
    for (const r of occludeHighlightRects(coalesceHighlightRects(rects))) {
      const div = pv.hlLayer.createDiv({ cls: "lpa-highlight" });
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
        id: newId(), page: pageIndex, color: this.currentColor, text,
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
      this.showHighlightMenu(hit.highlight, evt, hit.pageView);
    }
  }

  private showHighlightMenu(h: Highlight, evt: MouseEvent, pv: PageView): void {
    const menu = new Menu();
    const preview = h.text.replace(/\s+/g, " ").trim();
    menu.addItem((i) =>
      i.setTitle(preview.length > 48 ? `“${preview.slice(0, 47)}…”` : `“${preview}”`)
        .setIcon("quote-glyph")
        .setDisabled(true)
    );
    menu.addSeparator();
    for (const [name, value] of Object.entries(HL_COLORS)) {
      menu.addItem((i) =>
        i.setTitle(name[0].toUpperCase() + name.slice(1))
          .setChecked(h.color === value)
          .onClick(() => {
            this.store?.update(h.id, { color: value });
            this.renderHighlights(pv);
            this.renderAnnotationSidebar();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Copy text").setIcon("copy").onClick(async () => {
        await navigator.clipboard.writeText(h.text);
        new Notice("Copied highlight text");
      })
    );
    menu.addItem((i) =>
      i.setTitle("Delete highlight").setIcon("trash").onClick(() => {
        this.store?.remove(h.id);
        if (this.activeHighlightId === h.id) this.activeHighlightId = null;
        if (this.hoverHighlightId === h.id) this.hoverHighlightId = null;
        this.renderHighlights(pv);
        this.renderAnnotationSidebar();
      })
    );
    menu.showAtMouseEvent(evt);
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

function highlightPaintColor(color: string): string {
  const rgb = color.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+)\s*)?\)$/i
  );
  if (rgb) {
    const r = clampCssByte(Number(rgb[1]));
    const g = clampCssByte(Number(rgb[2]));
    const b = clampCssByte(Number(rgb[3]));
    const alpha = rgb[4] === undefined ? MAX_HIGHLIGHT_ALPHA : Math.min(Number(rgb[4]), MAX_HIGHLIGHT_ALPHA);
    return `rgba(${r}, ${g}, ${b}, ${clampCssAlpha(alpha)})`;
  }

  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const value = hex[1].length === 3
      ? hex[1].split("").map((ch) => ch + ch).join("")
      : hex[1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${MAX_HIGHLIGHT_ALPHA})`;
  }

  return color;
}

function clampCssByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampCssAlpha(value: number): number {
  if (!Number.isFinite(value)) return MAX_HIGHLIGHT_ALPHA;
  return Math.min(1, Math.max(0, value));
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
