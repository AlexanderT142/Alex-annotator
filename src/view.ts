/**
 * view.ts — PDF Annotator custom view ("pdf-annotator").
 */
import {
  App,
  Menu,
  Notice,
  TFile,
  View,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
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

export const VIEW_TYPE_PDF_ANNOTATOR = "pdf-annotator";

const MAX_HIGHLIGHT_ALPHA = 0.46;

interface PageGeom {
  vp1: any;
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

interface MarginAnchor {
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
  anchor: MarginAnchor;
}

export class PdfAnnotatorView extends View {
  file: TFile | null = null;
  private store: AnnotationStore | null = null;
  private pdfDoc: any | null = null;
  private pdfWorker: any | null = null;
  private geoms = new Map<number, PageGeom>();
  private geomPromises = new Map<number, Promise<PageGeom | null>>();
  private observer: MutationObserver | null = null;
  private syncQueued = false;
  private cleanups: Array<() => void> = [];

  private currentColor = DEFAULT_COLOR;
  private currentStyle: MarkStyle = "highlight";
  private tagMode = false;

  private pendingSelection: { text: string; byPage: Map<number, PdfRect[]> } | null = null;
  private selectionPopoverEl: HTMLElement | null = null;
  private editPopoverCleanup: (() => void) | null = null;

  private tagBtn: HTMLButtonElement | null = null;
  private listBtn: HTMLButtonElement | null = null;
  private countEl: HTMLElement | null = null;
  private listPanelEl: HTMLElement | null = null;
  private listSearchQuery = "";

  private marginsEl: HTMLElement | null = null;
  private leftRailEl: HTMLElement | null = null;
  private rightRailEl: HTMLElement | null = null;
  private connectionSvg: SVGSVGElement | null = null;
  private railResizeObserver: ResizeObserver | null = null;
  private scroller: HTMLElement | null = null;
  private railScrollTarget: HTMLElement | null = null;
  private readonly railScrollHandler = () => this.onScroll();
  private railWidths = { left: 0, right: 0 };
  private railRaf: number | null = null;
  private pointerRaf: number | null = null;
  private lastPointer: { x: number; y: number; pageEl: HTMLElement | null } | null = null;
  private hoverId: string | null = null;
  private activeId: string | null = null;
  private hoverClearTimer: number | null = null;
  private scrollSettleTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private getAnnotationPathOptions: () => AnnotationPathOptions,
    private bundleManager?: PdfBundleManager,
    private getPaletteColors?: () => string[],
    private getWrapWithMark?: () => boolean
  ) {
    super(leaf);
    const activePalette = this.getActivePalette();
    if (activePalette.length > 0) {
      this.currentColor = activePalette[0].fill;
    }
  }

  getViewType(): string {
    return VIEW_TYPE_PDF_ANNOTATOR;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "PDF Annotator";
  }

  getIcon(): string {
    return "highlighter";
  }

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

  async setState(state: any, result: any): Promise<void> {
    await super.setState(state, result);
    if (state?.file) {
      const file = this.app.vault.getAbstractFileByPath(state.file);
      if (file instanceof TFile) {
        await this.loadFile(file);
      }
    }
  }

  syncPdfPath(file: TFile): void {
    if (this.file !== file && this.file?.path !== file.path) return;
    this.store?.setPdfPath(file.path, file.basename);
  }

  async loadFile(file: TFile): Promise<void> {
    this.file = file;
    this.containerEl.empty();
    initPdfEngine();

    const root = this.containerEl.createDiv({ cls: "lpa-custom-view-root" });

    const data = await this.app.vault.readBinary(file);
    this.pdfWorker = createDedicatedWorker();
    const params: any = { data: copyPdfDataForWorker(data), useSystemFonts: true };
    if (this.pdfWorker) params.worker = this.pdfWorker;
    this.pdfDoc = await pdfjsLib.getDocument(params).promise;

    const fingerprint = Array.isArray(this.pdfDoc.fingerprints)
      ? this.pdfDoc.fingerprints[0]
      : this.pdfDoc.fingerprint;
    const pathOptions = this.getAnnotationPathOptions();
    let annotationPath = sidecarPathFor(file.path, pathOptions);
    let fallbackPaths = [legacySidecarPathFor(file.path)];
    let migrateFallback = false;
    let annotationBackupPath: string | undefined;
    if (this.bundleManager) {
      const binding = await this.bundleManager.prepare(file, data, fingerprint, pathOptions);
      annotationPath = binding.annotationPath;
      fallbackPaths = binding.fallbackAnnotationPaths;
      migrateFallback = true;
      annotationBackupPath = binding.annotationBackupPath;
    }
    const wrapWithMark = this.getWrapWithMark ? this.getWrapWithMark() : true;
    this.store = new AnnotationStore(
      this.app.vault.adapter,
      annotationPath,
      file.basename,
      file.path,
      fingerprint,
      fallbackPaths,
      migrateFallback,
      annotationBackupPath,
      wrapWithMark
    );
    await this.store.load();
    this.notifyStoreChanged();

    const doc = root.ownerDocument;
    this.listen(root, "mouseup", (evt) => this.onMouseUp(evt as MouseEvent));
    this.listen(root, "click", (evt) => this.onClick(evt as MouseEvent));
    this.listen(
      root,
      "mousemove",
      (evt) => this.onPointerMove(evt as MouseEvent),
      { passive: true }
    );
    this.listen(doc, "selectionchange", () => this.onSelectionChange());
    this.listen(doc, "keydown", (evt) => this.onKeyDown(evt as KeyboardEvent));

    this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-loaded"],
    });

    this.initMarginRail(root);
    this.scheduleSync();
  }

  async onClose(): Promise<void> {
    this.closeEditPopover();
    this.selectionPopoverEl?.remove();
    this.selectionPopoverEl = null;
    this.pendingSelection = null;
    this.closeListPanel();

    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {}
    }

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    if (this.railRaf !== null) win.cancelAnimationFrame(this.railRaf);
    if (this.pointerRaf !== null) win.cancelAnimationFrame(this.pointerRaf);
    if (this.hoverClearTimer !== null) win.clearTimeout(this.hoverClearTimer);
    if (this.scrollSettleTimer !== null) win.clearTimeout(this.scrollSettleTimer);

    this.marginsEl?.remove();
    this.marginsEl = null;

    const store = this.store;
    this.store = null;
    if (store) {
      await store.flush().catch((e) => console.error(`${LOG_TAG} failed to save annotations`, e));
    }
    this.releasePdf();
    this.geoms.clear();
    this.geomPromises.clear();
  }

  private releasePdf(): void {
    try {
      this.pdfDoc?.destroy();
    } catch {}
    try {
      this.pdfWorker?.destroy();
    } catch {}
    this.pdfDoc = null;
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

  private notifyStoreChanged(): void {
    this.updateCount();
    if (this.listPanelEl) this.renderListItems();
    this.scheduleRailLayout();
  }

  private updateCount(): void {
    const n = this.store?.doc.highlights.length ?? 0;
    if (this.countEl) {
      this.countEl.setText(String(n));
      this.countEl.setAttribute("title", `${n} ${n === 1 ? "annotation" : "annotations"}`);
    }
  }

  private onMutations(mutations: MutationRecord[]): void {
    for (const m of mutations) {
      const target = m.target instanceof HTMLElement ? m.target : m.target.parentElement;
      if (target?.closest(".lpa-native-margins, .lpa-native-roll, .lpa-native-controls")) continue;
      this.scheduleSync();
      return;
    }
  }

  private scheduleSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => {
      this.syncQueued = false;
      this.syncPages();
    });
  }

  private syncPages(): void {
    if (!this.store) return;
    const store = this.store;
    const pageEls = this.containerEl.querySelectorAll<HTMLElement>(".page[data-page-number]");
    for (const pageEl of Array.from(pageEls)) {
      const num = Number(pageEl.getAttribute("data-page-number"));
      if (!Number.isFinite(num) || num < 1) continue;
      const idx = num - 1;
      const active =
        pageEl.hasAttribute("data-loaded") ||
        !!pageEl.querySelector(":scope > .textLayer, :scope > .canvasWrapper, :scope > .lpa-custom-hl-layer");
      if (!active && store.byPage(idx).length === 0) continue;
      void this.syncPage(idx, pageEl);
    }
    this.scheduleRailLayout();
  }

  private async syncPage(idx: number, pageEl: HTMLElement): Promise<void> {
    const geom = await this.ensureGeom(idx);
    if (!geom || !pageEl.isConnected) return;

    const textLayer = pageEl.querySelector<HTMLElement>(":scope > .textLayer");
    let layer = pageEl.querySelector<HTMLElement>(":scope > .lpa-custom-hl-layer");
    if (!layer) {
      layer = pageEl.ownerDocument.createElement("div");
      layer.className = "lpa-highlight-layer lpa-custom-hl-layer";
      if (textLayer) pageEl.insertBefore(layer, textLayer);
      else pageEl.appendChild(layer);
    }
    let noteLayer = pageEl.querySelector<HTMLElement>(":scope > .lpa-custom-note-layer");
    if (!noteLayer) {
      noteLayer = pageEl.ownerDocument.createElement("div");
      noteLayer.className = "lpa-note-layer lpa-custom-note-layer";
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
          this.geoms.set(idx, geom);
          return geom;
        } catch (e) {
          console.error(`${LOG_TAG} view: failed to load geometry for page ${idx + 1}`, e);
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
    const pageEl = this.containerEl.querySelector<HTMLElement>(`.page[data-page-number="${idx + 1}"]`);
    if (pageEl) void this.syncPage(idx, pageEl);
  }

  private collectPageBoxes(): PageBox[] {
    const out: PageBox[] = [];
    for (const pageEl of Array.from(this.containerEl.querySelectorAll<HTMLElement>(".page[data-page-number]"))) {
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
    if (!geom) return null;
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

  private onMouseUp(evt: MouseEvent): void {
    if (!this.store || this.tagMode) return;
    const target = evt.target as HTMLElement | null;
    if (target?.closest(".lpa-selection-popover, .lpa-mark-popover, .lpa-native-controls, .lpa-native-roll, .lpa-native-margins")) return;
    const sel = this.containerEl.ownerDocument.getSelection();
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
    for (const [idx, entry] of rawByPage) {
      const geom = await this.ensureGeom(idx);
      if (!geom) continue;
      const rects: PdfRect[] = [];
      for (const cr of entry.rects) {
        const p1 = clientToPdfPoint(cr.left, cr.top, entry.box, geom);
        const p2 = clientToPdfPoint(cr.right, cr.bottom, entry.box, geom);
        rects.push({ x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] });
      }
      if (rects.length) byPage.set(idx, rects);
    }
    if (byPage.size === 0) return;

    this.pendingSelection = { text, byPage };
    this.showSelectionPopover(anchorX, anchorY);
  }

  private showSelectionPopover(x: number, y: number): void {
    this.selectionPopoverEl?.remove();
    const doc = this.containerEl.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-selection-popover is-right" });
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
      this.containerEl.ownerDocument.getSelection()?.removeAllRanges();
    }
  }

  private onSelectionChange(): void {
    if (!this.selectionPopoverEl) return;
    const sel = this.containerEl.ownerDocument.getSelection();
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
    }
  }

  private onClick(evt: MouseEvent): void {
    if (!this.store) return;
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
    const sel = this.containerEl.ownerDocument.getSelection();
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
    const doc = this.containerEl.ownerDocument;
    const pop = doc.body.createDiv({ cls: "lpa-mark-popover" });
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
      pop.createDiv({ cls: "lpa-native-popover-source", text: initial.text });
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

  private setTagMode(on: boolean): void {
    this.tagMode = on;
    this.containerEl.toggleClass("lpa-native-tag-mode", on);
    if (this.tagBtn) {
      this.tagBtn.toggleClass("is-active", on);
      this.tagBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  private initMarginRail(root: HTMLElement): void {
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

    this.scroller = root;
    this.railScrollTarget = root;
    root.addEventListener("scroll", this.railScrollHandler, { passive: true });
    this.railResizeObserver = new ResizeObserver(() => this.scheduleRailLayout());
    this.railResizeObserver.observe(root);
    this.cleanups.push(() => {
      this.railScrollTarget?.removeEventListener("scroll", this.railScrollHandler);
      this.railResizeObserver?.disconnect();
    });
  }

  private onScroll(): void {
    if (!this.marginsEl) return;
    this.marginsEl.addClass("is-scrolling");
    this.scheduleRailLayout();
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    if (this.scrollSettleTimer !== null) win.clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = win.setTimeout(() => {
      this.scrollSettleTimer = null;
      this.marginsEl?.removeClass("is-scrolling");
      this.scheduleRailLayout();
    }, 120);
  }

  private scheduleRailLayout(): void {
    if (this.railRaf !== null || !this.marginsEl) return;
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    this.railRaf = win.requestAnimationFrame(() => {
      this.railRaf = null;
      this.layoutRail();
    });
  }

  private layoutRail(): void {
    const root = this.containerEl;
    const margins = this.marginsEl;
    const store = this.store;
    if (!root || !margins || !this.leftRailEl || !this.rightRailEl || !store) return;

    const rootRect = root.getBoundingClientRect();
    margins.setCssProps({
      left: "0px",
      top: "0px",
      width: `${Math.round(rootRect.width)}px`,
      height: `${Math.round(rootRect.height)}px`,
    });

    const pages = new Map<number, { box: DOMRect; geom: PageGeom }>();
    let pageLeft = Infinity;
    let pageRight = -Infinity;
    for (const b of this.collectPageBoxes()) {
      if (b.box.bottom <= rootRect.top || b.box.top >= rootRect.bottom) continue;
      const geom = this.geoms.get(b.idx);
      if (!geom) continue;
      pages.set(b.idx, { box: b.box, geom });
      pageLeft = Math.min(pageLeft, b.box.left);
      pageRight = Math.max(pageRight, b.box.right);
    }
    if (pages.size === 0) {
      this.clearRail();
      return;
    }

    const naturalLeftWidth = Math.max(0, pageLeft - rootRect.left);
    const naturalRightWidth = Math.max(0, rootRect.right - 14 - pageRight);
    this.railWidths = { left: naturalLeftWidth, right: naturalRightWidth };
    this.applyRailWidth(this.leftRailEl, naturalLeftWidth);
    this.applyRailWidth(this.rightRailEl, naturalRightWidth);

    const desired: RailEntry[] = [];
    for (const [idx, page] of pages) {
      for (const h of store.byPage(idx)) {
        if (!this.wantsMarginCard(h)) continue;
        const anchor = this.computeAnchor(h, page.box, page.geom, rootRect);
        if (!anchor) continue;
        desired.push({ h, anchor });
      }
    }

    this.reconcileRailCards(desired);
    this.stackRailCards(desired);
    this.drawRailConnections(desired, rootRect);
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

  private computeAnchor(
    h: Highlight,
    box: DOMRect,
    geom: PageGeom,
    areaRect: DOMRect
  ): MarginAnchor | null {
    const pageLeftX = box.left - areaRect.left;
    const pageRightX = box.right - areaRect.left;
    const pageTopY = box.top - areaRect.top;
    const pageBottomY = box.bottom - areaRect.top;

    if (annotationTypeOf(h) === "tag") {
      if (typeof h.tagX !== "number" || typeof h.tagY !== "number") return null;
      const sourceX = pageLeftX + (clamp(0, h.tagX, 100) / 100) * box.width;
      const sourceY = box.top - areaRect.top + (clamp(0, h.tagY, 100) / 100) * box.height;
      return {
        side: h.tagX < 50 ? "left" : "right",
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
    const base = rectsToBase(geom, h.rects);
    if (base.length === 0) return null;
    const lines = mergeLineRects(base);
    const first = lines[0] ?? base[0];
    const left = Math.min(...base.map((r) => r.left));
    const right = Math.max(...base.map((r) => r.right));
    const sx = box.width / geom.w;
    const sy = box.height / geom.h;
    const side = (left + right) / 2 < geom.w / 2 ? "left" : "right";
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
    const card = rail.createDiv({ cls: `lpa-margin-card lpa-margin-card--${type}` });
    card.dataset.hlId = h.id;
    card.dataset.annotationId = h.id;

    card.addEventListener("mouseenter", () => this.setHoveredAnnotation(h.id));
    card.addEventListener("mouseleave", () => this.clearHoveredAnnotationSoon(h.id));
    card.addEventListener("click", (evt) => {
      const target = evt.target as HTMLElement | null;
      if (target?.closest("textarea,button")) return;
      this.setActiveAnnotation(h.id);
    });

    const head = card.createDiv({ cls: "lpa-margin-card-head" });
    head.createSpan({ cls: "lpa-margin-dot", attr: { "aria-hidden": "true" } });
    head.createSpan({ cls: "lpa-margin-page", text: `p.${h.page + 1}` });

    const note = card.createEl("textarea", {
      cls: "lpa-margin-note",
      attr: { placeholder: type === "tag" ? "Page note" : "Note", rows: "2" },
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

    this.syncCardContent(card, h);
    return card;
  }

  private syncCardContent(card: HTMLElement, h: Highlight): void {
    const pal = resolvePalette(annotationColor(h));
    card.style.setProperty("--lpa-accent", pal?.ink ?? markInkColor(annotationColor(h)));
    card.toggleClass("is-pinned", !!h.isPinned);
    card.toggleClass("is-active", h.id === this.activeId);
    card.toggleClass("is-hover", h.id === this.hoverId);
    card.toggleClass(
      "is-expanded",
      !!h.isPinned || h.id === this.activeId || h.id === this.hoverId
    );
    syncMarginCardPresentation(card);
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

  private onPointerMove(evt: MouseEvent): void {
    if (this.tagMode || !this.store) return;
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
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    this.pointerRaf = win.requestAnimationFrame(() => {
      this.pointerRaf = null;
      if (!this.lastPointer) return;
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
    if (!geom || !box) return null;
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
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    if (this.hoverClearTimer !== null) {
      win.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
    const next = id && this.store?.get(id) ? id : null;
    if (this.hoverId === next) return;
    this.hoverId = next;
    this.syncBindingState();
  }

  private clearHoveredAnnotationSoon(id?: string): void {
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    if (this.hoverClearTimer !== null) win.clearTimeout(this.hoverClearTimer);
    this.hoverClearTimer = win.setTimeout(() => {
      this.hoverClearTimer = null;
      if (!id || this.hoverId === id) this.setHoveredAnnotation(null);
    }, 120);
  }

  private setActiveAnnotation(id: string | null): void {
    const next = id && this.store?.get(id) ? id : null;
    if (this.activeId === next) return;
    this.activeId = next;
    this.syncBindingState();
  }

  private syncBindingState(): void {
    const root = this.containerEl;
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
    for (const mark of Array.from(root.querySelectorAll<HTMLElement>(".lpa-custom-hl-layer .lpa-highlight"))) {
      const ids = (mark.dataset.hlIds ?? "").split(/\s+/).filter(Boolean);
      mark.toggleClass("is-active", !!this.activeId && ids.includes(this.activeId));
      mark.toggleClass("is-hover", !!this.hoverId && ids.includes(this.hoverId));
    }
    for (const tag of Array.from(root.querySelectorAll<HTMLElement>(".lpa-custom-note-layer .lpa-page-tag"))) {
      const id = tag.dataset.hlId ?? "";
      tag.toggleClass("is-active", !!id && id === this.activeId);
      tag.toggleClass("is-hover", !!id && id === this.hoverId);
    }
    this.scheduleRailLayout();
  }

  private toggleListPanel(): void {
    if (this.listPanelEl) {
      this.closeListPanel();
      return;
    }
    const root = this.containerEl;
    if (!this.store) return;
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
  }

  private closeListPanel(): void {
    this.listPanelEl?.remove();
    this.listPanelEl = null;
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
    if (!h) return;
    this.setActiveAnnotation(id);
    const pageEl = this.containerEl.querySelector<HTMLElement>(`.page[data-page-number="${h.page + 1}"]`);
    if (pageEl) {
      pageEl.scrollIntoView({ block: "center" });
    }
  }

  async importLegacyAnnotations(): Promise<void> {
    const store = this.store;
    if (!this.pdfDoc || !store) return;
    const pdfName = this.file?.name.normalize("NFC").toLowerCase();
    if (!pdfName) return;
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

    const seen = new Set(store.doc.highlights.map((h) => `${h.page}|${dedupeKey(h.text)}`));
    const created: Highlight[] = [];
    const affected = new Set<number>();
    let matched = 0;

    for (const a of legacy) {
      const results = anchorQuote(docIndex, a.exact, a.prefix, a.suffix);
      if (results.length === 0) continue;
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
    new Notice(`Imported ${created.length} highlight(s) from ${notes.length} note(s).`);
  }
}

// ---- Helpers ----

function pageContentBox(pageEl: HTMLElement): DOMRect | null {
  const ref =
    pageEl.querySelector<HTMLElement>(":scope > .textLayer") ??
    pageEl.querySelector<HTMLElement>(":scope > .canvasWrapper") ??
    pageEl.querySelector<HTMLElement>(":scope > .lpa-custom-hl-layer") ??
    pageEl;
  const box = ref.getBoundingClientRect();
  return box.width >= 2 && box.height >= 2 ? box : null;
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
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const raw = hex[1];
    let value = raw;
    let alpha = 1;
    if (raw.length === 3) {
      value = raw.split("").map((ch) => ch + ch).join("");
    } else if (raw.length === 8) {
      value = raw.slice(0, 6);
      alpha = parseInt(raw.slice(6, 8), 16) / 255;
    }
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
      a: alpha,
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

function rollPrimaryText(h: Highlight): string {
  const text = (h.note || h.noteContentCJK || h.text || tagPreview(h)).replace(/\s+/g, " ").trim();
  return text || "Untitled note";
}

function rollSecondaryText(h: Highlight): string {
  const chunks: string[] = [];
  if (h.note && h.noteContentCJK) chunks.push(h.noteContentCJK);
  if (annotationTypeOf(h) === "highlight" && h.text) chunks.push(h.text);
  return chunks.join("  ");
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