import assert from "node:assert/strict";
import { PdfAnnotatorView } from "../src/view";
import { NativePdfOverlay } from "../src/native-overlay";
import { TagGestureController } from "../src/tag-gesture";
import { tagAnchorXPercent, tagStylePatch } from "../src/tag-region";
import type { Highlight } from "../src/annotations";

class Element extends EventTarget {
  children: Element[] = [];
  classes = new Set<string>();
  props: Record<string, string> = {};
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  scrolls = 0;
  ownerDocument: any = {};
  style = { setProperty: (key: string, value: string) => { this.props[key] = value; } };
  classList = {
    toggle: (key: string, value: boolean) => value ? this.classes.add(key) : this.classes.delete(key),
    add: (...keys: string[]) => keys.forEach(key => this.classes.add(key)),
    remove: (...keys: string[]) => keys.forEach(key => this.classes.delete(key)),
  };
  createDiv(options: any = {}): Element {
    const el = new Element();
    for (const cls of (options.cls ?? "").split(" ")) el.classes.add(cls);
    el.ownerDocument = this.ownerDocument;
    this.children.push(el); return el;
  }
  createSpan(options: any): Element { return this.createDiv(options); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  setCssProps(props: Record<string, string>) { Object.assign(this.props, props); }
  toggleClass(key: string, value: boolean) { this.classList.toggle(key, value); }
  addClass(key: string) { this.classes.add(key); }
  removeClass(key: string) { this.classes.delete(key); }
  empty() { this.children = []; }
  contains(el: Element): boolean { return this === el || this.children.some(child => child.contains(el)); }
  getBoundingClientRect() { return box; }
  scrollIntoView() { this.scrolls++; }
  querySelector(selector: string): Element | null {
    const id = /data-hl-id="([^"]+)"/.exec(selector)?.[1];
    return this.children.find(el => el.dataset.hlId === id) ?? null;
  }
}
const box = { left: 100, top: 200, width: 500, height: 800, right: 600, bottom: 1000 };
const legacy: Highlight = { id: "legacy", type: "tag", page: 0, color: "#c69c20", tagX: 2, tagY: 99,
  text: "", note: "Diagram description", rects: [], created: "2026-09-09", isPinned: true };
const region: Highlight = { ...legacy, ...tagStylePatch(legacy, "region"), id: "region" };
assert.equal(legacy.tagStyle, undefined, "conversion must not mutate the old annotation");
assert.deepEqual([region.tagX, region.tagY, region.tagWidth, region.tagHeight], [12, 93, 24, 14]);
assert.equal(region.note, legacy.note);
assert.equal(region.isPinned, true);
assert.deepEqual(tagStylePatch(region, "label"), { tagStyle: "label" }, "returning to label keeps stored geometry");
assert.equal(tagAnchorXPercent(region, "left"), 0);
assert.equal(tagAnchorXPercent(region, "right"), 24);
assert.equal(tagAnchorXPercent(legacy, "left"), 2, "legacy connectors stay centered");
const malformed = tagStylePatch({ ...legacy, tagWidth: NaN, tagHeight: -5, tagX: Infinity }, "region");
assert.deepEqual([malformed.tagWidth, malformed.tagHeight, malformed.tagX], [24, 14, 50]);

async function main() {
  (globalThis as any).window = { setTimeout: (fn: () => void, ms: number) => ms === 150 ? setTimeout(fn, 0) : 0 };
  for (const native of [false, true]) {
    const view: any = Object.create(native ? NativePdfOverlay.prototype : PdfAnnotatorView.prototype);
    const layer = new Element();
    const page = new Element();
    page.querySelector = selector => layer.querySelector(selector);
    const pv = { index: 0, page: {}, el: page, noteLayer: layer, rendered: true };
    let saved: Highlight[] = [region];
    view.store = { add: (h: Highlight) => saved.push(h), get: (id: string) => saved.find(h => h.id === id), byPage: () => saved };
    view.currentColorSlot = 0;
    view.placementTagStyle = "region";
    view.tagGesture = new TagGestureController();
    view.pageViews = [pv];
    view.pageBoxAtPoint = () => ({ idx: 0, box });
    view.pageViewAtPoint = () => pv;
    view.repaintPage = view.notifyStoreChanged = view.renderAnnotationSidebar = view.scheduleMarginLayout = view.scheduleRailLayout = () => {};
    view.bindMarkHover = view.setHoveredHighlight = view.clearHoveredHighlightSoon = () => {};
    const create = () => native ? view.createTagAt(101, 999) : view.createTagAtPoint(101, 999);
    const created = create();
    assert.equal(created.tagStyle, "region");
    assert.equal(created.type, "tag");
    assert.deepEqual([created.tagX, created.tagY, created.tagWidth, created.tagHeight], [12, 93, 24, 14]);
    view.placementTagStyle = "label";
    const oldStyle = create();
    assert.equal(oldStyle.tagStyle, undefined, "Tag toolbar keeps the old format");
    assert.equal(oldStyle.tagWidth, undefined);
    saved = [region];
    layer.empty();
    if (native) view.paintTag(layer, region); else view.renderTags(pv);
    const outline = layer.children[0];
    assert.ok(outline.classes.has("is-region"));
    assert.equal(outline.dataset.hlId, region.id);
    assert.equal(outline.props.width, "24%");
    assert.equal(outline.props.height, "14%");
    assert.equal(outline.children.filter(el => el.classes.has("lpa-region-edge")).length, 4);
    assert.ok(outline.attrs["aria-label"].includes(region.note!));
    let edited = "";
    view.openEditPopover = view.activateHighlight = (id: string) => { edited = id; };
    outline.dispatchEvent(new Event("click", { cancelable: true }));
    assert.equal(edited, region.id, "outline click opens its associated annotation");

    // Both renderers attach card connections to the near edge, including during a gesture preview.
    view.chooseRailSide = view.chooseMarginSide = (explicit: string, fallback: string) => explicit ?? fallback;
    view.pagesEl = view.bodyEl = page;
    const anchor = native ? view.computeNativeAnchor(region, box, {}, box) : view.computeAnnotationAnchor(region);
    assert.equal(anchor.sourceX, 0);
    const right = { ...region, marginSide: "right" };
    const rightAnchor = native ? view.computeNativeAnchor(right, box, {}, box) : view.computeAnnotationAnchor(right);
    assert.equal(rightAnchor.sourceX, 120);

    // Exercise actual list/backlink navigation for a region with no text rects.
    view.renderPageContent = async () => {};
    view.contentRoot = { querySelector: () => page };
    view.setActiveAnnotation = (id: string) => { view.activeId = id; };
    let navigatedPage = -1;
    view.navigateNativeToPage = async (index: number) => { navigatedPage = index; return page; };
    view.ensureReadableRailForAnnotation = async () => {};
    if (native) {
      await view.revealAnnotation(region.id);
      assert.equal(navigatedPage, 0);
      assert.equal(view.activeId, region.id);
      assert.equal(outline.scrolls, 1);
    } else {
      await view.revealHighlight(region.id);
      assert.equal(edited, region.id);
    }
    assert.ok(outline.classes.has("lpa-flash"));
    assert.ok(page.scrolls > 0);

    // Escape cancels placement without creating an annotation in either view.
    const count = saved.length;
    if (native) {
      view.tagMode = true;
      view.setTagMode = (on: boolean) => { view.tagMode = on; };
      view.onKeyDown({ key: "Escape" });
      assert.equal(view.tagMode, false);
    } else {
      view.tagPlacementMode = true;
      view.setTagPlacementMode = (on: boolean) => { view.tagPlacementMode = on; };
      view.onDocumentKeyDown({ key: "Escape" });
      assert.equal(view.tagPlacementMode, false);
    }
    assert.equal(saved.length, count);
    view.tagGesture.destroy();
  }
  console.log("region smoke: legacy compatibility, bounded creation, rendering, note links, edge connectors, navigation and placement cancellation passed");
}
void main();
