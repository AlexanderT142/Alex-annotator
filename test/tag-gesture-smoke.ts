import assert from "node:assert/strict";
import { TagGestureController, tagGestureGeometry, type TagGeometry } from "../src/tag-gesture";
import { AnnotationSetWorkspace } from "../src/annotation-sets";
import type { Highlight } from "../src/annotations";
import { MemoryAdapter } from "./memory-adapter";

// Node requires the object form to remove capture listeners; browsers accept both.
class DomTarget extends EventTarget {
  removeEventListener(type: string, listener: any, options?: any) {
    super.removeEventListener(type, listener, { capture: options === true || options?.capture === true });
  }
}
class Surface extends DomTarget {
  props: Record<string, string> = {};
  classes = new Set<string>();
  classList = {
    add: (...names: string[]) => names.forEach(n => this.classes.add(n)),
    remove: (...names: string[]) => names.forEach(n => this.classes.delete(n)),
    toggle: (n: string, on: boolean) => on ? this.classes.add(n) : this.classes.delete(n),
  };
  children: Surface[] = [];
  isConnected = true;
  ownerDocument: any;
  capture = false;
  box = { left: 100, top: 200, width: 500, height: 800 };
  setCssProps(props: Record<string, string>) { Object.assign(this.props, props); }
  setAttribute() {}
  getBoundingClientRect() { return this.box; }
  createDiv() { const child = new Surface(); child.ownerDocument = this.ownerDocument; this.children.push(child); return child; }
  contains(el: Surface): boolean { return el === this || this.children.some(c => c.contains(el)); }
  setPointerCapture() { this.capture = true; }
  hasPointerCapture() { return this.capture; }
  releasePointerCapture() { this.capture = false; }
}
function event(target: EventTarget, type: string, props: object = {}) {
  const e = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, buttons: 1, pointerId: 1, isPrimary: true, clientX: 200, clientY: 400, ...props })) Object.defineProperty(e, key, { value });
  target.dispatchEvent(e);
  return e;
}
const tag: Highlight = { id: "tag", type: "tag", page: 0, color: "blue", text: "", note: "A completed note worth preserving.", tagX: 20, tagY: 25, rects: [], created: "2026-09-09", isPinned: true };
function fixture() {
  const doc = new DomTarget() as any;
  doc.defaultView = Object.assign(new DomTarget(), { setTimeout, clearTimeout });
  const layer = new Surface(); layer.ownerDocument = doc;
  const el = layer.createDiv(); el.box = { left: 150, top: 388, width: 100, height: 24 };
  const controller = new TagGestureController();
  const commits: TagGeometry[] = [];
  controller.bind(el as any, layer as any, { ...tag }, geometry => commits.push(geometry), () => {});
  return { doc, layer, el, controller, commits };
}
const near = (actual: number | undefined, expected: number) => assert.ok(Math.abs(actual! - expected) < 1e-8, `${actual} != ${expected}`);

// No modifier key needed; tiny pointer jitter remains an edit click.
{
  const f = fixture();
  event(f.el, "pointerdown"); event(f.doc, "pointerup", { clientX: 202 });
  assert.equal(f.commits.length, 0);
  assert.equal(event(f.doc, "click").defaultPrevented, false);
  f.controller.destroy();
}
{
  const f = fixture();
  event(f.el, "pointerdown", { clientX: 215 }); // Grab off-centre: no jump.
  event(f.doc, "pointermove", { clientX: 315, clientY: 480 });
  near(f.controller.previewFor("tag").tagX, 40);
  assert.equal(f.commits.length, 0, "preview must not save");
  event(f.doc, "pointerup", { clientX: 365, clientY: 560 });
  near(f.commits[0].tagX, 50); near(f.commits[0].tagY, 45);
  assert.equal(event(f.doc, "click").defaultPrevented, true, "release must not open editor");
  f.controller.destroy();
  assert.equal(event(f.doc, "click").defaultPrevented, false);
  event(f.doc, "pointerup"); assert.equal(f.commits.length, 1);
}
for (const cancellation of ["Escape", "pointercancel", "lostpointercapture", "blur", "repaint", "destroy"]) {
  const f = fixture();
  event(f.el, "pointerdown"); event(f.doc, "pointermove", { clientX: 400 });
  if (cancellation === "Escape") event(f.doc, "keydown", { key: "Escape" });
  else if (cancellation === "repaint") f.controller.cancelIn(f.layer as any);
  else if (cancellation === "destroy") f.controller.destroy();
  else event(cancellation === "blur" ? f.doc.defaultView : cancellation === "lostpointercapture" ? f.el : f.doc, cancellation);
  event(f.doc, "pointerup", { clientX: 450 });
  assert.equal(f.commits.length, 0, cancellation);
  assert.equal(f.el.props.left, "20%");
  assert.equal(f.el.props.width, "");
  f.controller.destroy();
}
{
  const f = fixture();
  event(f.el, "pointerdown", { button: 2 }); event(f.doc, "pointerup", { clientX: 400 });
  assert.equal(f.commits.length, 0);
  event(f.el, "pointerdown");
  event(f.doc, "pointerup", { pointerId: 2, clientX: 400 });
  assert.equal(f.commits.length, 0, "ignore other pointers");
  event(f.doc, "pointerup", { clientX: 300 });
  assert.equal(f.commits.length, 1);
  f.controller.destroy();
}
{
  const f = fixture();
  // Model a bubbling pointerdown from the resize handle.
  event(f.el, "pointerdown", { target: f.el.children[0], clientX: 248, clientY: 410 });
  event(f.doc, "pointerup", { clientX: 448, clientY: 450 });
  const g = f.commits[0];
  near(g.tagWidth, 60); near(g.tagHeight, 8);
  near(g.tagX! - g.tagWidth! / 2, 10); near(g.tagY! - g.tagHeight! / 2, 23.5);
  assert.notEqual(g.tagWidth! / g.tagHeight!, 20 / 3, "aspect ratio is not locked");
  f.controller.destroy();
}
{
  const f = fixture();
  event(f.el, "pointerdown", { target: f.el.children[0], clientX: 248, clientY: 410 });
  event(f.doc, "pointermove", { clientX: 448, clientY: 510 });
  event(f.doc, "keydown", { key: "Escape" });
  assert.equal(f.commits.length, 0, "cancelled resize does not save");
  assert.equal(f.el.props.width, ""); assert.equal(f.el.props.height, "");
  f.controller.destroy();
}
{
  const f = fixture();
  event(f.el, "pointerdown");
  f.layer.box = { left: 200, top: 100, width: 1000, height: 1600 };
  event(f.doc, "pointerup", { clientX: 600, clientY: 900 });
  near(f.commits[0].tagX, 40); near(f.commits[0].tagY, 50);
  f.controller.destroy();
}
const page = { left: 100, top: 200, width: 500, height: 800 };
const size = { left: 150, top: 388, width: 100, height: 24 };
const offset = { x: 0, y: 0 };
for (const [x, y, expectedX, expectedY] of [[-999, -999, 10, 1.5], [9999, 9999, 90, 98.5]]) {
  const g = tagGestureGeometry("move", page, tag, size, offset, { clientX: x, clientY: y });
  near(g.tagX, expectedX); near(g.tagY, expectedY);
}
for (const [x, y, width, height] of [[400, 412, 50, 3], [250, 700, 20, 39], [-999, -999, 8, 2.75], [9999, 9999, 90, 76.5]]) {
  const g = tagGestureGeometry("resize", page, tag, size, offset, { clientX: x, clientY: y });
  near(g.tagWidth, width); near(g.tagHeight, height);
  near(g.tagX! - g.tagWidth! / 2, 10); near(g.tagY! - g.tagHeight! / 2, 23.5);
}
async function persistence() {
  const adapter = new MemoryAdapter();
  const options = { adapter: adapter as any, setsRootPath: "sets", indexPath: "sets/index.json", legacyAnnotationPath: "legacy.md", pdfBasename: "Book", pdfVaultPath: "Book.pdf" };
  let workspace = await AnnotationSetWorkspace.open(options);
  workspace.add({ ...tag });
  const other = await workspace.createSet("Other notes");
  await workspace.setActive(other.id);
  workspace.update(tag.id, { tagX: 40, tagY: 30, tagWidth: 60, tagHeight: 8 });
  await workspace.release();
  workspace = await AnnotationSetWorkspace.open(options);
  const saved = workspace.get(tag.id)!;
  assert.equal(saved.setId, "default", "moving a tag must retain its original set");
  assert.equal(saved.note, tag.note); assert.equal(saved.isPinned, true);
  assert.equal(saved.created, tag.created); assert.deepEqual(saved.rects, []);
  near(saved.tagX, 40); near(saved.tagY, 30); near(saved.tagWidth, 60); near(saved.tagHeight, 8);
  await workspace.release();
}
void persistence().then(() => console.log("tag gesture smoke: move, free resize, cancellation, bounds, click separation, and persistence passed"));
