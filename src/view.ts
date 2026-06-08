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
const MAX_HIGHLIGHT_ALPHA = 0.46;
const MIN_INTERACTION_MARGIN = 96;
const ACTIVE_RUN_CLASSES = ["lpa-run-single", "lpa-run-first", "lpa-run-middle", "lpa-run-last"] as const;
const RUBBER_HANDLE_FEEL = {
  INTENT_RADIUS: 28,
  DWELL_MS: 560,
  DECAY_MS: 250,
  SNAP_THRESHOLD: 1,
  CLOSE_DELAY: 180,
  SAFE_CORRIDOR_PAD: 22,
  REST_WIDTH: 4,
  ACTIVE_WIDTH: 7,
} as const;

interface Size {
  w: number;
  h: number;
}

interface PageView {
  index: number;
  el: HTMLElement;
  hlLayer: HTMLElement;
  noteLayer: HTMLElement;
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

interface AnnotationAnchor {
  side: "left" | "right";
  sourceX: number;
  sourceY: number;
  idealY: number;
  sourceWidth: number;
  sourceHeight: number;
  pageLeftX: number;
  pageRightX: number;
}

interface SelectionActionAnchor {
  x: number;
  y: number;
  height: number;
  side: "left" | "right";
}

interface PendingSelection {
  text: string;
  byPage: Map<number, PdfRect[]>;
  anchor: SelectionActionAnchor;
}

interface MarginGeometry {
  leftWidth: number;
  rightWidth: number;
  pageLeftX: number;
  pageRightX: number;
}

export class PdfAnnotatorView extends FileView {
  private rootEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;
  private statusDotEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private pagesEl!: HTMLElement;
  private leftMarginEl!: HTMLElement;
  private rightMarginEl!: HTMLElement;
  private connectionSvg!: SVGSVGElement;
  private annotationCountEl!: HTMLElement;
  private tagModeBtnEl!: HTMLButtonElement;
  private annotationsBtnEl!: HTMLButtonElement;
  private rollEl!: HTMLElement;
  private rollMetaEl!: HTMLElement;
  private rollSearchEl!: HTMLInputElement;
  private rollListEl!: HTMLElement;
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
  private tagPlacementMode = false;
  private rollOpen = false;
  private rollSearchQuery = "";
  private marginLayoutRaf: number | null = null;
  private marginResizeObserver: ResizeObserver | null = null;
  private marginGeometry: MarginGeometry = { leftWidth: 0, rightWidth: 0, pageLeftX: 0, pageRightX: 0 };
  private hoverClearTimer: number | null = null;
  private scrollSettleTimer: number | null = null;
  private rollScrollRaf: number | null = null;
  private rollScrollVelocity = 0;
  private lastVisibleKey = "";
  private pendingSelection: PendingSelection | null = null;
  private rubberHandle: RubberHandle | null = null;
  private selectionPopoverEl: HTMLElement | null = null;

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
    this.rubberHandle = new RubberHandle(this.contentEl.ownerDocument);
    this.rubberHandle.onSnap(() => this.openSelectionActionPopup());
    this.rubberHandle.onRequestClose(() => this.closeSelectionActionPopup());
    // Capture text selections / highlight clicks. Auto-removed on unload.
    this.registerDomEvent(this.rootEl, "pointerdown", (evt) => this.onRootPointerDown(evt as PointerEvent));
    this.registerDomEvent(this.contentEl.ownerDocument, "pointerdown", (evt) => this.onDocumentPointerDown(evt as PointerEvent));
    this.registerDomEvent(this.contentEl.ownerDocument, "selectionchange", () => this.onDocumentSelectionChange());
    this.registerDomEvent(this.pagesEl, "mouseup", (evt) => this.onMouseUp(evt));
    this.registerDomEvent(this.pagesEl, "click", (evt) => this.onPagesClick(evt));
    this.registerDomEvent(this.pagesEl, "mousemove", (evt) => this.onPageMouseMove(evt));
    this.registerDomEvent(this.pagesEl, "mouseleave", () => this.clearHoveredHighlightSoon());
    this.registerDomEvent(this.pagesEl, "scroll", () => this.onPdfScroll());
    this.registerDomEvent(this.rollListEl, "wheel", (evt) => this.onRollWheel(evt as WheelEvent));
    this.registerDomEvent(window, "resize", () => this.scheduleMarginLayout());
    this.marginResizeObserver = new ResizeObserver(() => this.scheduleMarginLayout());
    this.marginResizeObserver.observe(this.bodyEl);
    this.marginResizeObserver.observe(this.pagesEl);
    this.register(() => {
      this.marginResizeObserver?.disconnect();
      this.marginResizeObserver = null;
      this.stopRollScroll();
      this.rubberHandle?.destroy();
      this.rubberHandle = null;
    });
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
    this.toolbarEl = this.rootEl.createDiv({ cls: "lpa-toolbar", attr: { "aria-label": "PDF annotation controls" } });
    this.titleEl = this.toolbarEl.createSpan({ cls: "lpa-title", text: "PDF Annotator" });
    this.zoomLabelEl = this.toolbarEl.createSpan({ cls: "lpa-zoom-label", text: "125%" });
    this.statusDotEl = this.toolbarEl.createSpan({ cls: "lpa-status-dot" });
    this.annotationCountEl = this.toolbarEl.createSpan({ cls: "lpa-annotation-count", text: "0 annotations" });
    this.swatchEls = [];
    this.styleBtnEls = [];
    this.setActiveColor(this.currentColor);
    this.setActiveStyle(this.currentStyle);
    this.refreshStatusDot();

    this.tagModeBtnEl = this.toolbarEl.createEl("button", {
      text: "Tag",
      attr: { "aria-label": "Place a page note tag" },
    }) as HTMLButtonElement;
    this.tagModeBtnEl.onclick = () => this.setTagPlacementMode(!this.tagPlacementMode);

    this.annotationsBtnEl = this.toolbarEl.createEl("button", {
      text: "Annotations",
      attr: { "aria-label": "Show searchable annotations" },
    }) as HTMLButtonElement;
    this.annotationsBtnEl.onclick = () => this.setRollOpen(!this.rollOpen);

    this.rollEl = this.rootEl.createDiv({ cls: "lpa-roll is-hidden" });
    const rollHead = this.rollEl.createDiv({ cls: "lpa-roll-head" });
    rollHead.createDiv({ cls: "lpa-roll-title", text: "Annotations" });
    this.rollMetaEl = rollHead.createDiv({ cls: "lpa-roll-meta", text: "0" });
    this.rollSearchEl = rollHead.createEl("input", {
      cls: "lpa-roll-search",
      attr: { type: "search", placeholder: "Search annotations", "aria-label": "Search annotations" },
    });
    this.rollSearchEl.oninput = () => {
      this.rollSearchQuery = this.rollSearchEl.value;
      this.renderAnnotationRollList();
    };
    const closeRoll = rollHead.createEl("button", {
      cls: "lpa-roll-close",
      text: "×",
      attr: { "aria-label": "Hide annotations" },
    });
    closeRoll.onclick = () => this.setRollOpen(false);
    this.rollListEl = this.rollEl.createDiv({ cls: "lpa-roll-list" });

    this.bodyEl = this.rootEl.createDiv({ cls: "lpa-body" });
    this.leftMarginEl = this.bodyEl.createDiv({ cls: "lpa-margin lpa-margin-left", attr: { "aria-label": "Left annotations" } });
    this.pagesEl = this.bodyEl.createDiv({ cls: "lpa-pages" });
    this.rightMarginEl = this.bodyEl.createDiv({ cls: "lpa-margin lpa-margin-right", attr: { "aria-label": "Right annotations" } });
    this.connectionSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.connectionSvg.classList.add("lpa-connection-layer");
    this.connectionSvg.setAttribute("aria-hidden", "true");
    this.bodyEl.appendChild(this.connectionSvg);
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

  private setTagPlacementMode(on: boolean): void {
    this.tagPlacementMode = on;
    this.rootEl?.toggleClass("is-tag-mode", on);
    this.tagModeBtnEl?.toggleClass("is-active", on);
    this.tagModeBtnEl?.setAttribute("aria-pressed", on ? "true" : "false");
  }

  private setRollOpen(on: boolean): void {
    this.rollOpen = on;
    this.rollEl?.toggleClass("is-hidden", !on);
    this.annotationsBtnEl?.toggleClass("is-active", on);
    this.annotationsBtnEl?.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) this.renderAnnotationRollList();
  }

  private onRootPointerDown(evt: PointerEvent): void {
    if (!this.isSelectionActionTarget(evt.target)) this.hideSelectionActions(false);
    if (this.shouldPreserveActiveSelection(evt)) return;
    this.clearActiveSelection();
  }

  private onDocumentPointerDown(evt: PointerEvent): void {
    if (!this.activeHighlightId) return;
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    if (this.rootEl?.contains(target)) return;
    if (target.closest(".lpa-mark-popover, .lpa-selection-popover, .lpa-rubber-handle")) return;
    this.clearActiveSelection();
  }

  private shouldPreserveActiveSelection(evt: PointerEvent): boolean {
    if (!this.activeHighlightId) return true;
    if (evt.button !== 0) return true;
    const target = evt.target as HTMLElement | null;
    if (!target) return false;
    if (target.closest(".lpa-page-tag, .lpa-margin-card, .lpa-roll-item, .lpa-mark-popover, .lpa-selection-popover, .lpa-rubber-handle")) return true;
    if (target.closest("textarea,input,select,button,[contenteditable='true']")) return true;
    if (target.closest(".lpa-toolbar, .lpa-roll-head")) return true;
    return false;
  }

  private isSelectionActionTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && !!target.closest(".lpa-selection-popover, .lpa-rubber-handle");
  }

  private clearActiveSelection(): void {
    if (!this.activeHighlightId) return;
    this.activateHighlight(null);
    this.closeMarkPopover();
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
      const noteLayer = el.createDiv({ cls: "lpa-note-layer" });
      const pv: PageView = {
        index: i, el, hlLayer, noteLayer, canvas: null, textLayerEl: null,
        page: i === 0 ? p1 : null, rendered: false, rendering: false, renderTask: null, textTask: null,
      };
      this.pageViews.push(pv);
      this.io.observe(el);
    }
    this.updateZoomLabel();
  }

  private renderAnnotationSidebar(): void {
    if (!this.leftMarginEl || !this.rightMarginEl || !this.annotationCountEl) return;
    this.updateElasticMargins();
    this.leftMarginEl.empty();
    this.rightMarginEl.empty();

    const annotations = [...(this.store?.doc.highlights ?? [])].sort(
      (a, b) => a.page - b.page || a.created.localeCompare(b.created)
    );
    const ids = new Set(annotations.map((h) => h.id));
    if (this.activeHighlightId && !ids.has(this.activeHighlightId)) this.activeHighlightId = null;
    if (this.hoverHighlightId && !ids.has(this.hoverHighlightId)) this.hoverHighlightId = null;
    this.annotationCountEl.setText(`${annotations.length} ${annotations.length === 1 ? "annotation" : "annotations"}`);

    for (const h of annotations) {
      const type = annotationTypeOf(h);
      if (type === "highlight" && !highlightHasMarginCard(h)) continue;
      const anchor = this.computeAnnotationAnchor(h);
      if (!anchor) continue;
      const pinned = !!h.isPinned;
      if (type === "tag" && !pinned && this.hoverHighlightId !== h.id && this.activeHighlightId !== h.id) continue;

      const margin = anchor.side === "left" ? this.leftMarginEl : this.rightMarginEl;
      const card = this.createMarginCard(margin, h, anchor.side);
      card.style.top = `${Math.max(0, anchor.idealY)}px`;
    }
    this.renderAnnotationRollList();
    this.syncHighlightBindingState();
    this.scheduleMarginLayout();
  }

  private renderAnnotationRollList(): void {
    if (!this.rollListEl || !this.rollMetaEl) return;
    const annotations = [...(this.store?.doc.highlights ?? [])].sort(
      (a, b) => a.page - b.page || a.created.localeCompare(b.created)
    );
    const query = normalizeSearch(this.rollSearchQuery);
    const filtered = query
      ? annotations.filter((h) => annotationMatchesSearch(h, query))
      : annotations;

    this.rollMetaEl.setText(
      query
        ? `${filtered.length}/${annotations.length}`
        : `${annotations.length} ${annotations.length === 1 ? "annotation" : "annotations"}`
    );
    if (this.rollSearchEl && this.rollSearchEl.value !== this.rollSearchQuery) {
      this.rollSearchEl.value = this.rollSearchQuery;
    }

    this.rollListEl.empty();
    if (!this.store) {
      this.rollListEl.createDiv({ cls: "lpa-roll-empty", text: "Open a PDF to view annotations." });
      return;
    }
    if (annotations.length === 0) {
      this.rollListEl.createDiv({ cls: "lpa-roll-empty", text: "No annotations yet." });
      return;
    }
    if (filtered.length === 0) {
      this.rollListEl.createDiv({ cls: "lpa-roll-empty", text: "No matching annotations." });
      return;
    }

    for (const h of filtered) this.createRollItem(h);
    this.syncHighlightBindingState();
  }

  private createRollItem(h: Highlight): HTMLElement {
    const type = annotationTypeOf(h);
    const pal = resolvePalette(annotationColor(h));
    const accent = pal?.ink ?? markInkColor(annotationColor(h));
    const item = this.rollListEl.createDiv({ cls: `lpa-roll-item lpa-roll-item--${type}` });
    item.dataset.hlId = h.id;
    item.dataset.annotationId = h.id;
    item.style.setProperty("--lpa-accent", accent);
    item.toggleClass("is-active", h.id === this.activeHighlightId);
    item.toggleClass("is-hover", h.id === this.hoverHighlightId);

    item.addEventListener("mouseenter", () => this.setHoveredHighlight(h.id));
    item.addEventListener("mouseleave", () => this.clearHoveredHighlightSoon(h.id));
    item.addEventListener("contextmenu", (evt) => this.openAnnotationContextMenu(evt, h.id));
    item.onclick = () => void this.revealHighlight(h.id, { scrollSidebar: true });

    const head = item.createDiv({ cls: "lpa-roll-item-head" });
    head.createSpan({ cls: "lpa-roll-dot", attr: { "aria-hidden": "true" } });
    head.createSpan({ cls: "lpa-roll-page", text: `p.${h.page + 1}` });
    head.createSpan({ cls: "lpa-roll-kind", text: annotationKindLabel(h) });
    if (h.isPinned) head.createSpan({ cls: "lpa-roll-pin", text: "pinned" });

    item.createDiv({ cls: "lpa-roll-note", text: rollPrimaryText(h) });
    const secondary = rollSecondaryText(h);
    if (secondary) item.createDiv({ cls: "lpa-roll-source", text: secondary });
    return item;
  }

  private createMarginCard(margin: HTMLElement, h: Highlight, side: "left" | "right"): HTMLElement {
    const type = annotationTypeOf(h);
    const pal = resolvePalette(annotationColor(h));
    const accent = pal?.ink ?? markInkColor(annotationColor(h));
    const card = margin.createDiv({ cls: `lpa-margin-card lpa-margin-card--${type}` });
    card.dataset.hlId = h.id;
    card.dataset.annotationId = h.id;
    card.dataset.side = side;
    card.style.setProperty("--lpa-accent", accent);
    card.style.setProperty("--lpa-sticker-bg", stickerBackgroundColor(annotationColor(h), 0.34));
    card.style.setProperty("--lpa-sticker-bg-strong", stickerBackgroundColor(annotationColor(h), 0.52));
    card.toggleClass("is-pinned", !!h.isPinned);
    card.toggleClass("is-active", h.id === this.activeHighlightId);
    card.toggleClass("is-hover", h.id === this.hoverHighlightId);
    card.toggleClass("is-expanded", !!h.isPinned || h.id === this.activeHighlightId || h.id === this.hoverHighlightId);

    card.addEventListener("mouseenter", () => this.setHoveredHighlight(h.id));
    card.addEventListener("mouseleave", () => this.clearHoveredHighlightSoon(h.id));
    card.addEventListener("contextmenu", (evt) => this.openAnnotationContextMenu(evt, h.id));
    card.addEventListener("click", (evt) => {
      const target = evt.target as HTMLElement | null;
      if (target?.closest("textarea,button")) return;
      void this.revealHighlight(h.id, { scrollSidebar: false });
    });
    card.addEventListener("dblclick", (evt) => {
      evt.preventDefault();
      this.activateHighlight(h.id, { focusNote: true });
    });

    const head = card.createDiv({ cls: "lpa-margin-card-head" });
    head.createSpan({ cls: "lpa-margin-dot", attr: { "aria-hidden": "true" } });
    head.createSpan({ cls: "lpa-margin-page", text: `p.${h.page + 1}` });
    const pin = head.createEl("button", {
      cls: "lpa-pin-btn",
      text: "⌖",
      attr: {
        "aria-label": h.isPinned ? "Unpin annotation card" : "Pin annotation card",
        title: h.isPinned ? "Unpin" : "Pin",
      },
    });
    pin.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.toggleAnnotationPin(h.id);
    };

    const note = card.createEl("textarea", {
      cls: "lpa-margin-note",
      attr: {
        placeholder: type === "tag" ? "Page note" : "Note",
        rows: "2",
        "aria-label": type === "tag" ? "Page note" : "Annotation note",
      },
    });
    note.value = h.note ?? "";
    note.onfocus = () => this.activateHighlight(h.id);
    note.oninput = () => {
      this.store?.update(h.id, { note: note.value });
      const pv = this.pageViews[h.page];
      if (pv?.rendered) {
        this.renderHighlights(pv);
        this.renderTags(pv);
      }
      this.renderAnnotationRollList();
      this.scheduleMarginLayout();
    };

    if (type === "highlight") {
      card.createDiv({ cls: "lpa-margin-source", text: shortAnnotationText(h.text, 180) });
    }

    const cjk = card.createEl("textarea", {
      cls: "lpa-margin-cjk",
      attr: { placeholder: "CJK note", rows: "2", "aria-label": "Secondary CJK annotation" },
    });
    cjk.value = h.noteContentCJK ?? "";
    cjk.onfocus = () => this.activateHighlight(h.id);
    cjk.oninput = () => {
      this.store?.update(h.id, { noteContentCJK: cjk.value.trim() ? cjk.value : undefined });
      this.renderAnnotationRollList();
      this.scheduleMarginLayout();
    };

    return card;
  }

  private activateHighlight(
    id: string | null,
    options: { scrollSidebar?: boolean; focusNote?: boolean } = {}
  ): void {
    const prev = this.activeHighlightId;
    this.activeHighlightId = id;
    if (id && !this.store?.get(id)) this.activeHighlightId = null;
    const needsRender =
      this.dynamicTagCardDependsOn(prev) ||
      this.dynamicTagCardDependsOn(this.activeHighlightId) ||
      (!!this.activeHighlightId && !this.sidebarCardFor(this.activeHighlightId));
    if (needsRender) this.renderAnnotationSidebar();
    this.syncHighlightBindingState();
    if (this.activeHighlightId && options.scrollSidebar) {
      this.scrollSidebarCard(this.activeHighlightId, !!options.focusNote);
    } else if (this.activeHighlightId && options.focusNote) {
      this.focusSidebarNote(this.activeHighlightId);
    }
    if (this.activeHighlightId && this.rollOpen) this.scrollRollItem(this.activeHighlightId);
  }

  private setHoveredHighlight(id: string | null): void {
    if (this.hoverClearTimer !== null) {
      window.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
    const next = id && this.store?.get(id) ? id : null;
    if (this.hoverHighlightId === next) return;
    const prev = this.hoverHighlightId;
    this.hoverHighlightId = next;
    if (this.dynamicTagCardDependsOn(prev) || this.dynamicTagCardDependsOn(next)) {
      this.renderAnnotationSidebar();
    }
    this.syncHighlightBindingState();
  }

  private clearHoveredHighlightSoon(id?: string): void {
    if (this.hoverClearTimer !== null) window.clearTimeout(this.hoverClearTimer);
    this.hoverClearTimer = window.setTimeout(() => {
      this.hoverClearTimer = null;
      if (!id || this.hoverHighlightId === id) this.setHoveredHighlight(null);
    }, 120);
  }

  private dynamicTagCardDependsOn(id: string | null): boolean {
    if (!id) return false;
    const h = this.store?.get(id);
    return !!h && annotationTypeOf(h) === "tag" && !h.isPinned;
  }

  private syncHighlightBindingState(): void {
    this.rootEl?.toggleClass("has-active-highlight", !!this.activeHighlightId);
    if (this.bodyEl) {
      for (const item of this.bodyEl.querySelectorAll<HTMLElement>(".lpa-margin-card")) {
        const id = item.dataset.hlId ?? "";
        item.toggleClass("is-active", !!id && id === this.activeHighlightId);
        item.toggleClass("is-hover", !!id && id === this.hoverHighlightId);
        item.toggleClass("is-expanded", !!id && (id === this.activeHighlightId || id === this.hoverHighlightId || !!this.store?.get(id)?.isPinned));
      }
    }
    if (this.rootEl) {
      for (const item of this.rootEl.querySelectorAll<HTMLElement>(".lpa-roll-item")) {
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
      for (const tag of this.pagesEl.querySelectorAll<HTMLElement>(".lpa-page-tag")) {
        const id = tag.dataset.hlId ?? "";
        tag.toggleClass("is-active", !!id && id === this.activeHighlightId);
        tag.toggleClass("is-hover", !!id && id === this.hoverHighlightId);
        tag.toggleClass("is-pinned", !!id && !!this.store?.get(id)?.isPinned);
      }
      this.syncActiveRunShape();
    }
    this.scheduleMarginLayout();
  }

  private syncActiveRunShape(): void {
    if (!this.pagesEl) return;
    const marks = Array.from(this.pagesEl.querySelectorAll<HTMLElement>(".lpa-highlight"));
    for (const mark of marks) mark.removeClasses([...ACTIVE_RUN_CLASSES]);
    // Hover and active share one visual language: whichever passage is engaged
    // gets the rounded-outer-corner + inter-line-bridge run shape so it reads as
    // a single elegant chunk. Active is simply the persistent version of hover.
    const ids: string[] = [];
    if (this.activeHighlightId) ids.push(this.activeHighlightId);
    if (this.hoverHighlightId && this.hoverHighlightId !== this.activeHighlightId) {
      ids.push(this.hoverHighlightId);
    }
    for (const id of ids) this.applyRunShapeForId(marks, id);
  }

  /** Tag the line-rects of one highlight as a run (single / first / middle /
   * last) so CSS can round only the outer corners and bridge the line gaps. */
  private applyRunShapeForId(marks: HTMLElement[], id: string): void {
    const runMarks = marks
      .filter((mark) => !ACTIVE_RUN_CLASSES.some((c) => mark.hasClass(c)))
      .filter((mark) => highlightIdsForElement(mark).includes(id))
      .map((mark) => {
        const rect = mark.getBoundingClientRect();
        const page = Number(mark.closest<HTMLElement>(".lpa-page")?.dataset.index ?? 0);
        return { mark, rect, page, centerY: (rect.top + rect.bottom) / 2 };
      })
      .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => a.page - b.page || a.centerY - b.centerY || a.rect.left - b.rect.left);
    if (!runMarks.length) return;

    const groups: Array<typeof runMarks> = [];
    for (const item of runMarks) {
      const group = groups[groups.length - 1];
      const prev = group?.[0];
      const sameLine = !!prev && item.page === prev.page && Math.abs(item.centerY - prev.centerY) <= Math.max(4, Math.min(item.rect.height, prev.rect.height) * 0.55);
      if (sameLine) group.push(item);
      else groups.push([item]);
    }

    if (groups.length === 1) {
      for (const item of groups[0]) item.mark.addClass("lpa-run-single");
      return;
    }
    groups.forEach((group, index) => {
      const cls = index === 0 ? "lpa-run-first" : index === groups.length - 1 ? "lpa-run-last" : "lpa-run-middle";
      for (const item of group) item.mark.addClass(cls);
    });
  }

  private scrollSidebarCard(id: string, focusNote: boolean): void {
    let item = this.sidebarCardFor(id);
    if (!item) {
      this.renderAnnotationSidebar();
      item = this.sidebarCardFor(id);
    }
    if (!item) return;
    item.addClass("lpa-card-flash");
    window.setTimeout(() => item.removeClass("lpa-card-flash"), 1000);
    if (focusNote) this.focusSidebarNote(id);
  }

  private focusSidebarNote(id: string): void {
    window.setTimeout(() => {
      const note = this.sidebarCardFor(id)?.querySelector<HTMLTextAreaElement>(".lpa-margin-note");
      note?.focus({ preventScroll: true });
      if (note) note.selectionStart = note.selectionEnd = note.value.length;
    }, 0);
  }

  private scrollRollItem(id: string): void {
    window.setTimeout(() => {
      const item = this.rollListEl?.querySelector<HTMLElement>(
        `.lpa-roll-item[data-hl-id="${cssEscape(id)}"]`
      );
      item?.scrollIntoView({ block: "nearest", inline: "center" });
    }, 0);
  }

  private onRollWheel(evt: WheelEvent): void {
    if (!this.rollListEl) return;
    const delta = Math.abs(evt.deltaX) > Math.abs(evt.deltaY) ? evt.deltaX : evt.deltaY;
    if (Math.abs(delta) < 0.5 || this.rollListEl.scrollWidth <= this.rollListEl.clientWidth) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.rollScrollVelocity = clamp(-1800, this.rollScrollVelocity + delta * 0.85, 1800);
    if (this.rollScrollRaf === null) this.animateRollScroll();
  }

  private animateRollScroll(): void {
    this.rollScrollRaf = window.requestAnimationFrame(() => {
      this.rollScrollRaf = null;
      if (!this.rollListEl) return;
      this.rollListEl.scrollLeft += this.rollScrollVelocity * 0.18;
      this.rollScrollVelocity *= 0.74;
      if (Math.abs(this.rollScrollVelocity) >= 0.35) this.animateRollScroll();
      else this.rollScrollVelocity = 0;
    });
  }

  private stopRollScroll(): void {
    if (this.rollScrollRaf !== null) {
      window.cancelAnimationFrame(this.rollScrollRaf);
      this.rollScrollRaf = null;
    }
    this.rollScrollVelocity = 0;
  }

  private sidebarCardFor(id: string): HTMLElement | null {
    return this.bodyEl?.querySelector<HTMLElement>(
      `.lpa-margin-card[data-hl-id="${cssEscape(id)}"]`
    ) ?? null;
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      const idx = Number((entry.target as HTMLElement).dataset.index);
      const pv = this.pageViews[idx];
      if (!pv) continue;
      if (entry.isIntersecting) {
        if (!this.visible.has(idx)) changed = true;
        this.visible.add(idx);
        void this.renderPageContent(pv);
      } else {
        if (this.visible.has(idx)) changed = true;
        this.visible.delete(idx);
        this.teardownPageContent(pv);
      }
    }
    const key = [...this.visible].sort((a, b) => a - b).join(",");
    if (changed || key !== this.lastVisibleKey) {
      this.lastVisibleKey = key;
      this.renderAnnotationSidebar();
    } else {
      this.scheduleMarginLayout();
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
      this.renderTags(pv);
      pv.rendered = true;
      this.renderAnnotationSidebar();
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
    pv.noteLayer.empty();
    pv.rendered = false;
    this.scheduleMarginLayout();
  }

  // ---- highlights ---------------------------------------------------------

  private renderHighlights(pv: PageView): void {
    pv.hlLayer.empty();
    if (!this.store || !pv.page) return;
    const vp = pv.page.getViewport({ scale: this.scale });
    const marks = this.store.byPage(pv.index).filter((h) => annotationTypeOf(h) === "highlight");

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
      div.style.setProperty("--lpa-hl-color-active", activeHighlightPaintColor(r.color));
      div.style.setProperty("--lpa-hl-color-active-gloss", activeHighlightGlossColor(r.color));
      div.style.setProperty("--lpa-hl-color-active-bridge", activeHighlightBridgeColor(r.color));
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
    this.syncActiveRunShape();
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
    el.style.setProperty("--lpa-hl-color-active", activeHighlightPaintColor(h.color));
    el.style.setProperty("--lpa-hl-color-active-gloss", activeHighlightGlossColor(h.color));
    el.style.setProperty("--lpa-hl-color-active-bridge", activeHighlightBridgeColor(h.color));

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

  private renderTags(pv: PageView): void {
    pv.noteLayer.empty();
    if (!this.store || !pv.page) return;
    const tags = this.store.byPage(pv.index).filter((h) => annotationTypeOf(h) === "tag");
    for (const tag of tags) {
      if (!Number.isFinite(tag.tagX) || !Number.isFinite(tag.tagY)) continue;
      const x = clamp(0, tag.tagX ?? 0, 100);
      const y = clamp(0, tag.tagY ?? 0, 100);
      const el = pv.noteLayer.createDiv({ cls: "lpa-page-tag" });
      el.dataset.hlId = tag.id;
      el.dataset.annotationId = tag.id;
      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      el.style.setProperty("--lpa-accent", resolvePalette(annotationColor(tag))?.ink ?? markInkColor(annotationColor(tag)));
      el.toggleClass("is-active", tag.id === this.activeHighlightId);
      el.toggleClass("is-hover", tag.id === this.hoverHighlightId);
      el.toggleClass("is-pinned", !!tag.isPinned);
      el.createSpan({ cls: "lpa-tag-dot", attr: { "aria-hidden": "true" } });
      el.createSpan({ cls: "lpa-tag-preview", text: tagPreview(tag) });
      el.addEventListener("mouseenter", () => this.setHoveredHighlight(tag.id));
      el.addEventListener("mouseleave", () => this.clearHoveredHighlightSoon(tag.id));
      el.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.activateHighlight(tag.id, { focusNote: true });
      });
      el.addEventListener("dblclick", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.activateHighlight(tag.id, { focusNote: true });
      });
      el.addEventListener("contextmenu", (evt) => this.openAnnotationContextMenu(evt, tag.id));
      el.addEventListener("mousedown", (evt) => this.beginTagDrag(evt, tag.id, pv));
    }
    this.scheduleMarginLayout();
  }

  private onDocumentSelectionChange(): void {
    const sel = this.contentEl.ownerDocument.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      this.hideSelectionActions(false);
    }
  }

  private onMouseUp(evt: MouseEvent): void {
    if (!this.store) return;
    if (this.tagPlacementMode) return;
    const doc = this.pagesEl.ownerDocument;
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      const pending = this.snapshotSelection(sel);
      if (pending) this.showSelectionHandle(pending);
      else this.hideSelectionActions(false);
    } else {
      this.hideSelectionActions(false);
      this.handleHighlightClick(evt);
    }
  }

  private onPagesClick(evt: MouseEvent): void {
    if (!this.tagPlacementMode || !this.store) return;
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".lpa-page-tag, .lpa-mark-popover")) return;
    const created = this.createTagAtPoint(evt.clientX, evt.clientY);
    if (!created) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.setTagPlacementMode(false);
    this.activateHighlight(created.id, { scrollSidebar: true, focusNote: true });
  }

  private createTagAtPoint(clientX: number, clientY: number): Highlight | null {
    if (!this.store) return null;
    const pv = this.pageViewAtPoint(clientX, clientY);
    if (!pv) return null;
    const pageRect = pv.el.getBoundingClientRect();
    const xPct = clamp(0, ((clientX - pageRect.left) / Math.max(1, pageRect.width)) * 100, 100);
    const yPct = clamp(0, ((clientY - pageRect.top) / Math.max(1, pageRect.height)) * 100, 100);
    const tag: Highlight = {
      id: newId(),
      type: "tag",
      page: pv.index,
      color: this.currentColor,
      tagColor: this.currentColor,
      tagX: xPct,
      tagY: yPct,
      text: "",
      note: "",
      rects: [],
      created: new Date().toISOString(),
      source: "manual",
      marginSide: "auto",
      isPinned: false,
    };
    this.store.add(tag);
    if (pv.rendered) this.renderTags(pv);
    this.renderAnnotationSidebar();
    return tag;
  }

  private snapshotSelection(sel: Selection): PendingSelection | null {
    const text = sel.toString().trim();
    if (!text || !this.store) return null;

    const byPage = new Map<number, PdfRect[]>();
    const clientRects: DOMRect[] = [];
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
        clientRects.push(cr);
      }
    }
    if (byPage.size === 0 || clientRects.length === 0) return null;

    const anchor = this.computeSelectionActionAnchor(sel, clientRects);
    if (!anchor) return null;
    return { text, byPage, anchor };
  }

  private computeSelectionActionAnchor(sel: Selection, rects: DOMRect[]): SelectionActionAnchor | null {
    const backward = isSelectionBackward(sel);
    const focusRect = this.focusCaretRect(sel);
    const fallback = selectionFocusFallbackRect(rects, backward);
    const rect = focusRect ?? fallback;
    if (!rect) return null;
    const side: "left" | "right" = backward ? "left" : "right";
    const focusX = side === "left" ? rect.left : rect.right;
    const height = clamp(12, rect.height || fallback?.height || 16, 34);
    const gap = 4;
    const markerWidth = 5;
    const x = side === "right" ? focusX + gap : focusX - gap - markerWidth;
    const y = rect.top + (rect.height || height) / 2 - height / 2;
    return { x, y, height, side };
  }

  private focusCaretRect(sel: Selection): DOMRect | null {
    if (!sel.focusNode) return null;
    try {
      const range = this.pagesEl.ownerDocument.createRange();
      range.setStart(sel.focusNode, sel.focusOffset);
      range.collapse(true);
      const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
      const rect = rects[0] ?? null;
      range.detach();
      return rect;
    } catch {
      return null;
    }
  }

  private showSelectionHandle(pending: PendingSelection): void {
    this.pendingSelection = pending;
    this.closeSelectionActionPopup();
    const accent = resolvePalette(this.currentColor)?.ink ?? markInkColor(this.currentColor);
    this.rubberHandle?.show(pending.anchor, accent);
  }

  private openSelectionActionPopup(): void {
    const pending = this.pendingSelection;
    if (!pending) return;
    this.selectionPopoverEl?.remove();
    const doc = this.pagesEl.ownerDocument;
    const pop = doc.body.createDiv({ cls: `lpa-selection-popover is-${pending.anchor.side}` });
    this.selectionPopoverEl = pop;
    pop.style.setProperty("--lpa-accent", resolvePalette(this.currentColor)?.ink ?? markInkColor(this.currentColor));
    pop.onmousedown = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    };

    const swatches = pop.createDiv({ cls: "lpa-selection-swatches", attr: { "aria-label": "Highlight color" } });
    for (const p of PALETTE) {
      const sw = swatches.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name, title: p.name } });
      sw.style.background = p.fill;
      sw.dataset.color = p.fill;
      sw.toggleClass("is-active", p.fill === this.currentColor);
      sw.onclick = (evt) => {
        evt.preventDefault();
        this.setActiveColor(p.fill);
        pop.style.setProperty("--lpa-accent", p.ink);
        for (const candidate of Array.from(swatches.querySelectorAll<HTMLElement>(".lpa-swatch"))) {
          candidate.toggleClass("is-active", candidate.dataset.color === p.fill);
        }
      };
    }

    const highlightBtn = pop.createEl("button", { cls: "lpa-selection-action", text: "Highlight" });
    highlightBtn.onclick = (evt) => {
      evt.preventDefault();
      this.commitPendingSelection("highlight");
    };
    const annotateBtn = pop.createEl("button", { cls: "lpa-selection-action lpa-selection-action-primary", text: "Annotate" });
    annotateBtn.onclick = (evt) => {
      evt.preventDefault();
      this.commitPendingSelection("annotate");
    };
    const copyBtn = pop.createEl("button", { cls: "lpa-selection-action lpa-selection-action-quiet", text: "Copy" });
    copyBtn.onclick = async (evt) => {
      evt.preventDefault();
      await navigator.clipboard.writeText(this.pendingSelection?.text ?? pending.text);
      new Notice("Copied selected text");
    };

    pop.style.visibility = "hidden";
    const pr = pop.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const sideGap = 10;
    let x = pending.anchor.side === "right"
      ? pending.anchor.x + sideGap
      : pending.anchor.x - pr.width - sideGap;
    let y = pending.anchor.y + pending.anchor.height / 2 - pr.height / 2;
    x = clamp(8, x, Math.max(8, vw - pr.width - 8));
    y = clamp(8, y, Math.max(8, vh - pr.height - 8));
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    pop.style.visibility = "visible";
    this.rubberHandle?.setClusterElement(pop);
  }

  private closeSelectionActionPopup(): void {
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.rubberHandle?.closeToRest();
  }

  private hideSelectionActions(clearNativeSelection: boolean): void {
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    this.rubberHandle?.hide();
    if (clearNativeSelection) {
      this.pagesEl.ownerDocument.getSelection()?.removeAllRanges();
    }
  }

  private commitPendingSelection(mode: "highlight" | "annotate"): void {
    const pending = this.pendingSelection;
    if (!pending || !this.store) return;
    const createdIds: string[] = [];
    for (const [pageIndex, rects] of pending.byPage) {
      const h: Highlight = {
        id: newId(),
        type: "highlight",
        page: pageIndex,
        color: this.currentColor,
        style: this.currentStyle,
        text: pending.text,
        rects,
        created: new Date().toISOString(),
        source: "manual",
        marginSide: "auto",
        isPinned: false,
      };
      if (mode === "annotate") h.note = "";
      this.store.add(h);
      createdIds.push(h.id);
      const pv = this.pageViews[pageIndex];
      if (pv) this.renderHighlights(pv);
    }
    this.hideSelectionActions(true);
    this.renderAnnotationSidebar();
    if (!createdIds.length) return;
    if (mode === "annotate") {
      this.activateHighlight(createdIds[0], { scrollSidebar: true, focusNote: true });
    } else {
      this.activateHighlight(createdIds[0], { scrollSidebar: false });
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
    const visualMarks = Array.from(pv.hlLayer.querySelectorAll<HTMLElement>(".lpa-highlight")).reverse();
    for (const mark of visualMarks) {
      const r = mark.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
      const ids = highlightIdsForElement(mark);
      for (let i = ids.length - 1; i >= 0; i--) {
        const highlight = this.store.get(ids[i]);
        if (highlight && annotationTypeOf(highlight) === "highlight") return { highlight, pageView: pv };
      }
    }
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
    if (this.tagPlacementMode) return;
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
      if (target?.rendered) {
        this.renderHighlights(target);
        this.renderTags(target);
      }
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
    const noteBtn = actions.createEl("button", { text: "Annotate" });
    noteBtn.onclick = () => {
      this.ensureAnnotationCard(h.id);
      this.closeMarkPopover();
      this.activateHighlight(h.id, { scrollSidebar: true, focusNote: true });
    };
    const delBtn = actions.createEl("button", { cls: "lpa-danger", text: "Delete" });
    delBtn.onclick = () => {
      const page = this.store?.get(h.id)?.page ?? h.page;
      this.store?.remove(h.id);
      if (this.activeHighlightId === h.id) this.activeHighlightId = null;
      if (this.hoverHighlightId === h.id) this.hoverHighlightId = null;
      this.closeMarkPopover();
      const target = this.pageViews[page] ?? pv;
      if (target?.rendered) {
        this.renderHighlights(target);
        this.renderTags(target);
      }
      this.renderAnnotationSidebar();
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
    const div = annotationTypeOf(h) === "tag"
      ? pv.noteLayer.querySelector<HTMLElement>(`.lpa-page-tag[data-hl-id="${cssEscape(id)}"]`)
      : Array.from(pv.hlLayer.querySelectorAll<HTMLElement>(".lpa-highlight"))
        .find((el) => (el.dataset.hlIds ?? "").split(/\s+/).includes(id));
    if (div) {
      div.addClass("lpa-flash");
      window.setTimeout(() => div.removeClass("lpa-flash"), 1200);
    }
  }

  private toggleAnnotationPin(id: string): void {
    const h = this.store?.get(id);
    if (!h) return;
    this.store?.update(id, { isPinned: !h.isPinned });
    this.renderAnnotationSidebar();
    const pv = this.pageViews[h.page];
    if (pv?.rendered) this.renderTags(pv);
  }

  private ensureAnnotationCard(id: string): void {
    const h = this.store?.get(id);
    if (!h || annotationTypeOf(h) !== "highlight") return;
    if (typeof h.note !== "string") this.store?.update(id, { note: "" });
    this.renderAnnotationSidebar();
  }

  private openAnnotationContextMenu(evt: MouseEvent, id: string): void {
    const h = this.store?.get(id);
    if (!h) return;
    evt.preventDefault();
    evt.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Edit note")
        .setIcon("pencil")
        .onClick(() => {
          this.ensureAnnotationCard(id);
          this.activateHighlight(id, { scrollSidebar: true, focusNote: true });
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(h.isPinned ? "Unpin card" : "Pin card")
        .setIcon("pin")
        .onClick(() => this.toggleAnnotationPin(id))
    );
    menu.addItem((item) =>
      item
        .setTitle("Move card to left margin")
        .setIcon("panel-left")
        .onClick(() => this.setAnnotationMarginSide(id, "left"))
    );
    menu.addItem((item) =>
      item
        .setTitle("Move card to right margin")
        .setIcon("panel-right")
        .onClick(() => this.setAnnotationMarginSide(id, "right"))
    );
    menu.addItem((item) =>
      item
        .setTitle("Auto-place card")
        .setIcon("move-horizontal")
        .onClick(() => this.setAnnotationMarginSide(id, "auto"))
    );
    menu.addItem((item) =>
      item
        .setTitle("Copy text")
        .setIcon("copy")
        .onClick(async () => {
          await navigator.clipboard.writeText((h.note || h.text || tagPreview(h)).trim());
          new Notice("Copied annotation text");
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("Change color")
        .setIcon("palette")
        .onClick(() => this.openAnnotationColorPopover(id, evt.clientX, evt.clientY))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => this.deleteAnnotation(id))
    );
    menu.showAtMouseEvent(evt);
  }

  private setAnnotationMarginSide(id: string, side: "left" | "right" | "auto"): void {
    const h = this.store?.get(id);
    if (!h) return;
    this.store?.update(id, { marginSide: side });
    this.renderAnnotationSidebar();
    const pv = this.pageViews[h.page];
    if (pv?.rendered) this.renderTags(pv);
  }

  private openAnnotationColorPopover(id: string, clientX: number, clientY: number): void {
    const h = this.store?.get(id);
    if (!h) return;
    this.closeMarkPopover();
    const doc = this.pagesEl.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-mark-popover lpa-color-popover" });
    const colorRow = pop.createDiv({ cls: "lpa-swatches" });
    for (const p of PALETTE) {
      const sw = colorRow.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name } });
      sw.style.background = p.fill;
      sw.dataset.color = p.fill;
      sw.toggleClass("is-active", annotationColor(h) === p.fill);
      sw.onclick = () => {
        const patch: Partial<Highlight> = annotationTypeOf(h) === "tag"
          ? { color: p.fill, tagColor: p.fill }
          : { color: p.fill };
        this.store?.update(id, patch);
        const cur = this.store?.get(id);
        if (cur) {
          const pv = this.pageViews[cur.page];
          if (pv?.rendered) {
            this.renderHighlights(pv);
            this.renderTags(pv);
          }
        }
        this.renderAnnotationSidebar();
        this.closeMarkPopover();
      };
    }
    pop.style.visibility = "hidden";
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const pr = pop.getBoundingClientRect();
    let x = clientX + 6;
    let y = clientY + 10;
    if (x + pr.width > vw - 8) x = Math.max(8, vw - pr.width - 8);
    if (y + pr.height > vh - 8) y = Math.max(8, clientY - pr.height - 10);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    pop.style.visibility = "visible";
    const onDocPointer = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node)) this.closeMarkPopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeMarkPopover();
    };
    window.setTimeout(() => doc.addEventListener("mousedown", onDocPointer, true), 0);
    doc.addEventListener("keydown", onKey, true);
    this.markPopoverCleanup = () => {
      doc.removeEventListener("mousedown", onDocPointer, true);
      doc.removeEventListener("keydown", onKey, true);
      pop.remove();
    };
  }

  private deleteAnnotation(id: string): void {
    const h = this.store?.get(id);
    if (!h) return;
    this.store?.remove(id);
    if (this.activeHighlightId === id) this.activeHighlightId = null;
    if (this.hoverHighlightId === id) this.hoverHighlightId = null;
    const pv = this.pageViews[h.page];
    if (pv?.rendered) {
      this.renderHighlights(pv);
      this.renderTags(pv);
    }
    this.renderAnnotationSidebar();
  }

  private beginTagDrag(evt: MouseEvent, id: string, pv: PageView): void {
    if (!evt.altKey && !evt.metaKey) return;
    const tag = this.store?.get(id);
    if (!tag || annotationTypeOf(tag) !== "tag") return;
    evt.preventDefault();
    evt.stopPropagation();
    const doc = this.pagesEl.ownerDocument;
    const move = (e: MouseEvent) => {
      const pageRect = pv.el.getBoundingClientRect();
      const xPct = clamp(0, ((e.clientX - pageRect.left) / Math.max(1, pageRect.width)) * 100, 100);
      const yPct = clamp(0, ((e.clientY - pageRect.top) / Math.max(1, pageRect.height)) * 100, 100);
      const el = pv.noteLayer.querySelector<HTMLElement>(`.lpa-page-tag[data-hl-id="${cssEscape(id)}"]`);
      if (el) {
        el.style.left = `${xPct}%`;
        el.style.top = `${yPct}%`;
      }
      this.scheduleMarginLayout();
    };
    const up = (e: MouseEvent) => {
      doc.removeEventListener("mousemove", move, true);
      doc.removeEventListener("mouseup", up, true);
      const pageRect = pv.el.getBoundingClientRect();
      const xPct = clamp(0, ((e.clientX - pageRect.left) / Math.max(1, pageRect.width)) * 100, 100);
      const yPct = clamp(0, ((e.clientY - pageRect.top) / Math.max(1, pageRect.height)) * 100, 100);
      this.store?.update(id, { tagX: xPct, tagY: yPct });
      this.renderAnnotationSidebar();
    };
    doc.addEventListener("mousemove", move, true);
    doc.addEventListener("mouseup", up, true);
  }

  private computeAnnotationAnchor(h: Highlight): AnnotationAnchor | null {
    const pv = this.pageViews[h.page];
    if (!pv || !pv.page) return null;
    const pageRect = pv.el.getBoundingClientRect();
    const pagesRect = this.pagesEl.getBoundingClientRect();
    const bodyRect = this.bodyEl.getBoundingClientRect();
    if (pageRect.bottom < pagesRect.top || pageRect.top > pagesRect.bottom) return null;

    const explicit = h.marginSide === "left" || h.marginSide === "right" ? h.marginSide : null;
    if (annotationTypeOf(h) === "tag") {
      if (typeof h.tagX !== "number" || typeof h.tagY !== "number") return null;
      const sourceXViewport = pageRect.left + (clamp(0, h.tagX, 100) / 100) * pageRect.width;
      const sourceYViewport = pageRect.top + (clamp(0, h.tagY, 100) / 100) * pageRect.height;
      const side = this.chooseMarginSide(explicit, h.tagX < 50 ? "left" : "right");
      return {
        side,
        sourceX: sourceXViewport - bodyRect.left,
        sourceY: sourceYViewport - bodyRect.top,
        idealY: sourceYViewport - bodyRect.top,
        sourceWidth: 12,
        sourceHeight: 18,
        pageLeftX: pageRect.left - bodyRect.left,
        pageRightX: pageRect.right - bodyRect.left,
      };
    }

    if (h.rects.length === 0) return null;
    const vp = pv.page.getViewport({ scale: this.scale });
    const rects = this.rectToViewport(vp, h.rects).filter((r) => r.right - r.left >= 0.5 && r.bottom - r.top >= 0.5);
    if (rects.length === 0) return null;
    const lines = mergeLineRects(rects);
    const firstLine = lines[0] ?? rects[0];
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const centerX = (left + right) / 2;
    const lineCenterY = (firstLine.top + firstLine.bottom) / 2;
    const side = this.chooseMarginSide(explicit, centerX < pageRect.width / 2 ? "left" : "right");
    const sourceEdge = side === "left" ? left : right;
    return {
      side,
      sourceX: pageRect.left + sourceEdge - bodyRect.left,
      sourceY: pageRect.top + lineCenterY - bodyRect.top,
      idealY: pageRect.top + firstLine.top - bodyRect.top,
      sourceWidth: right - left,
      sourceHeight: bottom - top,
      pageLeftX: pageRect.left - bodyRect.left,
      pageRightX: pageRect.right - bodyRect.left,
    };
  }

  private chooseMarginSide(explicit: "left" | "right" | null, preferred: "left" | "right"): "left" | "right" {
    if (explicit) return explicit;
    const left = this.marginGeometry.leftWidth;
    const right = this.marginGeometry.rightWidth;
    const readable = 82;
    const materialDifference = 28;
    if (preferred === "left" && left < readable && right >= readable && right > left + materialDifference) {
      return "right";
    }
    if (preferred === "right" && right < readable && left >= readable && left > right + materialDifference) {
      return "left";
    }
    return preferred;
  }

  private updateElasticMargins(): void {
    if (!this.bodyEl || !this.leftMarginEl || !this.rightMarginEl) return;
    const bodyRect = this.bodyEl.getBoundingClientRect();
    if (bodyRect.width <= 0 || bodyRect.height <= 0) return;

    const pageRect = this.marginReferencePageRect();
    const fallbackWidth = (this.defaultSize?.w ?? 612) * this.scale;
    const fallbackLeft = (bodyRect.width - fallbackWidth) / 2;
    const pageLeftX = pageRect ? pageRect.left - bodyRect.left : fallbackLeft;
    const pageRightX = pageRect ? pageRect.right - bodyRect.left : fallbackLeft + fallbackWidth;
    const realLeftWidth = clamp(0, pageLeftX, bodyRect.width);
    const realRightWidth = clamp(0, bodyRect.width - pageRightX, bodyRect.width);
    const maxOverlayWidth = Math.max(0, bodyRect.width / 2 - 8);
    const leftWidth = clamp(0, Math.max(realLeftWidth, MIN_INTERACTION_MARGIN), maxOverlayWidth);
    const rightWidth = clamp(0, Math.max(realRightWidth, MIN_INTERACTION_MARGIN), maxOverlayWidth);

    this.marginGeometry = { leftWidth, rightWidth, pageLeftX, pageRightX };
    this.applyElasticMarginWidth(this.leftMarginEl, leftWidth);
    this.applyElasticMarginWidth(this.rightMarginEl, rightWidth);
  }

  private marginReferencePageRect(): DOMRect | null {
    if (!this.bodyEl) return null;
    const bodyRect = this.bodyEl.getBoundingClientRect();
    let best: { rect: DOMRect; area: number } | null = null;
    const candidates = this.visible.size ? [...this.visible] : this.pageViews.map((_, i) => i).slice(0, 3);
    for (const idx of candidates) {
      const pv = this.pageViews[idx];
      if (!pv?.el.isConnected) continue;
      const rect = pv.el.getBoundingClientRect();
      const visibleW = Math.max(0, Math.min(rect.right, bodyRect.right) - Math.max(rect.left, bodyRect.left));
      const visibleH = Math.max(0, Math.min(rect.bottom, bodyRect.bottom) - Math.max(rect.top, bodyRect.top));
      const area = visibleW * visibleH;
      if (area > 0 && (!best || area > best.area)) best = { rect, area };
    }
    return best?.rect ?? this.pageViews[0]?.el.getBoundingClientRect() ?? null;
  }

  private applyElasticMarginWidth(margin: HTMLElement, width: number): void {
    const rounded = Math.max(0, Math.round(width));
    margin.style.width = `${rounded}px`;
    margin.style.setProperty("--lpa-margin-width", `${rounded}px`);
    margin.toggleClass("is-collapsed", rounded < 42);
    margin.toggleClass("is-tight", rounded >= 42 && rounded < 92);
    margin.toggleClass("is-compact", rounded >= 92 && rounded < 132);
    margin.toggleClass("is-roomy", rounded >= 180);
    margin.toggleClass("is-spacious", rounded >= 260);
  }

  private onPdfScroll(): void {
    this.hideSelectionActions(false);
    this.bodyEl?.addClass("is-scrolling");
    this.scheduleMarginLayout();
    if (this.scrollSettleTimer !== null) window.clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = window.setTimeout(() => {
      this.scrollSettleTimer = null;
      this.bodyEl?.removeClass("is-scrolling");
      this.scheduleMarginLayout();
    }, 120);
  }

  private scheduleMarginLayout(): void {
    if (this.marginLayoutRaf !== null) return;
    this.marginLayoutRaf = window.requestAnimationFrame(() => {
      this.marginLayoutRaf = null;
      this.updateElasticMargins();
      this.layoutMarginCards();
      this.redrawConnectionLines();
    });
  }

  private layoutMarginCards(): void {
    this.layoutMargin(this.leftMarginEl);
    this.layoutMargin(this.rightMarginEl);
  }

  private layoutMargin(margin: HTMLElement): void {
    if (!margin) return;
    const cards = Array.from(margin.querySelectorAll<HTMLElement>(".lpa-margin-card"))
      .map((card) => {
        const id = card.dataset.hlId ?? "";
        const h = id ? this.store?.get(id) : undefined;
        const anchor = h ? this.computeAnnotationAnchor(h) : null;
        return h && anchor ? { card, h, anchor, height: card.offsetHeight || 24 } : null;
      })
      .filter((item): item is { card: HTMLElement; h: Highlight; anchor: AnnotationAnchor; height: number } => !!item)
      .sort((a, b) => a.anchor.idealY - b.anchor.idealY);
    let y = 8;
    const gap = 5;
    for (const item of cards) {
      const idealTop = item.anchor.idealY;
      y = Math.max(idealTop, y);
      item.card.style.top = `${Math.round(y)}px`;
      y += item.height + gap;
    }
    const overflow = y - gap - (margin.clientHeight - 8);
    if (overflow > 0 && cards.length) {
      const shift = Math.min(overflow, Math.max(0, Number.parseFloat(cards[0].card.style.top || "0") - 8));
      if (shift > 0) {
        for (const item of cards) {
          const top = Number.parseFloat(item.card.style.top || "0");
          item.card.style.top = `${Math.round(top - shift)}px`;
        }
      }
    }
  }

  private redrawConnectionLines(): void {
    if (!this.connectionSvg || !this.bodyEl) return;
    while (this.connectionSvg.firstChild) this.connectionSvg.firstChild.remove();
    const bodyRect = this.bodyEl.getBoundingClientRect();
    this.connectionSvg.setAttribute("viewBox", `0 0 ${Math.max(1, bodyRect.width)} ${Math.max(1, bodyRect.height)}`);
    this.connectionSvg.setAttribute("width", `${Math.max(1, bodyRect.width)}`);
    this.connectionSvg.setAttribute("height", `${Math.max(1, bodyRect.height)}`);
    for (const card of Array.from(this.bodyEl.querySelectorAll<HTMLElement>(".lpa-margin-card"))) {
      const id = card.dataset.hlId ?? "";
      const h = id ? this.store?.get(id) : undefined;
      const anchor = h ? this.computeAnnotationAnchor(h) : null;
      if (!h || !anchor) continue;
      const side = anchor.side;
      const marginWidth = side === "left" ? this.marginGeometry.leftWidth : this.marginGeometry.rightWidth;
      if (marginWidth < 42) continue;
      const cardRect = card.getBoundingClientRect();
      const cardX = side === "left" ? cardRect.right - bodyRect.left : cardRect.left - bodyRect.left;
      const cardY = cardRect.top + cardRect.height / 2 - bodyRect.top;
      const borderX = side === "left" ? anchor.pageLeftX : anchor.pageRightX;
      const accent = resolvePalette(annotationColor(h))?.ink ?? markInkColor(annotationColor(h));
      const isTag = annotationTypeOf(h) === "tag";
      const d = isTag
        ? `M ${anchor.sourceX},${anchor.sourceY} C ${borderX},${anchor.sourceY} ${borderX},${cardY} ${cardX},${cardY}`
        : `M ${cardX},${cardY} C ${borderX},${cardY} ${borderX},${anchor.sourceY} ${anchor.sourceX},${anchor.sourceY}`;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", accent);
      path.classList.add("lpa-connection-line", isTag ? "lpa-connection-line--tag" : "lpa-connection-line--highlight");
      path.dataset.hlId = id;
      if (id === this.hoverHighlightId || id === this.activeHighlightId) path.classList.add("is-hover");
      if (h.isPinned) path.classList.add("is-pinned");
      this.connectionSvg.appendChild(path);

      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", `${cardX}`);
      dot.setAttribute("cy", `${cardY}`);
      dot.setAttribute("r", id === this.hoverHighlightId || id === this.activeHighlightId ? "2.5" : "2");
      dot.setAttribute("fill", accent);
      dot.classList.add("lpa-connection-dot");
      if (id === this.hoverHighlightId || id === this.activeHighlightId) dot.classList.add("is-hover");
      if (h.isPinned) dot.classList.add("is-pinned");
      this.connectionSvg.appendChild(dot);

      if (isTag && !h.isPinned) {
        const len = path.getTotalLength();
        path.style.strokeDasharray = `${len}`;
        path.style.strokeDashoffset = `${len}`;
        window.requestAnimationFrame(() => {
          path.style.strokeDashoffset = "0";
        });
      }
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
          type: "highlight",
          page: r.page,
          color: this.currentColor,
          text: cleanText,
          note: a.note,
          rects: r.rects,
          created: a.created ?? new Date().toISOString(),
          source: "import",
          marginSide: "auto",
          isPinned: false,
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
    this.hideSelectionActions(false);

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
    this.scheduleMarginLayout();
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
    this.hideSelectionActions(false);
    this.setTagPlacementMode(false);
    if (this.marginLayoutRaf !== null) {
      window.cancelAnimationFrame(this.marginLayoutRaf);
      this.marginLayoutRaf = null;
    }
    if (this.hoverClearTimer !== null) {
      window.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
    if (this.scrollSettleTimer !== null) {
      window.clearTimeout(this.scrollSettleTimer);
      this.scrollSettleTimer = null;
    }
    this.stopRollScroll();
    this.bodyEl?.removeClass("is-scrolling");
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
    this.lastVisibleKey = "";
    if (this.pdfDoc) {
      try { this.pdfDoc.destroy(); } catch {}
      this.pdfDoc = null;
    }
    if (this.pdfWorker) {
      try { this.pdfWorker.destroy(); } catch {}
      this.pdfWorker = null;
    }
    this.pagesEl?.empty();
    this.leftMarginEl?.empty();
    this.rightMarginEl?.empty();
    while (this.connectionSvg?.firstChild) this.connectionSvg.firstChild.remove();
    this.renderAnnotationSidebar();
  }
}

class RubberHandle {
  private markerEl: HTMLElement;
  private anchor: SelectionActionAnchor | null = null;
  private snapHandler: () => void = () => {};
  private closeHandler: () => void = () => {};
  private clusterEl: HTMLElement | null = null;
  private tension = 0;
  private opened = false;
  private visible = false;
  private pointerX = 0;
  private pointerY = 0;
  private hasPointer = false;
  private tickRaf: number | null = null;
  private lastTickT = 0;
  private closeTimer: number | null = null;

  private readonly onMouseMoveBound = (evt: MouseEvent) => this.onMouseMove(evt);
  private readonly onKeyDownBound = (evt: KeyboardEvent) => this.onKeyDown(evt);

  constructor(private doc: Document) {
    this.markerEl = doc.body.createDiv({ cls: "lpa-rubber-handle" });
    this.markerEl.setAttribute("aria-hidden", "true");
    doc.addEventListener("mousemove", this.onMouseMoveBound, true);
    doc.addEventListener("keydown", this.onKeyDownBound, true);
  }

  onSnap(handler: () => void): void {
    this.snapHandler = handler;
  }

  onRequestClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  show(anchor: SelectionActionAnchor, accent: string): void {
    this.anchor = anchor;
    this.clusterEl = null;
    this.opened = false;
    this.visible = true;
    this.tension = 0;
    this.hasPointer = false;
    this.lastTickT = 0;
    this.cancelCloseTimer();
    this.ensureTick();
    this.markerEl.removeClasses(["is-left", "is-right", "is-snapped"]);
    this.markerEl.addClass(`is-${anchor.side}`);
    this.markerEl.addClass("is-visible");
    this.markerEl.style.setProperty("--lpa-accent", accent);
    this.markerEl.style.height = `${Math.round(anchor.height)}px`;
    this.paint(anchor.x, anchor.y);
  }

  hide(): void {
    this.cancelCloseTimer();
    this.anchor = null;
    this.clusterEl = null;
    this.opened = false;
    this.visible = false;
    this.tension = 0;
    this.cancelTick();
    this.markerEl.removeClass("is-visible");
    this.markerEl.removeClass("is-snapped");
  }

  closeToRest(): void {
    this.cancelCloseTimer();
    this.clusterEl = null;
    this.opened = false;
    this.tension = 0;
    if (this.anchor && this.visible) this.paint(this.anchor.x, this.anchor.y);
  }

  setClusterElement(el: HTMLElement | null): void {
    this.clusterEl = el;
    this.cancelCloseTimer();
  }

  destroy(): void {
    this.doc.removeEventListener("mousemove", this.onMouseMoveBound, true);
    this.doc.removeEventListener("keydown", this.onKeyDownBound, true);
    this.cancelTick();
    this.cancelCloseTimer();
    this.markerEl.remove();
  }

  private onMouseMove(evt: MouseEvent): void {
    if (!this.anchor || !this.visible) return;
    this.pointerX = evt.clientX;
    this.pointerY = evt.clientY;
    this.hasPointer = true;
    this.ensureTick();
    if (this.opened) {
      this.trackOpenCluster(evt.clientX, evt.clientY);
    }
  }

  private snap(): void {
    if (this.opened) return;
    this.opened = true;
    this.tension = 1;
    this.markerEl.addClass("is-snapped");
    window.setTimeout(() => this.markerEl.removeClass("is-snapped"), 260);
    this.snapHandler();
  }

  private ensureTick(): void {
    if (this.tickRaf !== null) return;
    this.tickRaf = window.requestAnimationFrame((ts) => this.tick(ts));
  }

  private cancelTick(): void {
    if (this.tickRaf !== null) {
      window.cancelAnimationFrame(this.tickRaf);
      this.tickRaf = null;
    }
  }

  private tick(ts: number): void {
    this.tickRaf = null;
    if (!this.anchor || !this.visible || this.opened) return;
    const dt = this.lastTickT ? clamp(1, ts - this.lastTickT, 48) : 16;
    this.lastTickT = ts;
    if (this.hasPointer) {
      const hx = this.anchor.x + (this.anchor.side === "right" ? 0 : 5);
      const hy = this.anchor.y + this.anchor.height / 2;
      const dx = this.pointerX - hx;
      const dy = this.pointerY - hy;
      const dist = Math.hypot(dx, dy);
      if (dist <= RUBBER_HANDLE_FEEL.INTENT_RADIUS) {
        this.tension = clamp(0, this.tension + dt / RUBBER_HANDLE_FEEL.DWELL_MS, RUBBER_HANDLE_FEEL.SNAP_THRESHOLD);
      } else {
        this.tension = clamp(0, this.tension - dt / RUBBER_HANDLE_FEEL.DECAY_MS, RUBBER_HANDLE_FEEL.SNAP_THRESHOLD);
      }
      this.paint(this.anchor.x, this.anchor.y);
      if (this.tension >= RUBBER_HANDLE_FEEL.SNAP_THRESHOLD) {
        this.snap();
        return;
      }
    }
    this.ensureTick();
  }

  private trackOpenCluster(x: number, y: number): void {
    if (this.pointInSafeCluster(x, y)) {
      this.cancelCloseTimer();
      return;
    }
    if (this.closeTimer !== null) return;
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      this.closeHandler();
    }, RUBBER_HANDLE_FEEL.CLOSE_DELAY);
  }

  private pointInSafeCluster(x: number, y: number): boolean {
    const rects = [this.markerEl.getBoundingClientRect()];
    if (this.clusterEl?.isConnected) rects.push(this.clusterEl.getBoundingClientRect());
    if (rects.some((r) => pointInInflatedRect(x, y, r, RUBBER_HANDLE_FEEL.SAFE_CORRIDOR_PAD))) return true;
    if (rects.length < 2) return false;
    const [a, b] = rects;
    const left = Math.min(a.left, b.left) - RUBBER_HANDLE_FEEL.SAFE_CORRIDOR_PAD;
    const right = Math.max(a.right, b.right) + RUBBER_HANDLE_FEEL.SAFE_CORRIDOR_PAD;
    const top = Math.min(a.top, b.top) - RUBBER_HANDLE_FEEL.SAFE_CORRIDOR_PAD;
    const bottom = Math.max(a.bottom, b.bottom) + RUBBER_HANDLE_FEEL.SAFE_CORRIDOR_PAD;
    return x >= left && x <= right && y >= top && y <= bottom;
  }

  private onKeyDown(evt: KeyboardEvent): void {
    if (evt.key === "Escape" && this.visible) this.closeHandler();
  }

  private cancelCloseTimer(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private paint(x: number, y: number): void {
    this.markerEl.style.left = `${Math.round(x)}px`;
    this.markerEl.style.top = `${Math.round(y)}px`;
    const width = RUBBER_HANDLE_FEEL.REST_WIDTH + (RUBBER_HANDLE_FEEL.ACTIVE_WIDTH - RUBBER_HANDLE_FEEL.REST_WIDTH) * this.tension;
    this.markerEl.style.width = `${width.toFixed(2)}px`;
    this.markerEl.style.setProperty("--lpa-rubber-tension", this.tension.toFixed(3));
    this.markerEl.style.setProperty("--lpa-rubber-fill", `${(this.tension * 100).toFixed(1)}%`);
    this.markerEl.style.transform = "none";
  }
}

function shortAnnotationText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function annotationTypeOf(h: Highlight): "highlight" | "tag" {
  return h.type === "tag" ? "tag" : "highlight";
}

function highlightHasMarginCard(h: Highlight): boolean {
  if (annotationTypeOf(h) === "tag") return true;
  return typeof h.note === "string" || !!h.noteContentCJK || !!h.isPinned;
}

function annotationColor(h: Highlight): string {
  return h.tagColor ?? h.color;
}

function tagPreview(h: Highlight): string {
  const raw = (h.note || h.text || "Note").replace(/\bnote:\s*/gi, " ").replace(/\s+/g, " ").trim();
  const words = raw.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  return words || "Note";
}

function annotationKindLabel(h: Highlight): string {
  if (annotationTypeOf(h) === "tag") return "tag";
  const st = markStyleOf(h);
  return st === "highlight" ? "highlight" : MARK_STYLE_LABELS[st].toLowerCase();
}

function rollPrimaryText(h: Highlight): string {
  const text = (h.note || h.noteContentCJK || h.text || tagPreview(h)).replace(/\s+/g, " ").trim();
  return shortAnnotationText(text || "Untitled note", 160);
}

function rollSecondaryText(h: Highlight): string {
  const chunks: string[] = [];
  if (h.note && h.noteContentCJK) chunks.push(h.noteContentCJK);
  if (annotationTypeOf(h) === "highlight" && h.text) chunks.push(h.text);
  return shortAnnotationText(chunks.join("  "), 180);
}

function normalizeSearch(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function annotationMatchesSearch(h: Highlight, query: string): boolean {
  const haystack = [
    `p.${h.page + 1}`,
    String(h.page + 1),
    annotationKindLabel(h),
    h.note,
    h.noteContentCJK,
    h.text,
    tagPreview(h),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return query.split(" ").every((part) => haystack.includes(part));
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
  const pal = resolvePalette(color);
  const fill = pal?.fill ?? color;
  const c = parseColor(fill);
  if (!c) return fill;
  const a = baseHighlightAlpha(c, pal);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(a)})`;
}

function activeHighlightPaintColor(color: string): string {
  const c = highlightBaseColor(color);
  if (!c) return highlightPaintColor(color);
  const a = activeHighlightAlpha(c);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function activeHighlightGlossColor(color: string): string {
  const c = highlightBaseColor(color);
  if (!c) return highlightPaintColor(color);
  const a = clampCssAlpha(activeHighlightAlpha(c) * 0.76);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function activeHighlightBridgeColor(color: string): string {
  const c = highlightBaseColor(color);
  if (!c) return highlightPaintColor(color);
  // Inter-line connector. Lighter than the text band, but present enough that a
  // multi-line passage reads as one continuous chunk of ink rather than rows.
  const a = clampCssAlpha(activeHighlightAlpha(c) * 0.5);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function highlightBaseColor(color: string): Rgba | null {
  const pal = resolvePalette(color);
  const fill = pal?.fill ?? color;
  const parsed = parseColor(fill);
  if (!parsed) return null;
  return { ...parsed, a: baseHighlightAlpha(parsed, pal) };
}

function baseHighlightAlpha(color: Rgba, pal: ReturnType<typeof resolvePalette>): number {
  return pal?.highlightAlpha ?? Math.min(color.a === 1 ? MAX_HIGHLIGHT_ALPHA : color.a, MAX_HIGHLIGHT_ALPHA);
}

function activeHighlightAlpha(color: Rgba): number {
  // Emphasis is the SAME hue, just denser ink. Because the highlight layer is
  // multiply-blended, glyphs stay black at any alpha, so the active fill can sit
  // well above the resting cap without muddying text — it only deepens the
  // marker color over the white paper.
  return clampCssAlpha(Math.min(0.85, Math.max(color.a + 0.2, color.a * 1.4)));
}

function stickerBackgroundColor(color: string, alpha: number): string {
  const pal = resolvePalette(color);
  const fill = pal?.cardFill ?? pal?.fill ?? color;
  const c = parseColor(fill);
  if (!c) return fill;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(alpha)})`;
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

function pointInInflatedRect(x: number, y: number, rect: DOMRect, pad: number): boolean {
  return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}

function isSelectionBackward(sel: Selection): boolean {
  const anchor = sel.anchorNode;
  const focus = sel.focusNode;
  if (!anchor || !focus) return false;
  if (anchor === focus) return sel.anchorOffset > sel.focusOffset;
  const pos = anchor.compareDocumentPosition(focus);
  return !!(pos & Node.DOCUMENT_POSITION_PRECEDING);
}

function selectionFocusFallbackRect(rects: DOMRect[], backward: boolean): DOMRect | null {
  const clean = rects.filter((r) => r.width >= 1 && r.height >= 1);
  if (!clean.length) return null;
  return backward ? clean[0] : clean[clean.length - 1];
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
