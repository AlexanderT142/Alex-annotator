/**
 * native-overlay.ts — EXPERIMENTAL annotation mode layered onto Obsidian's
 * NATIVE PDF view (view type "pdf"), instead of replacing it.
 *
 * Approach / isolation guarantees:
 *  - We never call leaf.setViewState, never patch Obsidian internals, and never
 *    touch the native viewer's pdf.js objects. The ONLY native surface we rely
 *    on is stable pdf.js DOM (".page[data-page-number]", ".textLayer",
 *    ".canvasWrapper") plus Obsidian's ".pdf-toolbar" for control injection
 *    (with a ".view-actions" fallback).
 *  - Coordinate mapping is done with OUR bundled pdf.js: the overlay opens the
 *    same file (geometry only, nothing rendered) and converts DOM fractions of
 *    a native page box through a scale-1 viewport → PDF user space. This yields
 *    the exact same sidecar geometry the custom annotator view produces, so
 *    both modes read/write one format.
 *  - Marks are positioned in % of the page box, so native zoom keeps them
 *    aligned even between repaints; a MutationObserver re-attaches our layers
 *    whenever the native viewer re-renders a page.
 *  - Margin note cards (the custom view's side-annotation UX) live in a
 *    ".lpa-native-margins" overlay pinned to the native scroller's box: cards
 *    are anchored beside the visible pages and re-laid-out on scroll, resize,
 *    zoom, and native re-renders. When an active annotation has no readable
 *    rail, the overlay clicks native zoom-out instead of drawing cards over the
 *    page.
 *  - Everything injected is namespaced "lpa-native-*" and removed when the
 *    mode is toggled off, the leaf changes file or closes, or the plugin
 *    unloads.
 *
 * Known limitation: pages rotated by the user inside the native viewer can't be
 * mapped reliably (the native view does not expose its rotation publicly), so
 * painting/creating marks is skipped on aspect-mismatched pages instead of
 * placing them wrong.
 */
import { App, Menu, Notice, Plugin, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { pdfjsLib, initPdfEngine, createDedicatedWorker, LOG_TAG } from "./pdf-engine";
import {
  AnnotationStore,
  DEFAULT_COLOR,
  PALETTE,
  resolvePalette,
  MARK_STYLES,
  MARK_STYLE_LABELS,
  markStyleOf,
  newId,
  legacySidecarPathFor,
  sidecarPathFor,
  type AnnotationPathOptions,
  type Highlight,
  type MarkStyle,
  type PdfRect,
} from "./annotations";
import { buildDocIndex, anchorQuote } from "./anchor";
import { parseLegacyNote, targetBasename, type LegacyAnnotation } from "./legacy-import";
import { PdfBundleManager } from "./bundles";
import { copyPdfDataForWorker } from "./pdf-data";
import {
  fitFoldedMarginCardHeights,
  layoutPageBoundedCardTops,
  marginCardSourceText,
  syncMarginCardPresentation,
} from "./margin-card";

const MAX_HIGHLIGHT_ALPHA = 0.46;
/** DOM that belongs to us; mutations inside it must not re-trigger syncing. */
const OWN_DOM_SELECTOR =
  ".lpa-native-hl-layer, .lpa-native-note-layer, .lpa-native-roll, .lpa-native-controls, .lpa-native-margins";
/** Below this rail width cards are unreadable — skip the side entirely. */
const RAIL_HIDE_WIDTH = 42;
/** Below this, activating a mark asks native PDF zoom to create readable margin. */
const RAIL_READABLE_WIDTH = 156;
/** Keep right-rail cards clear of the native scrollbar. */
const RAIL_SCROLLBAR_GUTTER = 14;
const RAIL_AUTO_ZOOM_MAX_STEPS = 5;
const RAIL_AUTO_ZOOM_SETTLE_MS = 170;
const RAIL_AUTO_ZOOM_MEASURE_ATTEMPTS = 12;

interface PageGeom {
  vp1: any; // pdf.js viewport at scale 1 (the page's own /Rotate applied)
  w: number;
  h: number;
}

interface BaseRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PaintRect extends BaseRect {
  color: string;
  order: number;
  ids: Set<string>;
  notes: Set<string>;
}

interface LineMetrics {
  weight: number;
  dash: number;
  dashGap: number;
  dot: number;
  dotGap: number;
}

interface PageBox {
  idx: number;
  pageEl: HTMLElement;
  box: DOMRect;
}

/** Anchor of one annotation in the margin-rail overlay's coordinate space. */
interface NativeAnchor {
  side: "left" | "right";
  sourceX: number;
  sourceY: number;
  idealY: number;
  pageTopY: number;
  pageBottomY: number;
  pageLeftX: number;
  pageRightX: number;
}

interface RailEntry {
  h: Highlight;
  anchor: NativeAnchor;
}

function nativeViewFile(leaf: WorkspaceLeaf): TFile | null {
  const file = (leaf.view as { file?: unknown }).file;
  return file instanceof TFile && file.extension === "pdf" ? file : null;
}

/**
 * Owns the per-leaf toggle buttons in native PDF toolbars and the lifecycle of
 * the active overlays. `refresh()` is cheap and idempotent; the plugin calls it
 * on layout-change / active-leaf-change / file-open.
 */
export class NativeOverlayManager {
  private overlays = new Map<WorkspaceLeaf, NativePdfOverlay>();
  private retryTimer: number | null = null;
  private retryCount = 0;

  constructor(
    private plugin: Plugin,
    private enabled: () => boolean,
    private getAnnotationPathOptions: () => AnnotationPathOptions,
    private bundleManager?: PdfBundleManager,
    private getPaletteColors?: () => string[]
  ) {}

  private get app(): App {
    return this.plugin.app;
  }

  refresh(): void {
    if (!this.enabled()) {
      this.disable();
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType("pdf");
    const live = new Set(leaves);

    // GC overlays whose leaf closed, changed view type, or changed file.
    for (const [leaf, overlay] of Array.from(this.overlays)) {
      const file = live.has(leaf) ? nativeViewFile(leaf) : null;
      if (!file || file.path !== overlay.file.path) {
        overlay.destroy();
        this.overlays.delete(leaf);
      }
    }

    let missingBar = false;
    for (const leaf of leaves) {
      if (!nativeViewFile(leaf)) continue;
      if (!this.ensureControls(leaf)) missingBar = true;
    }
    // The native toolbar renders asynchronously after file-open; retry briefly.
    this.scheduleRetry(missingBar);
  }

  /** Tear everything down (setting turned off / plugin unload). */
  disable(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const overlay of this.overlays.values()) overlay.destroy();
    this.overlays.clear();
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      leaf.view.containerEl
        .querySelectorAll<HTMLElement>(".lpa-native-controls")
        .forEach((el) => el.remove());
    }
    this.app.workspace.containerEl
      .querySelectorAll<HTMLElement>(".lpa-native-controls")
      .forEach((el) => el.remove());
  }

  overlayFor(leaf: WorkspaceLeaf | null): NativePdfOverlay | null {
    return leaf ? this.overlays.get(leaf) ?? null : null;
  }

  activeOverlay(): NativePdfOverlay | null {
    return this.overlayFor(this.app.workspace.activeLeaf);
  }

  async toggle(leaf: WorkspaceLeaf): Promise<void> {
    const existing = this.overlays.get(leaf);
    if (existing) {
      existing.destroy();
      this.overlays.delete(leaf);
      this.refresh();
      return;
    }
    const file = nativeViewFile(leaf);
    if (!file) return;
    const overlay = new NativePdfOverlay(
      this.plugin,
      leaf,
      file,
      this.getAnnotationPathOptions,
      this.bundleManager,
      this.getPaletteColors
    );
    this.overlays.set(leaf, overlay);
    this.refresh();
    try {
      await overlay.init();
    } catch (e) {
      if (!overlay.isDestroyed) {
        console.error(`${LOG_TAG} native overlay attach failed`, e);
        new Notice("PDF Annotator: could not attach the annotation overlay (see console).");
      }
      overlay.destroy();
      if (this.overlays.get(leaf) === overlay) this.overlays.delete(leaf);
    }
    this.refresh();
  }

  syncPdfPath(file: TFile): void {
    for (const overlay of this.overlays.values()) overlay.syncPdfPath(file);
  }

  /** Inject/sync the control group in one native PDF leaf. False if no bar yet. */
  private ensureControls(leaf: WorkspaceLeaf): boolean {
    const container = leaf.view.containerEl;
    const bar =
      container.querySelector<HTMLElement>(".pdf-toolbar-right") ??
      container.querySelector<HTMLElement>(".pdf-toolbar") ??
      container.querySelector<HTMLElement>(".view-header .view-actions, .view-actions");
    if (!bar) return false;

    let group =
      Array.from(container.querySelectorAll<HTMLElement>(".lpa-native-controls")).find(
        (el) => el.parentElement === bar
      ) ?? null;
    // Sweep strays left behind if the native toolbar was rebuilt around us.
    container.querySelectorAll<HTMLElement>(".lpa-native-controls").forEach((el) => {
      if (el !== group) el.remove();
    });

    if (!group) {
      group = bar.ownerDocument.createElement("div");
      group.className = "lpa-native-controls";
      if (bar.hasClass("view-actions")) bar.insertBefore(group, bar.firstChild);
      else bar.appendChild(group);

      const toggle = group.createEl("button", {
        cls: "lpa-native-toggle clickable-icon",
        attr: { type: "button" },
      });
      setIcon(toggle, "highlighter");
      toggle.createSpan({ cls: "lpa-native-toggle-label", text: "Annotate" });
      toggle.onclick = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.toggle(leaf);
      };
    }

    const overlay = this.overlays.get(leaf) ?? null;
    const toggle = group.querySelector<HTMLElement>(".lpa-native-toggle");
    if (toggle) {
      const on = !!overlay;
      toggle.toggleClass("is-active", on);
      toggle.setAttribute("aria-pressed", on ? "true" : "false");
      const label = on
        ? "Annotation mode is on. Click to turn it off."
        : "Annotate this PDF in place (keeps the native viewer)";
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("title", label);
    }
    overlay?.ensureToolbarButtons(group);
    return true;
  }

  private scheduleRetry(needed: boolean): void {
    if (!needed) {
      this.retryCount = 0;
      return;
    }
    if (this.retryTimer !== null || this.retryCount >= 5) return;
    this.retryCount++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.refresh();
    }, 350);
  }
}

/**
 * One active annotation overlay bound to (leaf, file). Reads/writes the same
 * managed document bundle as the custom annotator view.
 */
export class NativePdfOverlay {
  private destroyed = false;
  private store: AnnotationStore | null = null;
  private pdfDoc: any | null = null;
  private pageLabelsPromise: Promise<string[] | null> | null = null;
  private pdfWorker: any | null = null;
  private geoms = new Map<number, PageGeom>();
  private geomPromises = new Map<number, Promise<PageGeom | null>>();
  private contentRoot: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private syncQueued = false;
  private cleanups: Array<() => void> = [];

  private currentColor = DEFAULT_COLOR;
  private currentStyle: MarkStyle = "highlight";
  private tagMode = false;
  private warnedRotated = false;

  private pendingSelection: { text: string; byPage: Map<number, PdfRect[]> } | null = null;
  private selectionPopoverEl: HTMLElement | null = null;
  private editPopoverCleanup: (() => void) | null = null;

  private tagBtn: HTMLButtonElement | null = null;
  private listBtn: HTMLButtonElement | null = null;
  private countEl: HTMLElement | null = null;
  private listPanelEl: HTMLElement | null = null;
  private listSearchQuery = "";

  // Margin-rail overlay (side note cards beside the native pages).
  private marginsEl: HTMLElement | null = null;
  private leftRailEl: HTMLElement | null = null;
  private rightRailEl: HTMLElement | null = null;
  private connectionSvg: SVGSVGElement | null = null;
  private railResizeObserver: ResizeObserver | null = null;
  private scroller: HTMLElement | null = null;
  private railScrollTarget: HTMLElement | null = null;
  private readonly railScrollHandler = () => this.onNativeScroll();
  private railWidths = { left: 0, right: 0 };
  private railRaf: number | null = null;
  private railAutoZoomToken = 0;
  private pointerRaf: number | null = null;
  private lastPointer: { x: number; y: number; pageEl: HTMLElement | null } | null = null;
  private hoverId: string | null = null;
  private activeId: string | null = null;
  private hoverClearTimer: number | null = null;
  private scrollSettleTimer: number | null = null;

  constructor(
    private plugin: Plugin,
    private leaf: WorkspaceLeaf,
    readonly file: TFile,
    private getAnnotationPathOptions: () => AnnotationPathOptions,
    private bundleManager?: PdfBundleManager,
    private getPaletteColors?: () => string[]
  ) {
    const activePalette = this.getActivePalette();
    if (activePalette.length > 0) {
      this.currentColor = activePalette[0].fill;
    }
  }

  /** Dynamic getter for configured palette colors */
  private getActivePalette(): Array<{ name: string; fill: string; ink: string }> {
    const customColors = this.getPaletteColors ? this.getPaletteColors() : [];
    if (!customColors || customColors.length === 0) {
      return PALETTE;
    }

    return customColors.map((color, index) => {
      const pal = resolvePalette(color);
      return {
        name: pal?.name ?? `Color ${index + 1}`,
        fill: color,
        ink: pal?.ink ?? markInkColor(color),
      };
    });
  }

  private get app(): App {
    return this.plugin.app;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  async init(): Promise<void> {
    initPdfEngine();
    const container = this.leaf.view.containerEl;
    this.contentRoot = container.querySelector<HTMLElement>(".view-content") ?? container;

    // Geometry-only document via OUR bundled pdf.js (no rendering, no globals).
    const data = await this.app.vault.readBinary(this.file);
    if (this.destroyed) return;
    this.pdfWorker = createDedicatedWorker();
    const params: any = { data: copyPdfDataForWorker(data), useSystemFonts: true };
    if (this.pdfWorker) params.worker = this.pdfWorker;
    this.pdfDoc = await pdfjsLib.getDocument(params).promise;
    if (this.destroyed) {
      this.releasePdf();
      return;
    }

    const fingerprint = Array.isArray(this.pdfDoc.fingerprints)
      ? this.pdfDoc.fingerprints[0]
      : this.pdfDoc.fingerprint;
    const pathOptions = this.getAnnotationPathOptions();
    let annotationPath = sidecarPathFor(this.file.path, pathOptions);
    let fallbackPaths = [legacySidecarPathFor(this.file.path)];
    let migrateFallback = false;
    let annotationBackupPath: string | undefined;
    if (this.bundleManager) {
      const binding = await this.bundleManager.prepare(this.file, data, fingerprint, pathOptions);
      annotationPath = binding.annotationPath;
      fallbackPaths = binding.fallbackAnnotationPaths;
      migrateFallback = true;
      annotationBackupPath = binding.annotationBackupPath;
    }
    this.store = new AnnotationStore(
      this.app.vault.adapter,
      annotationPath,
      this.file.basename,
      this.file.path,
      fingerprint,
      fallbackPaths,
      migrateFallback,
      annotationBackupPath
    );
    await this.store.load();
    if (this.destroyed) return;
    this.notifyStoreChanged();

    const doc = this.contentRoot.ownerDocument;
    this.listen(this.contentRoot, "mouseup", (evt) => this.onMouseUp(evt as MouseEvent));
    this.listen(this.contentRoot, "click", (evt) => this.onClick(evt as MouseEvent));
    this.listen(
      this.contentRoot,
      "mousemove",
      (evt) => this.onPointerMove(evt as MouseEvent),
      { passive: true }
    );
    this.listen(doc, "selectionchange", () => this.onSelectionChange());
    this.listen(doc, "keydown", (evt) => this.onKeyDown(evt as KeyboardEvent));

    this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
    this.observer.observe(this.contentRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-loaded"],
    });

    this.initMarginRail();
    this.scheduleSync();
    console.log(`${LOG_TAG} native annotation overlay attached: ${this.file.path}`);
  }

  syncPdfPath(file: TFile): void {
    if (this.file !== file && this.file.path !== file.path) return;
    this.store?.setPdfPath(file.path, file.basename);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.closeEditPopover();
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    this.closeListPanel();
    this.contentRoot?.removeClass("lpa-native-tag-mode");

    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }

    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.railRaf !== null) {
      win.cancelAnimationFrame(this.railRaf);
      this.railRaf = null;
    }
    if (this.pointerRaf !== null) {
      win.cancelAnimationFrame(this.pointerRaf);
      this.pointerRaf = null;
    }
    this.lastPointer = null;
    if (this.hoverClearTimer !== null) {
      win.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
    if (this.scrollSettleTimer !== null) {
      win.clearTimeout(this.scrollSettleTimer);
      this.scrollSettleTimer = null;
    }
    this.railAutoZoomToken++;
    this.marginsEl?.remove();
    this.marginsEl = null;
    this.leftRailEl = null;
    this.rightRailEl = null;
    this.connectionSvg = null;
    this.scroller = null;

    this.contentRoot
      ?.querySelectorAll<HTMLElement>(
        ".lpa-native-hl-layer, .lpa-native-note-layer, .lpa-native-margins"
      )
      .forEach((el) => el.remove());
    this.removeToolbarButtons();

    const store = this.store;
    this.store = null;
    if (store) {
      void store.flush().catch((e) => console.error(`${LOG_TAG} failed to save annotations`, e));
    }
    this.releasePdf();
    this.geoms.clear();
    this.geomPromises.clear();
    this.contentRoot = null;
  }

  private releasePdf(): void {
    try {
      this.pdfDoc?.destroy();
    } catch {}
    try {
      this.pdfWorker?.destroy();
    } catch {}
    this.pdfDoc = null;
    this.pageLabelsPromise = null;
    this.pdfWorker = null;
  }

  private listen(
    target: EventTarget,
    type: string,
    handler: (evt: Event) => void,
    options?: AddEventListenerOptions
  ): void {
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  // ---- toolbar controls (inside the manager-owned group) -------------------

  ensureToolbarButtons(group: HTMLElement): void {
    if (this.destroyed) return;
    if (this.tagBtn && this.tagBtn.isConnected && this.tagBtn.parentElement === group) {
      this.syncToolbarState();
      return;
    }
    this.removeToolbarButtons();

    this.tagBtn = group.createEl("button", {
      cls: "lpa-native-btn clickable-icon",
      attr: { type: "button", "aria-label": "Place a page note tag", title: "Place a page note tag" },
    });
    setIcon(this.tagBtn, "sticky-note");
    this.tagBtn.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.setTagMode(!this.tagMode);
    };

    this.listBtn = group.createEl("button", {
      cls: "lpa-native-btn clickable-icon",
      attr: { type: "button", "aria-label": "Show annotations", title: "Show annotations" },
    });
    setIcon(this.listBtn, "list");
    this.listBtn.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.toggleListPanel();
    };

    this.countEl = group.createSpan({ cls: "lpa-native-count", text: "0" });
    this.syncToolbarState();
    this.updateCount();
  }

  private removeToolbarButtons(): void {
    this.tagBtn?.remove();
    this.tagBtn = null;
    this.listBtn?.remove();
    this.listBtn = null;
    this.countEl?.remove();
    this.countEl = null;
  }

  private syncToolbarState(): void {
    this.tagBtn?.toggleClass("is-active", this.tagMode);
    this.tagBtn?.setAttribute("aria-pressed", this.tagMode ? "true" : "false");
    this.listBtn?.toggleClass("is-active", !!this.listPanelEl);
    this.listBtn?.setAttribute("aria-pressed", this.listPanelEl ? "true" : "false");
  }

  private setTagMode(on: boolean): void {
    this.tagMode = on;
    this.contentRoot?.toggleClass("lpa-native-tag-mode", on);
    this.syncToolbarState();
  }

  private updateCount(): void {
    const n = this.store?.doc.highlights.length ?? 0;
    this.countEl?.setText(String(n));
    this.countEl?.setAttribute("title", `${n} ${n === 1 ? "annotation" : "annotations"}`);
  }

  private notifyStoreChanged(): void {
    this.updateCount();
    if (this.listPanelEl) this.renderListItems();
    this.scheduleRailLayout();
  }

  // ---- page sync / painting -------------------------------------------------

  private onMutations(mutations: MutationRecord[]): void {
    for (const m of mutations) {
      const target = m.target instanceof HTMLElement ? m.target : m.target.parentElement;
      if (target?.closest(OWN_DOM_SELECTOR)) continue;
      this.scheduleSync();
      return;
    }
  }

  private scheduleSync(): void {
    if (this.destroyed || this.syncQueued) return;
    this.syncQueued = true;
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => {
      this.syncQueued = false;
      this.syncPages();
    });
  }

  private syncPages(): void {
    if (this.destroyed || !this.contentRoot || !this.store) return;
    const store = this.store;
    const pageEls = this.contentRoot.querySelectorAll<HTMLElement>(".page[data-page-number]");
    for (const pageEl of Array.from(pageEls)) {
      const num = Number(pageEl.getAttribute("data-page-number"));
      if (!Number.isFinite(num) || num < 1) continue;
      const idx = num - 1;
      const active =
        pageEl.hasAttribute("data-loaded") ||
        !!pageEl.querySelector(":scope > .textLayer, :scope > .canvasWrapper, :scope > .lpa-native-hl-layer");
      if (!active && store.byPage(idx).length === 0) continue;
      void this.syncPage(idx, pageEl);
    }
    this.scheduleRailLayout();
  }

  private async syncPage(idx: number, pageEl: HTMLElement): Promise<void> {
    const geom = await this.ensureGeom(idx);
    if (!geom || this.destroyed || !pageEl.isConnected) return;

    const textLayer = pageEl.querySelector<HTMLElement>(":scope > .textLayer");
    let layer = pageEl.querySelector<HTMLElement>(":scope > .lpa-native-hl-layer");
    if (!layer) {
      layer = pageEl.ownerDocument.createElement("div");
      layer.className = "lpa-highlight-layer lpa-native-hl-layer";
      if (textLayer) pageEl.insertBefore(layer, textLayer);
      else pageEl.appendChild(layer);
    } else if (textLayer && layer.compareDocumentPosition(textLayer) & Node.DOCUMENT_POSITION_PRECEDING) {
      pageEl.insertBefore(layer, textLayer);
    }
    let noteLayer = pageEl.querySelector<HTMLElement>(":scope > .lpa-native-note-layer");
    if (!noteLayer) {
      noteLayer = pageEl.ownerDocument.createElement("div");
      noteLayer.className = "lpa-note-layer lpa-native-note-layer";
      pageEl.appendChild(noteLayer);
    }
    this.paintPage(idx, pageEl, layer, noteLayer, geom);
  }

  private ensureGeom(idx: number): Promise<PageGeom | null> {
    const cached = this.geoms.get(idx);
    if (cached) return Promise.resolve(cached);
    let promise = this.geomPromises.get(idx);
    if (!promise) {
      promise = (async () => {
        try {
          if (!this.pdfDoc) return null;
          const page = await this.pdfDoc.getPage(idx + 1);
          const vp1 = page.getViewport({ scale: 1 });
          const geom: PageGeom = { vp1, w: vp1.width, h: vp1.height };
          if (!this.destroyed) this.geoms.set(idx, geom);
          return geom;
        } catch (e) {
          console.error(`${LOG_TAG} native overlay: failed to load geometry for page ${idx + 1}`, e);
          return null;
        }
      })();
      this.geomPromises.set(idx, promise);
    }
    return promise;
  }

  private paintPage(
    idx: number,
    pageEl: HTMLElement,
    layer: HTMLElement,
    noteLayer: HTMLElement,
    geom: PageGeom
  ): void {
    layer.empty();
    noteLayer.empty();
    const store = this.store;
    if (!store) return;

    const box = pageContentBox(pageEl);
    if (box && !aspectMatches(box, geom)) {
      this.warnRotatedOnce();
      return;
    }
    const pxScale = box && geom.w > 0 ? box.width / geom.w : 1;

    const marks = store.byPage(idx).filter((h) => annotationTypeOf(h) === "highlight");

    const fillRects: PaintRect[] = [];
    let order = 0;
    for (const h of marks) {
      if (markStyleOf(h) !== "highlight") continue;
      order++;
      for (const r of rectsToBase(geom, h.rects)) {
        if (r.right - r.left < 0.25 || r.bottom - r.top < 0.25) continue;
        fillRects.push({
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          color: h.color,
          order,
          ids: new Set([h.id]),
          notes: h.note ? new Set([h.note]) : new Set<string>(),
        });
      }
    }
    for (const r of occludePaintRects(coalescePaintRects(fillRects))) {
      const div = layer.createDiv({ cls: "lpa-highlight lpa-mark--highlight" });
      applyPctBox(div, r, geom);
      div.style.setProperty("--lpa-hl-color", highlightPaintColor(r.color));
      const ids = Array.from(r.ids);
      div.dataset.hlIds = ids.join(" ");
      if (ids.length === 1) div.dataset.hlId = ids[0];
      if (r.notes.size === 1) div.setAttribute("aria-label", Array.from(r.notes)[0]);
      div.toggleClass("is-active", !!this.activeId && ids.includes(this.activeId));
      div.toggleClass("is-hover", !!this.hoverId && ids.includes(this.hoverId));
    }

    const metrics = lineMetricsFor(pxScale);
    for (const h of marks) {
      const st = markStyleOf(h);
      if (st === "highlight") continue;
      for (const lr of mergeLineRects(rectsToBase(geom, h.rects))) {
        this.paintDecorativeLine(layer, h, st, lr, metrics, geom);
      }
    }

    for (const tag of store.byPage(idx).filter((h) => annotationTypeOf(h) === "tag")) {
      this.paintTag(noteLayer, tag);
    }
  }

  private paintDecorativeLine(
    layer: HTMLElement,
    h: Highlight,
    st: MarkStyle,
    lr: BaseRect,
    m: LineMetrics,
    geom: PageGeom
  ): void {
    const el = layer.createDiv({ cls: `lpa-highlight lpa-mark lpa-mark--${st}` });
    applyPctBox(el, lr, geom);
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
      const faint = withAlpha(ink, 0.5);
      el.style.setProperty(
        "--lpa-deco",
        `repeating-linear-gradient(90deg, ${faint} 0 ${m.dot}px, transparent ${m.dot}px ${m.dot + m.dotGap}px)`
      );
    } else {
      el.style.setProperty("--lpa-deco", ink);
    }
    el.dataset.hlIds = h.id;
    el.dataset.hlId = h.id;
    if (h.note) el.setAttribute("aria-label", h.note);
    el.toggleClass("is-active", h.id === this.activeId);
    el.toggleClass("is-hover", h.id === this.hoverId);
  }

  private paintTag(noteLayer: HTMLElement, tag: Highlight): void {
    if (!Number.isFinite(tag.tagX) || !Number.isFinite(tag.tagY)) return;
    const x = clamp(0, tag.tagX ?? 0, 100);
    const y = clamp(0, tag.tagY ?? 0, 100);
    const el = noteLayer.createDiv({ cls: "lpa-page-tag" });
    el.dataset.hlId = tag.id;
    el.dataset.annotationId = tag.id;
    el.setCssProps({ left: `${x}%`, top: `${y}%` });
    el.style.setProperty(
      "--lpa-accent",
      resolvePalette(annotationColor(tag))?.ink ?? markInkColor(annotationColor(tag))
    );
    el.toggleClass("is-pinned", !!tag.isPinned);
    el.toggleClass("is-active", tag.id === this.activeId);
    el.toggleClass("is-hover", tag.id === this.hoverId);
    el.createSpan({ cls: "lpa-tag-dot", attr: { "aria-hidden": "true" } });
    el.createSpan({ cls: "lpa-tag-preview", text: tagPreview(tag) });
    this.bindMarkHover(el, tag.id);
    el.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.openEditPopover(tag.id, evt.clientX, evt.clientY, { focusNote: true });
    });
  }

  private bindMarkHover(el: HTMLElement, id: string | undefined): void {
    if (!id) return;
    el.addEventListener("mouseenter", () => this.setHoveredAnnotation(id));
    el.addEventListener("mouseleave", () => this.clearHoveredAnnotationSoon(id));
  }

  private repaintPage(idx: number): void {
    const root = this.contentRoot;
    if (!root) return;
    const pageEl = root.querySelector<HTMLElement>(`.page[data-page-number="${idx + 1}"]`);
    if (pageEl) void this.syncPage(idx, pageEl);
  }

  private warnRotatedOnce(): void {
    if (this.warnedRotated) return;
    this.warnedRotated = true;
    new Notice(
      "PDF Annotator: this page is rotated in the native viewer — annotations are hidden there to avoid misplacement."
    );
  }

  // ---- geometry: DOM ↔ PDF user space ---------------------------------------

  private collectPageBoxes(): PageBox[] {
    const root = this.contentRoot;
    if (!root) return [];
    const out: PageBox[] = [];
    for (const pageEl of Array.from(root.querySelectorAll<HTMLElement>(".page[data-page-number]"))) {
      const num = Number(pageEl.getAttribute("data-page-number"));
      if (!Number.isFinite(num) || num < 1) continue;
      const box = pageContentBox(pageEl);
      if (!box) continue;
      out.push({ idx: num - 1, pageEl, box });
    }
    return out;
  }

  private pageBoxAtPoint(x: number, y: number): PageBox | null {
    return (
      this.collectPageBoxes().find(
        (b) => x >= b.box.left && x <= b.box.right && y >= b.box.top && y <= b.box.bottom
      ) ?? null
    );
  }

  private annotationAtPoint(x: number, y: number): Highlight | null {
    const store = this.store;
    if (!store) return null;
    const hit = this.pageBoxAtPoint(x, y);
    if (!hit) return null;
    const geom = this.geoms.get(hit.idx);
    if (!geom || !aspectMatches(hit.box, geom)) return null;
    const [px, py] = clientToPdfPoint(x, y, hit.box, geom);
    const matches = store.byPage(hit.idx).filter(
      (h) =>
        annotationTypeOf(h) === "highlight" &&
        h.rects.some(
          (r) =>
            px >= Math.min(r.x1, r.x2) &&
            px <= Math.max(r.x1, r.x2) &&
            py >= Math.min(r.y1, r.y2) &&
            py <= Math.max(r.y1, r.y2)
        )
    );
    return matches[matches.length - 1] ?? null;
  }

  // ---- selection → highlight -------------------------------------------------

  private onMouseUp(evt: MouseEvent): void {
    if (this.destroyed || !this.store || this.tagMode) return;
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".lpa-selection-popover, .lpa-mark-popover, .lpa-native-controls, .lpa-native-roll, .lpa-native-margins")) return;
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      void this.captureSelection(sel, evt.clientX, evt.clientY);
    }
  }

  private async captureSelection(sel: Selection, anchorX: number, anchorY: number): Promise<void> {
    const text = sel.toString().trim();
    if (!text) return;
    const boxes = this.collectPageBoxes();
    if (!boxes.length) return;

    const rawByPage = new Map<number, { box: DOMRect; rects: DOMRect[] }>();
    for (let ri = 0; ri < sel.rangeCount; ri++) {
      const range = sel.getRangeAt(ri);
      for (const cr of Array.from(range.getClientRects())) {
        if (cr.width < 1 || cr.height < 1) continue;
        const cx = cr.left + cr.width / 2;
        const cy = cr.top + cr.height / 2;
        const hit = boxes.find(
          (b) => cx >= b.box.left && cx <= b.box.right && cy >= b.box.top && cy <= b.box.bottom
        );
        if (!hit) continue;
        const entry = rawByPage.get(hit.idx) ?? { box: hit.box, rects: [] };
        entry.rects.push(cr);
        rawByPage.set(hit.idx, entry);
      }
    }
    if (rawByPage.size === 0) return;

    const byPage = new Map<number, PdfRect[]>();
    let rotated = false;
    for (const [idx, entry] of rawByPage) {
      const geom = await this.ensureGeom(idx);
      if (this.destroyed) return;
      if (!geom) continue;
      if (!aspectMatches(entry.box, geom)) {
        rotated = true;
        continue;
      }
      const rects: PdfRect[] = [];
      for (const cr of entry.rects) {
        const p1 = clientToPdfPoint(cr.left, cr.top, entry.box, geom);
        const p2 = clientToPdfPoint(cr.right, cr.bottom, entry.box, geom);
        rects.push({ x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] });
      }
      if (rects.length) byPage.set(idx, rects);
    }
    if (rotated) this.warnRotatedOnce();
    if (byPage.size === 0) return;

    this.pendingSelection = { text, byPage };
    this.showSelectionPopover(anchorX, anchorY);
  }

  private showSelectionPopover(x: number, y: number): void {
    this.selectionPopoverEl?.remove();
    const root = this.contentRoot;
    if (!root) return;
    const doc = root.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-selection-popover is-right lpa-native-selection-popover" });
    this.selectionPopoverEl = pop;
    pop.style.setProperty(
      "--lpa-accent",
      resolvePalette(this.currentColor)?.ink ?? markInkColor(this.currentColor)
    );
    pop.onmousedown = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    };

    const swatches = pop.createDiv({ cls: "lpa-selection-swatches", attr: { "aria-label": "Highlight color" } });
    const palette = this.getActivePalette();
    for (const p of palette) {
      const sw = swatches.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name, title: p.name } });
      
      // FIX: Imposta il colore di sfondo reale sul DOM oltre alle proprietà custom
      sw.style.backgroundColor = p.fill;
      sw.style.setProperty("--lpa-fill", p.fill);
      sw.style.setProperty("--lpa-ink", p.ink);

      sw.dataset.color = p.fill;
      sw.toggleClass("is-active", p.fill === this.currentColor);
      sw.onclick = (evt) => {
        evt.preventDefault();
        this.currentColor = p.fill;
        pop.style.setProperty("--lpa-accent", p.ink);
        for (const candidate of Array.from(swatches.querySelectorAll<HTMLElement>(".lpa-swatch"))) {
          candidate.toggleClass("is-active", candidate.dataset.color === p.fill);
        }
      };
    }

    const highlightBtn = pop.createEl("button", { cls: "lpa-selection-action", text: "Highlight" });
    highlightBtn.onclick = (evt) => {
      evt.preventDefault();
      this.commitSelection("highlight", x, y);
    };
    const annotateBtn = pop.createEl("button", {
      cls: "lpa-selection-action lpa-selection-action-primary",
      text: "Annotate",
    });
    annotateBtn.onclick = (evt) => {
      evt.preventDefault();
      this.commitSelection("annotate", x, y);
    };
    const copyBtn = pop.createEl("button", { cls: "lpa-selection-action lpa-selection-action-quiet", text: "Copy" });
    copyBtn.onclick = async (evt) => {
      evt.preventDefault();
      await navigator.clipboard.writeText(this.pendingSelection?.text ?? "");
      new Notice("Copied selected text");
    };

    pop.setCssProps({ visibility: "hidden" });
    const pr = pop.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const px = clamp(8, x + 8, Math.max(8, vw - pr.width - 8));
    const py = clamp(8, y + 14, Math.max(8, vh - pr.height - 8));
    pop.setCssProps({ left: `${px}px`, top: `${py}px`, visibility: "visible" });
  }

  private hideSelectionPopover(clearNativeSelection: boolean): void {
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    if (clearNativeSelection) {
      this.contentRoot?.ownerDocument.getSelection()?.removeAllRanges();
    }
  }

  private onSelectionChange(): void {
    if (!this.selectionPopoverEl) return;
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      this.hideSelectionPopover(false);
    }
  }

  private commitSelection(mode: "highlight" | "annotate", anchorX: number, anchorY: number): void {
    const pending = this.pendingSelection;
    const store = this.store;
    if (!pending || !store) return;
    const created: Highlight[] = [];
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
      store.add(h);
      created.push(h);
    }
    this.hideSelectionPopover(true);
    for (const h of created) this.repaintPage(h.page);
    this.notifyStoreChanged();
    if (mode === "annotate" && created[0]) {
      this.openEditPopover(created[0].id, anchorX, anchorY, { focusNote: true });
    } else if (created[0]) {
      this.setActiveAnnotation(created[0].id);
      void this.ensureReadableRailForAnnotation(created[0].id);
    }
  }

  // ---- clicks: tags + mark editing --------------------------------------------

  private onClick(evt: MouseEvent): void {
    if (this.destroyed || !this.store) return;
    const target = evt.target as HTMLElement | null;
    if (
      target?.closest(
        ".pdf-toolbar, .lpa-page-tag, .lpa-native-controls, .lpa-native-roll, .lpa-mark-popover, .lpa-selection-popover, .lpa-native-margins"
      )
    ) {
      return;
    }
    if (this.tagMode) {
      const created = this.createTagAt(evt.clientX, evt.clientY);
      if (created) {
        evt.preventDefault();
        evt.stopPropagation();
        this.setTagMode(false);
        this.openEditPopover(created.id, evt.clientX, evt.clientY, { focusNote: true });
      }
      return;
    }
    const sel = this.contentRoot?.ownerDocument.getSelection();
    if (sel && !sel.isCollapsed) return;
    if (target?.closest("a, .annotationLayer")) return;
    const hit = this.annotationAtPoint(evt.clientX, evt.clientY);
    if (hit) {
      evt.preventDefault();
      this.openEditPopover(hit.id, evt.clientX, evt.clientY, {});
    } else {
      this.setActiveAnnotation(null);
    }
  }

  private createTagAt(clientX: number, clientY: number): Highlight | null {
    const store = this.store;
    if (!store) return null;
    const hit = this.pageBoxAtPoint(clientX, clientY);
    if (!hit) return null;
    const xPct = clamp(0, ((clientX - hit.box.left) / Math.max(1, hit.box.width)) * 100, 100);
    const yPct = clamp(0, ((clientY - hit.box.top) / Math.max(1, hit.box.height)) * 100, 100);
    const tag: Highlight = {
      id: newId(),
      type: "tag",
      page: hit.idx,
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
    store.add(tag);
    this.repaintPage(hit.idx);
    this.notifyStoreChanged();
    return tag;
  }

  private onKeyDown(evt: KeyboardEvent): void {
    if (evt.key !== "Escape") return;
    if (this.tagMode) {
      this.setTagMode(false);
      return;
    }
    if (this.selectionPopoverEl) this.hideSelectionPopover(false);
  }

  /** Style + color + note editor for an existing mark or tag. */
  private openEditPopover(
    id: string,
    x: number,
    y: number,
    options: { focusNote?: boolean }
  ): void {
    const store = this.store;
    const initial = store?.get(id);
    if (!store || !initial) return;
    this.closeEditPopover();
    this.setActiveAnnotation(id);
    void this.ensureReadableRailForAnnotation(id);
    const root = this.contentRoot;
    if (!root) return;
    const doc = root.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-mark-popover lpa-native-edit-popover" });
    const type = annotationTypeOf(initial);

    const repaint = () => {
      const cur = store.get(id);
      this.repaintPage((cur ?? initial).page);
      this.notifyStoreChanged();
    };

    let styleRow: HTMLElement | null = null;
    if (type === "highlight") {
      styleRow = pop.createDiv({ cls: "lpa-styles", attr: { role: "radiogroup", "aria-label": "Mark style" } });
      const syncStyleChecks = () => {
        const cur = markStyleOf(store.get(id));
        for (const b of Array.from(styleRow!.children) as HTMLElement[]) {
          b.toggleClass("is-active", b.dataset.style === cur);
        }
      };
      for (const st of MARK_STYLES) {
        const btn = styleRow.createEl("button", {
          cls: "lpa-style-btn",
          attr: { "aria-label": MARK_STYLE_LABELS[st], title: MARK_STYLE_LABELS[st] },
        });
        btn.dataset.style = st;
        const pal = resolvePalette(store.get(id)?.color ?? initial.color);
        btn.createSpan({ cls: `lpa-style-sample lpa-style-sample--${st}`, text: "A", attr: { "aria-hidden": "true" } });
        btn.style.setProperty("--lpa-ink", pal?.ink ?? initial.color);
        btn.style.setProperty("--lpa-fill", pal?.fill ?? initial.color);
        btn.onclick = () => {
          store.update(id, { style: st });
          repaint();
          syncStyleChecks();
        };
      }
      syncStyleChecks();
    }

    const colorRow = pop.createDiv({ cls: "lpa-swatches" });
    const syncColorChecks = () => {
      const cur = store.get(id);
      const active = cur ? annotationColor(cur) : null;
      for (const sw of Array.from(colorRow.children) as HTMLElement[]) {
        sw.toggleClass("is-active", sw.dataset.color === active);
      }
    };
    const palette = this.getActivePalette();
    for (const p of palette) {
      const sw = colorRow.createEl("button", { cls: "lpa-swatch", attr: { "aria-label": p.name } });
      
      // FIX: Imposta il colore di sfondo reale sul DOM oltre alle proprietà custom
      sw.style.backgroundColor = p.fill;
      sw.style.setProperty("--lpa-fill", p.fill);
      sw.style.setProperty("--lpa-ink", p.ink);

      sw.dataset.color = p.fill;
      sw.onclick = () => {
        const patch: Partial<Highlight> =
          type === "tag" ? { color: p.fill, tagColor: p.fill } : { color: p.fill };
        store.update(id, patch);
        repaint();
        if (styleRow) {
          for (const b of Array.from(styleRow.children) as HTMLElement[]) {
            b.style.setProperty("--lpa-ink", p.ink);
            b.style.setProperty("--lpa-fill", p.fill);
          }
        }
        syncColorChecks();
      };
    }
    syncColorChecks();

    if (type === "highlight" && initial.text) {
      pop.createDiv({ cls: "lpa-native-popover-source", text: shortAnnotationText(initial.text, 160) });
    }

    const note = pop.createEl("textarea", {
      cls: "lpa-native-note",
      attr: {
        placeholder: type === "tag" ? "Page note" : "Note",
        rows: "3",
        "aria-label": type === "tag" ? "Page note" : "Annotation note",
      },
    });
    note.value = initial.note ?? "";
    note.oninput = () => {
      store.update(id, { note: note.value });
      repaint();
    };

    const sideNote = pop.createEl("textarea", {
      cls: "lpa-native-note lpa-native-side-note",
      attr: { placeholder: "Side note", rows: "2", "aria-label": "Side note" },
    });
    sideNote.value = initial.noteContentCJK ?? "";
    sideNote.oninput = () => {
      store.update(id, { noteContentCJK: sideNote.value.trim() ? sideNote.value : undefined });
      this.notifyStoreChanged();
    };

    const actions = pop.createDiv({ cls: "lpa-popover-actions" });
    const copyBtn = actions.createEl("button", { text: "Copy" });
    copyBtn.onclick = async () => {
      const cur = store.get(id);
      await navigator.clipboard.writeText((cur?.note || cur?.text || tagPreview(cur ?? initial)).trim());
      new Notice("Copied annotation text");
    };
    const delBtn = actions.createEl("button", { cls: "lpa-danger", text: "Delete" });
    delBtn.onclick = () => {
      const page = store.get(id)?.page ?? initial.page;
      store.remove(id);
      this.closeEditPopover();
      this.repaintPage(page);
      this.notifyStoreChanged();
    };

    pop.setCssProps({ visibility: "hidden" });
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    const pr = pop.getBoundingClientRect();
    let px = x + 6;
    let py = y + 10;
    if (px + pr.width > vw - 8) px = Math.max(8, vw - pr.width - 8);
    if (py + pr.height > vh - 8) py = Math.max(8, y - pr.height - 10);
    pop.setCssProps({ left: `${px}px`, top: `${py}px`, visibility: "visible" });

    const onDocPointer = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node)) this.closeEditPopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeEditPopover();
    };
    window.setTimeout(() => doc.addEventListener("mousedown", onDocPointer, true), 0);
    doc.addEventListener("keydown", onKey, true);
    this.editPopoverCleanup = () => {
      doc.removeEventListener("mousedown", onDocPointer, true);
      doc.removeEventListener("keydown", onKey, true);
      pop.remove();
    };

    if (options.focusNote) {
      window.setTimeout(() => {
        note.focus();
        note.selectionStart = note.selectionEnd = note.value.length;
      }, 0);
    }
  }

  private closeEditPopover(): void {
    this.editPopoverCleanup?.();
    this.editPopoverCleanup = null;
  }

  // ---- margin rails: side note cards beside the native pages -------------------

  private initMarginRail(): void {
    const root = this.contentRoot;
    if (!root) return;
    this.marginsEl = root.createDiv({ cls: "lpa-native-margins" });
    const svg = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("lpa-connection-layer", "lpa-native-connections");
    this.marginsEl.appendChild(svg);
    this.connectionSvg = svg;
    this.leftRailEl = this.marginsEl.createDiv({
      cls: "lpa-margin lpa-margin-left lpa-native-rail",
      attr: { "aria-label": "Left annotations" },
    });
    this.rightRailEl = this.marginsEl.createDiv({
      cls: "lpa-margin lpa-margin-right lpa-native-rail",
      attr: { "aria-label": "Right annotations" },
    });

    this.bindRailScroller(this.findScroller() ?? root);
    this.railResizeObserver = new ResizeObserver(() => this.scheduleRailLayout());
    this.railResizeObserver.observe(root);
    this.cleanups.push(() => {
      this.railScrollTarget?.removeEventListener("scroll", this.railScrollHandler);
      this.railScrollTarget = null;
      this.railResizeObserver?.disconnect();
      this.railResizeObserver = null;
    });
  }

  private onNativeScroll(): void {
    if (this.destroyed || !this.marginsEl) return;
    this.marginsEl.addClass("is-scrolling");
    this.scheduleRailLayout();
    const win = this.marginsEl.ownerDocument.defaultView ?? window;
    if (this.scrollSettleTimer !== null) win.clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = win.setTimeout(() => {
      this.scrollSettleTimer = null;
      this.marginsEl?.removeClass("is-scrolling");
      this.scheduleRailLayout();
    }, 120);
  }

  private scheduleRailLayout(): void {
    if (this.destroyed || this.railRaf !== null || !this.marginsEl) return;
    const win = this.marginsEl.ownerDocument.defaultView ?? window;
    this.railRaf = win.requestAnimationFrame(() => {
      this.railRaf = null;
      this.layoutRail();
    });
  }

  private findScroller(): HTMLElement | null {
    const root = this.contentRoot;
    if (!root) return null;
    if (this.scroller?.isConnected && root.contains(this.scroller)) return this.scroller;
    this.scroller = null;
    const page = root.querySelector<HTMLElement>(".page[data-page-number]");
    const win = root.ownerDocument.defaultView;
    let el: HTMLElement | null = page?.parentElement ?? null;
    while (el && el !== root) {
      const overflowY = win?.getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        this.scroller = el;
        break;
      }
      el = el.parentElement;
    }
    return this.scroller ?? root;
  }

  private bindRailScroller(scroller: HTMLElement): void {
    if (this.railScrollTarget === scroller) return;
    this.railScrollTarget?.removeEventListener("scroll", this.railScrollHandler);
    this.railScrollTarget = scroller;
    scroller.addEventListener("scroll", this.railScrollHandler, { passive: true });
  }

  private async ensureReadableRailForAnnotation(id: string): Promise<void> {
    const store = this.store;
    const first = store?.get(id);
    if (!store || !first) return;
    const token = ++this.railAutoZoomToken;
    if (!this.geoms.has(first.page)) {
      await this.ensureGeom(first.page);
    }

    let step = 0;
    let measureAttempts = 0;
    while (step < RAIL_AUTO_ZOOM_MAX_STEPS) {
      if (this.destroyed || this.activeId !== id || token !== this.railAutoZoomToken) return;
      const measure = this.measureAnnotationRail(id);
      if (!measure) {
        if (++measureAttempts >= RAIL_AUTO_ZOOM_MEASURE_ATTEMPTS) return;
        await sleep(100);
        continue;
      }
      measureAttempts = 0;
      if (measure.width >= RAIL_READABLE_WIDTH) {
        this.scheduleRailLayout();
        return;
      }

      const zoomOut = this.findNativeZoomOutControl();
      if (!zoomOut || this.isDisabledControl(zoomOut)) {
        this.scheduleRailLayout();
        return;
      }

      zoomOut.click();
      step++;
      await this.waitForRailAutoZoomSettle();
    }
    this.scheduleRailLayout();
  }

  private measureAnnotationRail(id: string): { side: "left" | "right"; width: number } | null {
    const root = this.contentRoot;
    const store = this.store;
    const h = store?.get(id);
    if (!root || !store || !h) return null;

    const rootRect = root.getBoundingClientRect();
    const scroller = this.findScroller() ?? root;
    this.bindRailScroller(scroller);
    const areaRect = scroller === root ? rootRect : scroller.getBoundingClientRect();
    if (areaRect.width < 60 || areaRect.height < 60) return null;

    let pageLeft = Infinity;
    let pageRight = -Infinity;
    let target: { box: DOMRect; geom: PageGeom } | null = null;
    for (const b of this.collectPageBoxes()) {
      if (b.box.bottom <= areaRect.top || b.box.top >= areaRect.bottom) continue;
      pageLeft = Math.min(pageLeft, b.box.left);
      pageRight = Math.max(pageRight, b.box.right);
      if (b.idx !== h.page) continue;
      const geom = this.geoms.get(b.idx);
      if (geom && aspectMatches(b.box, geom)) target = { box: b.box, geom };
    }
    if (!Number.isFinite(pageLeft) || !Number.isFinite(pageRight) || !target) return null;

    const naturalLeftWidth = Math.max(0, pageLeft - areaRect.left);
    const naturalRightWidth = Math.max(0, areaRect.right - RAIL_SCROLLBAR_GUTTER - pageRight);
    this.railWidths = { left: naturalLeftWidth, right: naturalRightWidth };

    const anchor = this.computeNativeAnchor(h, target.box, target.geom, areaRect);
    if (!anchor) return null;
    return {
      side: anchor.side,
      width: anchor.side === "left" ? naturalLeftWidth : naturalRightWidth,
    };
  }

  private findNativeZoomOutControl(): HTMLElement | null {
    const container = this.leaf.view.containerEl;
    const toolbar = container.querySelector<HTMLElement>(".pdf-toolbar") ?? container;
    const raw = Array.from(
      toolbar.querySelectorAll<HTMLElement>("button, [role='button'], .clickable-icon, [aria-label], [title]")
    );
    const candidates: HTMLElement[] = [];
    for (const el of raw) {
      if (el.closest(".lpa-native-controls")) continue;
      const clickable = el.closest<HTMLElement>("button, [role='button'], .clickable-icon") ?? el;
      if (!toolbar.contains(clickable) || clickable.closest(".lpa-native-controls")) continue;
      if (!candidates.includes(clickable)) candidates.push(clickable);
    }

    const direct = candidates.find((el) => this.isZoomOutLabel(this.controlLabel(el)));
    if (direct) return direct;

    const zoomInIdx = candidates.findIndex((el) => this.isZoomInLabel(this.controlLabel(el)));
    if (zoomInIdx > 0) return candidates[zoomInIdx - 1] ?? null;
    return null;
  }

  private controlLabel(el: HTMLElement): string {
    const svg = el.querySelector<SVGElement>("svg");
    return [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("data-tooltip"),
      el.textContent,
      el.className,
      svg?.getAttribute("aria-label"),
      svg?.getAttribute("class"),
      svg?.getAttribute("data-icon"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  private isZoomOutLabel(label: string): boolean {
    return /zoom\s*out|zoom-out|缩小|縮小|minus/.test(label);
  }

  private isZoomInLabel(label: string): boolean {
    return /zoom\s*in|zoom-in|放大|plus/.test(label);
  }

  private isDisabledControl(el: HTMLElement): boolean {
    return !!el.closest("[disabled], [aria-disabled='true'], .is-disabled, .mod-disabled");
  }

  private waitForRailAutoZoomSettle(): Promise<void> {
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    return new Promise((resolve) => {
      win.setTimeout(() => {
        this.scheduleSync();
        this.scheduleRailLayout();
        resolve();
      }, RAIL_AUTO_ZOOM_SETTLE_MS);
    });
  }

  private layoutRail(): void {
    if (this.destroyed) return;
    const root = this.contentRoot;
    const margins = this.marginsEl;
    const store = this.store;
    if (!root || !margins || !this.leftRailEl || !this.rightRailEl || !store) return;

    const rootRect = root.getBoundingClientRect();
    const scroller = this.findScroller() ?? root;
    this.bindRailScroller(scroller);
    if (scroller !== root && this.railResizeObserver) {
      this.railResizeObserver.observe(scroller);
      if (scroller.firstElementChild instanceof HTMLElement) {
        this.railResizeObserver.observe(scroller.firstElementChild);
      }
    }
    const areaRect = scroller === root ? rootRect : scroller.getBoundingClientRect();
    if (areaRect.width < 60 || areaRect.height < 60) {
      this.clearRail();
      return;
    }
    margins.setCssProps({
      left: `${Math.round(areaRect.left - rootRect.left)}px`,
      top: `${Math.round(areaRect.top - rootRect.top)}px`,
      width: `${Math.round(areaRect.width)}px`,
      height: `${Math.round(areaRect.height)}px`,
    });

    const pages = new Map<number, { box: DOMRect; geom: PageGeom }>();
    let pageLeft = Infinity;
    let pageRight = -Infinity;
    for (const b of this.collectPageBoxes()) {
      if (b.box.bottom <= areaRect.top || b.box.top >= areaRect.bottom) continue;
      const geom = this.geoms.get(b.idx);
      if (!geom) {
        if (store.byPage(b.idx).length > 0) {
          void this.ensureGeom(b.idx).then((g) => {
            if (g) this.scheduleRailLayout();
          });
        }
        continue;
      }
      if (!aspectMatches(b.box, geom)) continue;
      pages.set(b.idx, { box: b.box, geom });
      pageLeft = Math.min(pageLeft, b.box.left);
      pageRight = Math.max(pageRight, b.box.right);
    }
    if (pages.size === 0) {
      this.clearRail();
      return;
    }

    const naturalLeftWidth = Math.max(0, pageLeft - areaRect.left);
    const naturalRightWidth = Math.max(0, areaRect.right - RAIL_SCROLLBAR_GUTTER - pageRight);
    this.railWidths = { left: naturalLeftWidth, right: naturalRightWidth };
    this.applyRailWidth(this.leftRailEl, naturalLeftWidth);
    this.applyRailWidth(this.rightRailEl, naturalRightWidth);
    this.rightRailEl.setCssProps({ right: `${RAIL_SCROLLBAR_GUTTER}px` });

    const desired: RailEntry[] = [];
    for (const [idx, page] of pages) {
      for (const h of store.byPage(idx)) {
        if (!this.wantsMarginCard(h)) continue;
        const anchor = this.computeNativeAnchor(h, page.box, page.geom, areaRect);
        if (!anchor) continue;
        const railWidth = anchor.side === "left" ? naturalLeftWidth : naturalRightWidth;
        if (railWidth < RAIL_HIDE_WIDTH) continue;
        desired.push({ h, anchor });
      }
    }

    this.reconcileRailCards(desired);
    this.stackRailCards(desired);
    this.drawRailConnections(desired, areaRect);
  }

  private clearRail(): void {
    this.railWidths = { left: 0, right: 0 };
    this.reconcileRailCards([]);
    const svg = this.connectionSvg;
    if (svg) while (svg.firstChild) svg.firstChild.remove();
  }

  private applyRailWidth(rail: HTMLElement, width: number): void {
    const rounded = Math.max(0, Math.round(width));
    rail.setCssProps({ width: `${rounded}px` });
    rail.toggleClass("is-collapsed", rounded < RAIL_HIDE_WIDTH);
    rail.toggleClass("is-tight", rounded >= RAIL_HIDE_WIDTH && rounded < 92);
    rail.toggleClass("is-compact", rounded >= 92 && rounded < 132);
    rail.toggleClass("is-roomy", rounded >= 180);
    rail.toggleClass("is-spacious", rounded >= 260);
  }

  private wantsMarginCard(h: Highlight): boolean {
    if (annotationTypeOf(h) === "tag") {
      return !!h.isPinned || h.id === this.hoverId || h.id === this.activeId;
    }
    return (
      typeof h.note === "string" ||
      !!h.noteContentCJK ||
      !!h.isPinned ||
      h.id === this.hoverId ||
      h.id === this.activeId
    );
  }

  private computeNativeAnchor(
    h: Highlight,
    box: DOMRect,
    geom: PageGeom,
    areaRect: DOMRect
  ): NativeAnchor | null {
    const explicit = h.marginSide === "left" || h.marginSide === "right" ? h.marginSide : null;
    const pageLeftX = box.left - areaRect.left;
    const pageRightX = box.right - areaRect.left;
    const pageTopY = box.top - areaRect.top;
    const pageBottomY = box.bottom - areaRect.top;

    if (annotationTypeOf(h) === "tag") {
      if (typeof h.tagX !== "number" || typeof h.tagY !== "number") return null;
      const sourceX = pageLeftX + (clamp(0, h.tagX, 100) / 100) * box.width;
      const sourceY = box.top - areaRect.top + (clamp(0, h.tagY, 100) / 100) * box.height;
      const side = this.chooseRailSide(explicit, h.tagX < 50 ? "left" : "right");
      return {
        side,
        sourceX,
        sourceY,
        idealY: sourceY,
        pageTopY,
        pageBottomY,
        pageLeftX,
        pageRightX,
      };
    }

    if (h.rects.length === 0) return null;
    const base = rectsToBase(geom, h.rects).filter(
      (r) => r.right - r.left >= 0.5 && r.bottom - r.top >= 0.5
    );
    if (base.length === 0) return null;
    const lines = mergeLineRects(base);
    const first = lines[0] ?? base[0];
    const left = Math.min(...base.map((r) => r.left));
    const right = Math.max(...base.map((r) => r.right));
    const sx = box.width / geom.w;
    const sy = box.height / geom.h;
    const side = this.chooseRailSide(explicit, (left + right) / 2 < geom.w / 2 ? "left" : "right");
    const sourceEdge = side === "left" ? left : right;
    return {
      side,
      sourceX: pageLeftX + sourceEdge * sx,
      sourceY: box.top - areaRect.top + ((first.top + first.bottom) / 2) * sy,
      idealY: box.top - areaRect.top + first.top * sy,
      pageTopY,
      pageBottomY,
      pageLeftX,
      pageRightX,
    };
  }

  private chooseRailSide(
    explicit: "left" | "right" | null,
    preferred: "left" | "right"
  ): "left" | "right" {
    if (explicit) return explicit;
    const { left, right } = this.railWidths;
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

  private reconcileRailCards(desired: RailEntry[]): void {
    const margins = this.marginsEl;
    if (!margins) return;
    const doc = margins.ownerDocument;
    const focused = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const wanted = new Map(desired.map((d) => [d.h.id, d]));

    for (const card of Array.from(margins.querySelectorAll<HTMLElement>(".lpa-native-rail > .lpa-margin-card"))) {
      const id = card.dataset.hlId ?? "";
      const entry = wanted.get(id);
      const holdsFocus = !!focused && card.contains(focused);
      if (!entry) {
        if (!holdsFocus) card.remove();
        continue;
      }
      const rail = entry.anchor.side === "left" ? this.leftRailEl : this.rightRailEl;
      if (rail && card.parentElement !== rail && !holdsFocus) rail.appendChild(card);
      this.syncCardContent(card, entry.h);
      wanted.delete(id);
    }
    for (const entry of wanted.values()) {
      const rail = entry.anchor.side === "left" ? this.leftRailEl : this.rightRailEl;
      if (rail) this.createRailCard(rail, entry.h, entry.anchor.side);
    }
  }

  private createRailCard(rail: HTMLElement, h: Highlight, side: "left" | "right"): HTMLElement {
    const type = annotationTypeOf(h);
    const card = rail.createDiv({ cls: `lpa-margin-card lpa-native-card lpa-margin-card--${type}` });
    card.dataset.hlId = h.id;
    card.dataset.annotationId = h.id;
    card.dataset.side = side;
    card.dataset.placement = "rail";

    card.addEventListener("mouseenter", () => this.setHoveredAnnotation(h.id));
    card.addEventListener("mouseleave", () => this.clearHoveredAnnotationSoon(h.id));
    card.addEventListener("contextmenu", (evt) => this.openCardContextMenu(evt, h.id));
    card.addEventListener("click", (evt) => {
      const target = evt.target as HTMLElement | null;
      if (target?.closest("textarea,button")) return;
      this.setActiveAnnotation(h.id);
      void this.revealAnnotation(h.id);
    });
    card.addEventListener("dblclick", (evt) => {
      evt.preventDefault();
      this.focusRailNote(h.id);
    });
    card.addEventListener("transitionend", (evt) => {
      if (evt.propertyName === "max-height") this.scheduleRailLayout();
    });

    const head = card.createDiv({ cls: "lpa-margin-card-head" });
    head.createSpan({ cls: "lpa-margin-dot", attr: { "aria-hidden": "true" } });
    head.createSpan({ cls: "lpa-margin-page", text: `p.${h.page + 1}` });
    const pin = head.createEl("button", { cls: "lpa-pin-btn", text: "⌖" });
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
    note.onfocus = () => this.setActiveAnnotation(h.id);
    note.oninput = () => {
      this.store?.update(h.id, { note: note.value });
      syncMarginCardPresentation(card);
      this.repaintPage(h.page);
      this.updateCount();
      if (this.listPanelEl) this.renderListItems();
      this.scheduleRailLayout();
    };

    if (type === "highlight" && h.text) {
      card.createDiv({ cls: "lpa-margin-source", text: marginCardSourceText(h.text) });
    }

    const sideNote = card.createEl("textarea", {
      cls: "lpa-margin-side-note",
      attr: { placeholder: "Side note", rows: "2", "aria-label": "Side note" },
    });
    sideNote.value = h.noteContentCJK ?? "";
    sideNote.onfocus = () => this.setActiveAnnotation(h.id);
    sideNote.oninput = () => {
      this.store?.update(h.id, { noteContentCJK: sideNote.value.trim() ? sideNote.value : undefined });
      syncMarginCardPresentation(card);
      if (this.listPanelEl) this.renderListItems();
      this.scheduleRailLayout();
    };

    this.syncCardContent(card, h);
    return card;
  }

  private syncCardContent(card: HTMLElement, h: Highlight): void {
    const pal = resolvePalette(annotationColor(h));
    card.style.setProperty("--lpa-accent", pal?.ink ?? markInkColor(annotationColor(h)));
    card.style.setProperty("--lpa-sticker-bg", stickerBackgroundColor(annotationColor(h), 0.34));
    card.style.setProperty("--lpa-sticker-bg-strong", stickerBackgroundColor(annotationColor(h), 0.52));
    card.toggleClass("is-pinned", !!h.isPinned);
    card.toggleClass("is-active", h.id === this.activeId);
    card.toggleClass("is-hover", h.id === this.hoverId);
    card.toggleClass(
      "is-expanded",
      !!h.isPinned || h.id === this.activeId || h.id === this.hoverId
    );
    const doc = card.ownerDocument;
    const note = card.querySelector<HTMLTextAreaElement>(".lpa-margin-note");
    if (note && doc.activeElement !== note && note.value !== (h.note ?? "")) {
      note.value = h.note ?? "";
    }
    const sideNote = card.querySelector<HTMLTextAreaElement>(".lpa-margin-side-note");
    if (sideNote && doc.activeElement !== sideNote && sideNote.value !== (h.noteContentCJK ?? "")) {
      sideNote.value = h.noteContentCJK ?? "";
    }
    syncMarginCardPresentation(card);
    const pin = card.querySelector<HTMLElement>(".lpa-pin-btn");
    if (pin) {
      const label = h.isPinned ? "Unpin annotation card" : "Pin annotation card";
      pin.setAttribute("aria-label", label);
      pin.setAttribute("title", h.isPinned ? "Unpin" : "Pin");
    }
  }

  private stackRailCards(desired: RailEntry[]): void {
    const byId = new Map(desired.map((d) => [d.h.id, d]));
    for (const rail of [this.leftRailEl, this.rightRailEl]) {
      if (!rail) continue;
      const cards = Array.from(rail.querySelectorAll<HTMLElement>(".lpa-margin-card"));
      const gap = 5;
      const groups = new Map<number, Array<{ card: HTMLElement; entry: RailEntry }>>();
      for (const card of cards) {
        const entry = byId.get(card.dataset.hlId ?? "");
        if (!entry) continue;
        const group = groups.get(entry.h.page) ?? [];
        group.push({ card, entry });
        groups.set(entry.h.page, group);
      }
      for (const group of groups.values()) {
        const anchor = group[0].entry.anchor;
        applyMarginCardDensity(
          group.map(({ card }) => card),
          Math.max(1, anchor.pageBottomY - anchor.pageTopY),
          gap
        );
      }
      const items = Array.from(groups.values()).flat().map(({ card, entry }) => ({
        card,
        entry,
        height: measureMarginCardHeight(card),
      }));
      const tops = layoutPageBoundedCardTops(
        items.map(({ entry, height }) => ({
          page: entry.h.page,
          idealY: entry.anchor.idealY,
          height,
          pageTopY: entry.anchor.pageTopY,
          pageBottomY: entry.anchor.pageBottomY,
        })),
        gap
      );
      items.forEach((item, index) => {
        item.card.setCssProps({ top: `${Math.round(tops[index])}px` });
      });
    }
  }

  private drawRailConnections(desired: RailEntry[], areaRect: DOMRect): void {
    const svg = this.connectionSvg;
    const margins = this.marginsEl;
    if (!svg || !margins) return;
    while (svg.firstChild) svg.firstChild.remove();
    const w = Math.max(1, Math.round(areaRect.width));
    const hgt = Math.max(1, Math.round(areaRect.height));
    svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
    svg.setAttribute("width", `${w}`);
    svg.setAttribute("height", `${hgt}`);
    const marginsRect = margins.getBoundingClientRect();
    const svgNS = "http://www.w3.org/2000/svg";

    for (const { h, anchor } of desired) {
      const card = margins.querySelector<HTMLElement>(
        `.lpa-margin-card[data-hl-id="${cssEscape(h.id)}"]`
      );
      if (!card) continue;
      const cardRect = card.getBoundingClientRect();
      const cardX =
        anchor.side === "left" ? cardRect.right - marginsRect.left : cardRect.left - marginsRect.left;
      const cardY = cardRect.top + cardRect.height / 2 - marginsRect.top;
      const borderX = anchor.side === "left" ? anchor.pageLeftX : anchor.pageRightX;
      const accent = resolvePalette(annotationColor(h))?.ink ?? markInkColor(annotationColor(h));
      const isTag = annotationTypeOf(h) === "tag";
      const engaged = h.id === this.hoverId || h.id === this.activeId;
      const d = isTag
        ? `M ${anchor.sourceX},${anchor.sourceY} C ${borderX},${anchor.sourceY} ${borderX},${cardY} ${cardX},${cardY}`
        : `M ${cardX},${cardY} C ${borderX},${cardY} ${borderX},${anchor.sourceY} ${anchor.sourceX},${anchor.sourceY}`;
      const path = margins.ownerDocument.createElementNS(svgNS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", accent);
      path.classList.add(
        "lpa-connection-line",
        isTag ? "lpa-connection-line--tag" : "lpa-connection-line--highlight"
      );
      if (engaged) path.classList.add("is-hover");
      if (h.isPinned) path.classList.add("is-pinned");
      svg.appendChild(path);

      const dot = margins.ownerDocument.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", `${cardX}`);
      dot.setAttribute("cy", `${cardY}`);
      dot.setAttribute("r", engaged ? "2.5" : "2");
      dot.setAttribute("fill", accent);
      dot.classList.add("lpa-connection-dot");
      if (engaged) dot.classList.add("is-hover");
      if (h.isPinned) dot.classList.add("is-pinned");
      svg.appendChild(dot);
    }
  }

  private focusRailNote(id: string): void {
    const margins = this.marginsEl;
    if (!margins) return;
    const win = margins.ownerDocument.defaultView ?? window;
    win.setTimeout(() => {
      const note = margins.querySelector<HTMLTextAreaElement>(
        `.lpa-margin-card[data-hl-id="${cssEscape(id)}"] .lpa-margin-note`
      );
      note?.focus({ preventScroll: true });
      if (note) note.selectionStart = note.selectionEnd = note.value.length;
    }, 0);
  }

  private toggleAnnotationPin(id: string): void {
    const h = this.store?.get(id);
    if (!h) return;
    this.store?.update(id, { isPinned: !h.isPinned });
    this.repaintPage(h.page);
    this.notifyStoreChanged();
  }

  private openCardContextMenu(evt: MouseEvent, id: string): void {
    const h = this.store?.get(id);
    if (!h) return;
    evt.preventDefault();
    evt.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(h.isPinned ? "Unpin card" : "Pin card")
        .setIcon("pin")
        .onClick(() => this.toggleAnnotationPin(id))
    );
    const moveTo = (side: "left" | "right" | "auto") => {
      this.store?.update(id, { marginSide: side });
      this.notifyStoreChanged();
    };
    menu.addItem((item) =>
      item.setTitle("Move card to left margin").setIcon("arrow-left").onClick(() => moveTo("left"))
    );
    menu.addItem((item) =>
      item.setTitle("Move card to right margin").setIcon("arrow-right").onClick(() => moveTo("right"))
    );
    menu.addItem((item) =>
      item.setTitle("Auto-place card").setIcon("wand").onClick(() => moveTo("auto"))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete annotation")
        .setIcon("trash")
        .onClick(() => {
          const page = this.store?.get(id)?.page ?? h.page;
          this.store?.remove(id);
          this.repaintPage(page);
          this.notifyStoreChanged();
        })
    );
    menu.showAtMouseEvent(evt);
  }

  // ---- hover / active binding between marks, tags, and cards -------------------

  private onPointerMove(evt: MouseEvent): void {
    if (this.destroyed || this.tagMode || !this.store) return;
    const target = evt.target as HTMLElement | null;
    if (
      target?.closest(
        ".lpa-native-margins, .lpa-native-roll, .lpa-native-controls, .lpa-mark-popover, .lpa-selection-popover, .lpa-page-tag"
      )
    ) {
      return;
    }
    this.lastPointer = {
      x: evt.clientX,
      y: evt.clientY,
      pageEl: target?.closest<HTMLElement>(".page[data-page-number]") ?? null,
    };
    if (this.pointerRaf !== null) return;
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    this.pointerRaf = win.requestAnimationFrame(() => {
      this.pointerRaf = null;
      if (this.destroyed || !this.lastPointer) return;
      const hit = this.hoveredHighlightAt(this.lastPointer);
      if (hit) this.setHoveredAnnotation(hit.id);
      else if (this.hoverId) this.clearHoveredAnnotationSoon(this.hoverId);
    });
  }

  private hoveredHighlightAt(p: { x: number; y: number; pageEl: HTMLElement | null }): Highlight | null {
    const store = this.store;
    if (!store || !p.pageEl || !p.pageEl.isConnected) return null;
    const num = Number(p.pageEl.getAttribute("data-page-number"));
    if (!Number.isFinite(num) || num < 1) return null;
    const idx = num - 1;
    const geom = this.geoms.get(idx);
    const box = pageContentBox(p.pageEl);
    if (!geom || !box || !aspectMatches(box, geom)) return null;
    const [px, py] = clientToPdfPoint(p.x, p.y, box, geom);
    const matches = store.byPage(idx).filter(
      (h) =>
        annotationTypeOf(h) === "highlight" &&
        h.rects.some(
          (r) =>
            px >= Math.min(r.x1, r.x2) &&
            px <= Math.max(r.x1, r.x2) &&
            py >= Math.min(r.y1, r.y2) &&
            py <= Math.max(r.y1, r.y2)
        )
    );
    return matches[matches.length - 1] ?? null;
  }

  private setHoveredAnnotation(id: string | null): void {
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.hoverClearTimer !== null) {
      win.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
    const next = id && this.store?.get(id) ? id : null;
    if (this.hoverId === next) return;
    const prev = this.hoverId;
    this.hoverId = next;
    if (this.dynamicTagCardDependsOn(prev) || this.dynamicTagCardDependsOn(next)) {
      this.scheduleRailLayout();
    }
    this.syncBindingState();
  }

  private clearHoveredAnnotationSoon(id?: string): void {
    const win = this.contentRoot?.ownerDocument.defaultView ?? window;
    if (this.hoverClearTimer !== null) win.clearTimeout(this.hoverClearTimer);
    this.hoverClearTimer = win.setTimeout(() => {
      this.hoverClearTimer = null;
      if (!id || this.hoverId === id) this.setHoveredAnnotation(null);
    }, 120);
  }

  private setActiveAnnotation(id: string | null): void {
    const next = id && this.store?.get(id) ? id : null;
    if (this.activeId === next) return;
    const prev = this.activeId;
    this.activeId = next;
    if (this.dynamicTagCardDependsOn(prev) || this.dynamicTagCardDependsOn(next)) {
      this.scheduleRailLayout();
    }
    this.syncBindingState();
  }

  private dynamicTagCardDependsOn(id: string | null): boolean {
    if (!id) return false;
    const h = this.store?.get(id);
    return !!h && annotationTypeOf(h) === "tag" && !h.isPinned;
  }

  private syncBindingState(): void {
    const root = this.contentRoot;
    if (!root) return;
    if (this.marginsEl) {
      for (const card of Array.from(this.marginsEl.querySelectorAll<HTMLElement>(".lpa-margin-card"))) {
        const id = card.dataset.hlId ?? "";
        const pinned = !!id && !!this.store?.get(id)?.isPinned;
        card.toggleClass("is-active", !!id && id === this.activeId);
        card.toggleClass("is-hover", !!id && id === this.hoverId);
        card.toggleClass("is-expanded", pinned || (!!id && (id === this.activeId || id === this.hoverId)));
        syncMarginCardPresentation(card);
      }
      this.scheduleRailLayout();
    }
    for (const mark of Array.from(root.querySelectorAll<HTMLElement>(".lpa-native-hl-layer .lpa-highlight"))) {
      const ids = (mark.dataset.hlIds ?? "").split(/\s+/).filter(Boolean);
      mark.toggleClass("is-active", !!this.activeId && ids.includes(this.activeId));
      mark.toggleClass("is-hover", !!this.hoverId && ids.includes(this.hoverId));
    }
    for (const tag of Array.from(root.querySelectorAll<HTMLElement>(".lpa-native-note-layer .lpa-page-tag"))) {
      const id = tag.dataset.hlId ?? "";
      tag.toggleClass("is-active", !!id && id === this.activeId);
      tag.toggleClass("is-hover", !!id && id === this.hoverId);
    }
    this.scheduleRailLayout();
  }

  // ---- annotation list panel ---------------------------------------------------

  private toggleListPanel(): void {
    if (this.listPanelEl) {
      this.closeListPanel();
      return;
    }
    const root = this.contentRoot;
    if (!root || !this.store) return;
    const panel = root.createDiv({ cls: "lpa-native-roll" });
    this.listPanelEl = panel;
    const head = panel.createDiv({ cls: "lpa-native-roll-head" });
    head.createSpan({ cls: "lpa-native-roll-title", text: "Annotations" });
    head.createSpan({ cls: "lpa-native-roll-meta", text: "" });
    const close = head.createEl("button", {
      cls: "lpa-native-roll-close",
      text: "×",
      attr: { type: "button", "aria-label": "Hide annotations" },
    });
    close.onclick = () => this.closeListPanel();
    const search = panel.createEl("input", {
      cls: "lpa-native-roll-search",
      attr: { type: "search", placeholder: "Search annotations", "aria-label": "Search annotations" },
    });
    search.value = this.listSearchQuery;
    search.oninput = () => {
      this.listSearchQuery = search.value;
      this.renderListItems();
    };
    panel.createDiv({ cls: "lpa-native-roll-list" });
    this.renderListItems();
    this.syncToolbarState();
  }

  private closeListPanel(): void {
    this.listPanelEl?.remove();
    this.listPanelEl = null;
    this.syncToolbarState();
  }

  private renderListItems(): void {
    const panel = this.listPanelEl;
    const store = this.store;
    if (!panel || !store) return;
    const listEl = panel.querySelector<HTMLElement>(".lpa-native-roll-list");
    const metaEl = panel.querySelector<HTMLElement>(".lpa-native-roll-meta");
    if (!listEl) return;

    const annotations = [...store.doc.highlights].sort(
      (a, b) => a.page - b.page || a.created.localeCompare(b.created)
    );
    const query = normalizeSearch(this.listSearchQuery);
    const filtered = query ? annotations.filter((h) => annotationMatchesSearch(h, query)) : annotations;
    metaEl?.setText(query ? `${filtered.length}/${annotations.length}` : String(annotations.length));

    listEl.empty();
    if (annotations.length === 0) {
      listEl.createDiv({ cls: "lpa-native-roll-empty", text: "No annotations yet." });
      return;
    }
    if (filtered.length === 0) {
      listEl.createDiv({ cls: "lpa-native-roll-empty", text: "No matching annotations." });
      return;
    }
    for (const h of filtered) {
      const item = listEl.createDiv({ cls: "lpa-native-roll-item" });
      item.style.setProperty(
        "--lpa-accent",
        resolvePalette(annotationColor(h))?.ink ?? markInkColor(annotationColor(h))
      );
      const head = item.createDiv({ cls: "lpa-native-roll-item-head" });
      head.createSpan({ cls: "lpa-native-roll-page", text: `p.${h.page + 1}` });
      head.createSpan({ cls: "lpa-native-roll-kind", text: annotationKindLabel(h) });
      item.createDiv({ cls: "lpa-native-roll-text", text: rollPrimaryText(h) });
      const secondary = rollSecondaryText(h);
      if (secondary) item.createDiv({ cls: "lpa-native-roll-source", text: secondary });
      item.onclick = () => void this.revealAnnotation(h.id);
    }
  }

  private async revealAnnotation(id: string): Promise<void> {
    const h = this.store?.get(id);
    const root = this.contentRoot;
    if (!h || !root) return;
    this.setActiveAnnotation(id);
    const pageEl = await this.navigateNativeToPage(h.page);
    if (!pageEl) return;
    pageEl.scrollIntoView({ block: "center" });
    void this.ensureReadableRailForAnnotation(id);
    this.scheduleRailLayout();
    const isTag = annotationTypeOf(h) === "tag";
    for (let i = 0; i < 12; i++) {
      await sleep(150);
      if (this.destroyed || !pageEl.isConnected) return;
      let el: HTMLElement | null = null;
      if (isTag) {
        el = pageEl.querySelector<HTMLElement>(
          `.lpa-native-note-layer .lpa-page-tag[data-hl-id="${cssEscape(id)}"]`
        );
      } else {
        el =
          Array.from(pageEl.querySelectorAll<HTMLElement>(".lpa-native-hl-layer .lpa-highlight")).find(
            (cand) => (cand.dataset.hlIds ?? "").split(/\s+/).includes(id)
          ) ?? null;
      }
      if (el) {
        el.addClass("lpa-flash");
        const flashed = el;
        window.setTimeout(() => flashed.removeClass("lpa-flash"), 1200);
        this.scheduleRailLayout();
        return;
      }
    }
  }

  private async navigateNativeToPage(pageIndex: number): Promise<HTMLElement | null> {
    const root = this.contentRoot;
    if (!root) return null;
    const selector = `.page[data-page-number="${pageIndex + 1}"]`;
    const existing = root.querySelector<HTMLElement>(selector);
    if (existing) return existing;

    const input = this.findNativePageNumberInput();
    if (!input) return null;
    const labels = await this.getNativePageLabels();
    if (this.destroyed) return null;
    const label = labels?.[pageIndex] || String(pageIndex + 1);
    input.focus({ preventScroll: true });
    input.value = label;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
    );
    input.blur();

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);
      if (this.destroyed) return null;
      const pageEl = root.querySelector<HTMLElement>(selector);
      if (pageEl) return pageEl;
    }
    return null;
  }

  private findNativePageNumberInput(): HTMLInputElement | null {
    const container = this.leaf.view.containerEl;
    const toolbar = container.querySelector<HTMLElement>(".pdf-toolbar") ?? container;
    return (
      toolbar.querySelector<HTMLInputElement>(
        "input.pdf-page-input, input.pageNumber, input[type='number'], input[aria-label*='page' i], input[title*='page' i]"
      ) ??
      Array.from(toolbar.querySelectorAll<HTMLInputElement>("input")).find(
        (input) => !input.closest(".lpa-native-controls, .lpa-native-roll")
      ) ??
      null
    );
  }

  private getNativePageLabels(): Promise<string[] | null> {
    if (!this.pageLabelsPromise) {
      this.pageLabelsPromise = Promise.resolve(this.pdfDoc?.getPageLabels?.())
        .then((labels) => (Array.isArray(labels) ? labels.map(String) : null))
        .catch(() => null);
    }
    return this.pageLabelsPromise;
  }

  // ---- legacy import (same behavior as the custom annotator view) --------------

  async importLegacyAnnotations(): Promise<void> {
    const store = this.store;
    if (!this.pdfDoc || !store) {
      new Notice("The annotation overlay is still loading — try again in a moment.");
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
    } catch (e) {
      notice.hide();
      console.error(`${LOG_TAG} legacy import indexing failed`, e);
      new Notice("Import failed while indexing the PDF (see console).");
      return;
    }
    if (this.destroyed) {
      notice.hide();
      return;
    }

    const seen = new Set(store.doc.highlights.map((h) => `${h.page}|${dedupeKey(h.text)}`));
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
    store.addMany(created);
    await store.flush();
    for (const p of affected) this.repaintPage(p);
    this.notifyStoreChanged();
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
}

// ---- module helpers (ported from the custom view; base-viewport space) --------

function pageContentBox(pageEl: HTMLElement): DOMRect | null {
  const ref =
    pageEl.querySelector<HTMLElement>(":scope > .textLayer") ??
    pageEl.querySelector<HTMLElement>(":scope > .canvasWrapper") ??
    pageEl.querySelector<HTMLElement>(":scope > .lpa-native-hl-layer") ??
    pageEl;
  const box = ref.getBoundingClientRect();
  return box.width >= 2 && box.height >= 2 ? box : null;
}

function aspectMatches(box: DOMRect, geom: PageGeom): boolean {
  if (geom.w <= 0 || geom.h <= 0 || box.height <= 0) return false;
  const dom = box.width / box.height;
  const base = geom.w / geom.h;
  return Math.abs(dom - base) / base <= 0.04;
}

function clientToPdfPoint(clientX: number, clientY: number, box: DOMRect, geom: PageGeom): [number, number] {
  const bx = ((clientX - box.left) / box.width) * geom.w;
  const by = ((clientY - box.top) / box.height) * geom.h;
  const p = geom.vp1.convertToPdfPoint(bx, by) as number[];
  return [p[0], p[1]];
}

function rectsToBase(geom: PageGeom, rects: PdfRect[]): BaseRect[] {
  const out: BaseRect[] = [];
  for (const r of rects) {
    const a = geom.vp1.convertToViewportPoint(r.x1, r.y1) as number[];
    const b = geom.vp1.convertToViewportPoint(r.x2, r.y2) as number[];
    out.push({
      left: Math.min(a[0], b[0]),
      top: Math.min(a[1], b[1]),
      right: Math.max(a[0], b[0]),
      bottom: Math.max(a[1], b[1]),
    });
  }
  return out;
}

function applyPctBox(el: HTMLElement, r: BaseRect, geom: PageGeom): void {
  el.setCssProps({
    left: `${(r.left / geom.w) * 100}%`,
    top: `${(r.top / geom.h) * 100}%`,
    width: `${((r.right - r.left) / geom.w) * 100}%`,
    height: `${((r.bottom - r.top) / geom.h) * 100}%`,
  });
}

function lineMetricsFor(s: number): LineMetrics {
  return {
    weight: clamp(1.4, s * 1.35, 3),
    dash: Math.max(4, Math.round(s * 5)),
    dashGap: Math.max(3, Math.round(s * 4)),
    dot: Math.max(1.4, +(s * 1.6).toFixed(2)),
    dotGap: Math.max(2.4, +(s * 2.8).toFixed(2)),
  };
}

function coalescePaintRects(rects: PaintRect[]): PaintRect[] {
  const out: PaintRect[] = [];
  const sorted = [...rects].sort(
    (a, b) => a.color.localeCompare(b.color) || a.top - b.top || a.left - b.left || a.order - b.order
  );
  for (const rect of sorted) {
    let cur = clonePaintRect(rect);
    for (;;) {
      const i = out.findIndex((candidate) => canMergePaintRects(cur, candidate));
      if (i < 0) break;
      cur = mergePaintRects(cur, out[i]);
      out.splice(i, 1);
    }
    out.push(cur);
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left);
}

function clonePaintRect(r: PaintRect): PaintRect {
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

function canMergePaintRects(a: PaintRect, b: PaintRect): boolean {
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

function mergePaintRects(a: PaintRect, b: PaintRect): PaintRect {
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

function occludePaintRects(rects: PaintRect[]): PaintRect[] {
  const out: PaintRect[] = [];
  const painted: PaintRect[] = [];
  const sorted = [...rects].sort((a, b) => a.order - b.order || a.top - b.top || a.left - b.left);
  for (const rect of sorted) {
    let pieces = [clonePaintRect(rect)];
    for (const blocker of painted) {
      const next: PaintRect[] = [];
      for (const piece of pieces) next.push(...subtractPaintRect(piece, blocker));
      pieces = next;
      if (pieces.length === 0) break;
    }
    out.push(...pieces);
    painted.push(...pieces);
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left || a.order - b.order);
}

function subtractPaintRect(rect: PaintRect, blocker: PaintRect): PaintRect[] {
  const left = Math.max(rect.left, blocker.left);
  const top = Math.max(rect.top, blocker.top);
  const right = Math.min(rect.right, blocker.right);
  const bottom = Math.min(rect.bottom, blocker.bottom);
  if (right - left <= 0.5 || bottom - top <= 0.5) return [rect];
  const pieces: PaintRect[] = [];
  pushPaintPiece(pieces, rect, rect.left, rect.top, rect.right, top);
  pushPaintPiece(pieces, rect, rect.left, bottom, rect.right, rect.bottom);
  pushPaintPiece(pieces, rect, rect.left, top, left, bottom);
  pushPaintPiece(pieces, rect, right, top, rect.right, bottom);
  return pieces;
}

function pushPaintPiece(
  pieces: PaintRect[],
  source: PaintRect,
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

function mergeLineRects(rects: BaseRect[]): BaseRect[] {
  const clean = rects.filter((r) => r.right - r.left >= 0.5 && r.bottom - r.top >= 0.5);
  const lines: BaseRect[] = [];
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

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

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

function highlightPaintColor(color: string): string {
  const pal = resolvePalette(color);
  const fill = pal?.fill ?? color;
  const c = parseColor(fill);
  if (!c) return fill;
  const a = pal?.highlightAlpha ?? Math.min(c.a === 1 ? MAX_HIGHLIGHT_ALPHA : c.a, MAX_HIGHLIGHT_ALPHA);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(a)})`;
}

function markInkColor(color: string): string {
  const c = parseColor(color);
  if (!c) return color;
  const k = 0.62;
  return `rgba(${Math.round(c.r * k)}, ${Math.round(c.g * k)}, ${Math.round(c.b * k)}, 0.95)`;
}

function stickerBackgroundColor(color: string, alpha: number): string {
  const pal = resolvePalette(color);
  const fill = pal?.cardFill ?? pal?.fill ?? color;
  const c = parseColor(fill);
  if (!c) return fill;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${clampCssAlpha(alpha)})`;
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

function annotationTypeOf(h: Highlight): "highlight" | "tag" {
  return h.type === "tag" ? "tag" : "highlight";
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

function shortAnnotationText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
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

function measureMarginCardHeight(card: HTMLElement): number {
  const win = card.ownerDocument.defaultView ?? window;
  const style = win.getComputedStyle(card);
  const current = card.getBoundingClientRect().height || card.offsetHeight || 0;
  const maxHeight = parseCssPixelValue(style.maxHeight);
  const borderY =
    parseCssPixelValue(style.borderTopWidth, 0) + parseCssPixelValue(style.borderBottomWidth, 0);
  const natural = card.scrollHeight + borderY;
  const target = Number.isFinite(maxHeight) ? Math.min(natural, maxHeight) : natural;
  return Math.max(24, current, target);
}

function applyMarginCardDensity(cards: HTMLElement[], railHeight: number, gap: number): void {
  for (const card of cards) card.style.removeProperty("--lpa-card-density-height");
  if (!cards.length || railHeight <= 0) return;

  const expanded = cards.filter(
    (card) =>
      card.classList.contains("is-active") ||
      card.classList.contains("is-hover") ||
      card.classList.contains("is-pinned") ||
      card.matches(":hover")
  );
  const resting = cards.filter((card) => !expanded.includes(card));
  if (!resting.length) return;

  const occupied = expanded.reduce((sum, card) => sum + measureMarginCardHeight(card), 0);
  const available = Math.max(
    24 * resting.length,
    railHeight - 16 - gap * Math.max(0, cards.length - 1) - occupied
  );
  const fitted = fitFoldedMarginCardHeights(
    resting.map((card) => Number.parseFloat(card.dataset.foldedHeight || "54")),
    available
  );
  resting.forEach((card, index) => {
    card.style.setProperty("--lpa-card-density-height", `${fitted[index]}px`);
  });
}

function parseCssPixelValue(value: string, fallback = Number.POSITIVE_INFINITY): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dedupeKey(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase().slice(0, 80);
}

function cssEscape(value: string): string {
  const escape = typeof CSS !== "undefined" ? (CSS as any).escape : null;
  if (typeof escape === "function") return escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}