import assert from "node:assert/strict";
import { PdfAnnotatorView } from "../src/view";
import { pdfjsLib } from "./pdf-engine-stub";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  props: Record<string, string> = {};
  offsetTop = 0;
  offsetHeight = 800;
  scrollTop = 0;
  removed = false;
  style = { setProperty: (key: string, value: string) => { this.props[key] = value; } };
  setCssProps(props: Record<string, string>) { Object.assign(this.props, props); }
  insertBefore(child: Element) { child.parent = this; this.children.push(child); }
  createDiv() { const child = new Element(); this.insertBefore(child); return child; }
  getContext() { return {}; }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  empty() { this.children = []; }
}
(globalThis as any).window = { devicePixelRatio: 1 };
(globalThis as any).document = { createElement: () => new Element() };

type Stage = "page" | "canvas" | "text-content" | "text-layer";
async function rapidZoom(stage: Stage, lifecycle: "visible" | "hidden" | "replaced" | "closed" = "visible") {
  const pending = deferred<any>();
  let block = true;
  let reached = false;
  let canvasCancels = 0;
  let textCancels = 0;
  const rasterScales: number[] = [];
  const textScales: number[] = [];
  const awaitStage = (candidate: Stage, value: any) => {
    if (candidate === stage && block) { reached = true; return pending.promise; }
    return Promise.resolve(value);
  };
  const page = {
    getViewport: ({ scale }: any) => ({ width: 600 * scale, height: 800 * scale, scale }),
    render: ({ viewport }: any) => {
      rasterScales.push(viewport.scale);
      return { promise: awaitStage("canvas", undefined), cancel() {
        canvasCancels++;
        if (stage === "canvas" && block) pending.reject({ name: "RenderingCancelledException" });
      } };
    },
    getTextContent: () => awaitStage("text-content", {}),
  };
  (pdfjsLib as any).renderTextLayer = ({ container, viewport }: any) => {
    textScales.push(viewport.scale);
    return { promise: awaitStage("text-layer", undefined).then(() => { container.createDiv(); }), cancel() {
      textCancels++;
      if (stage === "text-layer" && block) pending.reject({ name: "RenderingCancelledException" });
    } };
  };
  const el = new Element();
  const pv: any = { index: 0, el, hlLayer: new Element(), noteLayer: new Element(),
    page: stage === "page" ? null : page, rendered: true, rendering: false,
    canvas: null, textLayerEl: null, renderTask: null, textTask: null };
  const view: any = Object.create(PdfAnnotatorView.prototype);
  view.pdfDoc = { getPage: () => awaitStage("page", page) };
  view.pageViews = [pv];
  view.pageSizes = [];
  view.defaultSize = { w: 600, h: 800 };
  view.visible = new Set([0]);
  view.scale = 1.25;
  view.renderEpoch = 0;
  view.pagesEl = new Element();
  view.tagGesture = { cancelIn() {} };
  view.closeMarkPopover = view.hideSelectionActions = view.scheduleMarginLayout = view.updateZoomLabel =
    view.renderHighlights = view.renderTags = view.renderAnnotationSidebar = () => {};

  view.setScale(view.scale / 1.2);
  await settle();
  assert.ok(reached, `fixture should await ${stage}`);
  const staleNodes = [...el.children];
  view.setScale(view.scale / 1.2);
  view.setScale(view.scale / 1.2);
  if (lifecycle === "hidden") { view.visible.clear(); view.teardownPageContent(pv); }
  if (lifecycle === "replaced" || lifecycle === "closed") {
    // Model teardownDocument's epoch, DOM cleanup and identity reset while a task is pending.
    view.renderEpoch++;
    view.teardownPageContent(pv);
    view.pageViews = lifecycle === "replaced" ? [{ ...pv, rendering: false }] : [];
    view.pdfDoc = lifecycle === "replaced" ? { getPage() { throw new Error("old render accessed replacement PDF"); } } : null;
  }
  block = false;
  pending.resolve(stage === "page" ? page : stage === "text-content" ? {} : undefined);
  await settle();
  assert.equal(pv.rendering, false);
  if (lifecycle === "visible") {
    assert.equal(pv.rendered, true, `${stage}: the current visible page must finish rendering after rapid zoom`);
    assert.equal(rasterScales.at(-1), view.scale);
    assert.equal(textScales.at(-1), view.scale);
    assert.equal(pv.textLayerEl.children.length, 1, "final text layer is populated");
    assert.equal(pv.canvas.props.width, `${Math.floor(600 * view.scale)}px`);
    assert.equal(el.children.length, 2, "only the final canvas and text layer remain");
  } else {
    assert.equal(pv.rendered, false, `${lifecycle}: must not restart obsolete render`);
    assert.equal(pv.canvas, null);
    assert.equal(pv.textLayerEl, null);
    assert.equal(pv.renderTask, null);
    assert.equal(pv.textTask, null);
    assert.equal(el.children.length, 0);
    assert.equal(rasterScales.length, stage === "page" ? 0 : 1, "stale task must not render a replacement document");
  }
  for (const node of staleNodes) assert.ok(node.removed, "old render DOM is cleaned up");
  if (stage !== "page") assert.ok(canvasCancels > 0);
  if (stage === "text-layer") assert.ok(textCancels > 0);
}

async function main() {
  for (const stage of ["page", "canvas", "text-content", "text-layer"] as const) {
    for (const lifecycle of ["visible", "hidden", "replaced", "closed"] as const) await rapidZoom(stage, lifecycle);
  }
  console.log("zoom render smoke: rapid zoom recovers at every async stage; hidden/replaced/closed pages stay cancelled and release DOM/tasks");
}
void main();
