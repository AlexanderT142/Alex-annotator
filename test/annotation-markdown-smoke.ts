import assert from "node:assert/strict";
import { PdfAnnotatorView } from "../src/view";
import { NativePdfOverlay } from "../src/native-overlay";
import { AnnotationMarkdownCards } from "../src/annotation-markdown";
import { syncMarginCardPresentation } from "../src/margin-card";
import { Component, MarkdownRenderer } from "./obsidian-stub";

// Minimal DOM harness: tests presentation state/lifecycle, not Obsidian's parser.
class Element extends EventTarget {
  children: Element[] = [];
  parent: Element | null = null;
  className = "";
  hidden = false;
  value = "";
  textContent = "";
  tabIndex = -1;
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  styles = new Map<string, string>();
  style = { setProperty: (key: string, value: string) => this.styles.set(key, value) };
  classList = {
    contains: (name: string) => this.className.split(" ").includes(name),
    toggle: (name: string, on: boolean) => {
      this.className = this.className.split(" ").filter((value) => value !== name).concat(on ? [name] : []).join(" ");
    },
  };
  constructor(readonly ownerDocument: any, readonly tag = "div") { super(); }
  get scrollHeight(): number { assert.ok(!this.hidden, "hidden textareas must not be measured"); return 48; }
  setCssProps(props: Record<string, string>): void { for (const [k, v] of Object.entries(props)) this.styles.set(k, v); }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  append(el: Element): void { el.parent = this; this.children.push(el); }
  createEl(tag: string, options: any = {}): Element {
    const el = new Element(this.ownerDocument, tag);
    el.className = options.cls ?? ""; el.textContent = options.text ?? "";
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
    this.append(el); return el;
  }
  createDiv(options: any): Element { return this.createEl("div", options); }
  createSpan(options: any): Element { return this.createEl("span", options); }
  toggleClass(name: string, on: boolean): void { this.classList.toggle(name, on); }
  setText(text: string): void { this.textContent = text; }
  dispatchEvent(event: Event): boolean {
    const result = super.dispatchEvent(event);
    (this as any)[`on${event.type}`]?.(event);
    return result;
  }
  after(el: Element): void {
    el.parent = this.parent;
    this.parent!.children.splice(this.parent!.children.indexOf(this) + 1, 0, el);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((el) => el !== this);
    this.parent = null;
  }
  empty(): void { for (const el of this.children) el.parent = null; this.children = []; this.textContent = ""; }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const s = part.trim();
      if (s === "[contenteditable]:not([contenteditable='false'])") {
        return this.attrs.has("contenteditable") && this.getAttribute("contenteditable") !== "false";
      }
      if (s.startsWith("[contenteditable=")) return this.getAttribute("contenteditable") === "true";
      return s.startsWith(".") ? this.classList.contains(s.slice(1)) : this.tag === s;
    });
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((el) => [...(el.matches(selector) ? [el] : []), ...el.querySelectorAll(selector)]);
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  contains(el: Element): boolean { return el === this || this.children.some((child) => child.contains(el)); }
  focus(): void {
    const previous = this.ownerDocument.activeElement;
    this.ownerDocument.activeElement = this;
    if (previous && previous !== this) previous.dispatchEvent(new Event("blur"));
    this.dispatchEvent(new Event("focus"));
  }
  blur(): void { this.ownerDocument.activeElement = null; this.dispatchEvent(new Event("blur")); }
}

async function main(): Promise<void> {
  let disconnected = 0;
  let resized: (() => void) | undefined;
  const doc: any = { activeElement: null, createElement: (tag: string) => new Element(doc, tag),
    defaultView: { ResizeObserver: class {
      constructor(callback: () => void) { resized = callback; }
      observe(): void {}
      disconnect(): void { disconnected++; }
    } },
  };
  const card = new Element(doc); card.className = "lpa-margin-card";
  const note = new Element(doc, "textarea"); note.className = "lpa-margin-note";
  const side = new Element(doc, "textarea"); side.className = "lpa-margin-side-note";
  card.append(note); card.append(side);
  const owner = new Component(); owner.load();
  const cards = new AnnotationMarkdownCards();
  let layouts = 0;
  let saved = "";
  note.addEventListener("input", () => { saved = note.value; });
  const calls: Array<{ markdown: string; target: Element; path: string; owner: Component; resolve: () => void; reject: (error: Error) => void }> = [];
  MarkdownRenderer.render = async (_app, markdown, target, path, component) => {
    await new Promise<void>((resolve, reject) => calls.push({ markdown, target, path, owner: component, resolve, reject }));
    target.textContent = markdown;
  };
  const opened: string[][] = [];
  const app = { workspace: { openLinkText: async (href: string, path: string) => { opened.push([href, path]); } } };
  const sync = (enabled = true, path = "sets/default.md") => cards.syncCard(app as any, owner as any, card as any, enabled, path,
    () => { layouts++; syncMarginCardPresentation(card as any); });
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  sync(false);
  assert.equal(card.children.length, 2, "OFF creates no previews");
  assert.equal(owner.children.size, 0);
  const samples = [
    "Gradient descent moves downhill.",
    String.raw`Stationary point: $\nabla f(x^\*) = 0$.`,
    "$$\nx_{k+1} = x_k - \\alpha \\nabla f(x_k)\n$$",
    "**Important:** this is a *strict saddle point*.",
    "- local minimum\n- local maximum\n- saddle point",
    "A strict saddle satisfies\n\n$$\n\\lambda_{\\min}(\\nabla^2 f(x^\\*)) < 0\n$$\n\nwhich means there is a direction of **negative curvature**.",
  ];
  for (const sample of samples) {
    note.value = sample;
    sync();
    const call = calls.at(-1)!;
    assert.equal(call.markdown, sample, "Markdown and backslashes reach Obsidian unchanged");
    assert.equal(call.path, "sets/default.md");
    call.resolve(); await settle();
    assert.equal(note.hidden, true);
  }
  const preview = card.querySelector(".lpa-margin-note-preview")!;
  const link = preview.createEl("a", { cls: "internal-link", attr: { "data-href": "Target" } });
  const linkClick = new Event("click", { cancelable: true });
  Object.defineProperty(linkClick, "target", { value: link });
  preview.dispatchEvent(linkClick);
  assert.deepEqual(opened, [["Target", "sets/default.md"]]);
  assert.equal(note.hidden, true, "links do not start editing");
  preview.dispatchEvent(new Event("click"));
  assert.equal(doc.activeElement, note);
  assert.equal(note.hidden, false);
  assert.equal(preview.hidden, true);
  assert.equal(cards.editingCard(), card);
  note.value = "Changed **raw** $x$";
  note.dispatchEvent(new Event("input"));
  const before = calls.length;
  sync();
  assert.equal(calls.length, before, "store synchronization does not render over an editor");
  assert.equal(doc.activeElement, note, "store synchronization preserves focus");
  assert.equal(saved, note.value, "existing input persistence is unchanged");
  note.blur();
  assert.equal(note.hidden, true);
  assert.equal(preview.hidden, false);
  calls.at(-1)!.resolve(); await settle();
  assert.equal(calls.at(-1)!.target.textContent, saved);

  // Late async rendering must never overwrite the current result.
  note.value = "old"; sync(); const old = calls.at(-1)!;
  let unloaded = 0; old.owner.register(() => unloaded++);
  note.value = "new"; sync(); const latest = calls.at(-1)!;
  assert.equal(unloaded, 1);
  let lateCleanup = 0;
  old.owner.register(() => lateCleanup++);
  const lateChild = new Component();
  lateChild.load();
  lateChild.register(() => lateCleanup++);
  old.owner.addChild(lateChild);
  assert.equal(lateCleanup, 2, "late postprocessor resources are cleaned after the render was replaced");
  assert.equal(old.owner.children.size, 0, "a disposed render cannot retain new child components");
  latest.resolve(); await settle(); old.resolve(); await settle();
  assert.equal(preview.children[0].textContent, "new");
  const rendered = calls.length;
  sync(); assert.equal(calls.length, rendered, "layout passes do not render unchanged text");
  sync(true, "sets/second.md");
  assert.equal(calls.at(-1)!.path, "sets/second.md");
  calls.at(-1)!.resolve(); await settle();

  // Empty notes do not call MarkdownRenderer and remain editable.
  note.value = ""; sync();
  assert.equal(calls.length, rendered + 1);
  assert.equal(preview.children[0].textContent, "");
  cards.focus(side as any);
  assert.equal(side.hidden, false);
  side.value = "Side **note**"; side.blur();
  assert.equal(calls.at(-1)!.markdown, side.value);
  calls.at(-1)!.resolve(); await settle();
  const priorLayouts = layouts; resized!(); assert.ok(layouts > priorLayouts);

  // Renderer failures expose safe text; teardown cancels listeners/observers.
  note.value = "<bad>"; sync();
  const failed = calls.at(-1)!;
  const log = console.error; console.error = () => {};
  failed.reject(new Error("test failure")); await settle(); console.error = log;
  assert.equal(preview.children[0].textContent, "<bad>");
  cards.focus(note as any);
  sync(false);
  assert.equal(card.children.length, 2);
  assert.equal(note.hidden, false);
  assert.equal(doc.activeElement, note, "disabling preserves an active editor");
  assert.equal(owner.children.size, 0);
  assert.equal(disconnected, 2);
  note.blur(); assert.equal(note.hidden, false, "OFF removes blur behavior");
  note.value = "pending"; sync();
  cards.release(owner as any, card as any);
  const releasedLayouts = layouts;
  for (const call of calls) call.resolve();
  await settle();
  assert.equal(layouts, releasedLayouts, "disposed renders do not schedule layout");
  assert.equal(card.children.length, 2);
  assert.equal(owner.children.size, 0);
  owner.unload();

  // Exercise the real card builders and synchronous store notifications in
  // both views, with only PDF geometry and Obsidian services stubbed out.
  MarkdownRenderer.render = async (_app, markdown, target) => { target.textContent = markdown; };
  for (const native of [false, true]) {
    let enabled = true;
    const leafOwner = new Component(); leafOwner.load();
    const view: any = native
      ? new NativePdfOverlay({ app } as any, { view: leafOwner } as any, { path: "book.pdf" } as any,
          () => ({}), undefined, undefined, undefined, undefined, () => enabled)
      : new PdfAnnotatorView({ app } as any, undefined, undefined, undefined, undefined, undefined, () => enabled);
    if (!native) { view.onload = () => {}; view.load(); }
    const left = new Element(doc), right = new Element(doc), margins = new Element(doc);
    margins.append(left); margins.append(right);
    let visible = true;
    const h = { id: "a", type: "highlight", page: 0, text: "Quote", note: "**Note**", noteContentCJK: "Side $x$",
      setId: "default", color: "#ffff00", created: "2026-01-01", rects: [] };
    const highlights = [h];
    view.store = {
      get: (id: string) => highlights.find(annotation => annotation.id === id),
      get doc() { return { highlights: visible ? highlights : [] }; },
      setMeta: () => null, annotationSourcePath: () => "sets/default.md",
      update: (_id: string, patch: any) => {
        Object.assign(h, patch);
        if (native) view.syncCardContent(left.children[0], h);
        else view.onAnnotationSetsChanged();
      },
    };
    for (const method of ["scheduleMarginLayout", "scheduleRailLayout", "renderAnnotationRollList", "syncHighlightBindingState",
      "updateAnnotationSetButton", "updateElasticMargins", "syncMarginCollapseState", "activateHighlight", "setActiveAnnotation",
      "repaintPage", "updateCount"]) view[method] = () => {};
    view.computeAnnotationAnchor = () => ({ side: "left", idealY: 0 });
    view.leftMarginEl = left; view.rightMarginEl = right; view.annotationCountEl = new Element(doc);
    view.marginsEl = margins;
    const buildCard = () => native ? view.createRailCard(left, h, "left") : view.createMarginCard(left, h, "left");
    const built = buildCard() as Element;
    // Exercise the real bubbling handlers, not just a selector helper. A
    // browser owns word selection; the card must leave its default untouched.
    const assertSelectionPreserved = (card: Element) => {
      let shortcuts = 0;
      const shortcut = native ? "focusRailNote" : "activateHighlight";
      const original = view[shortcut];
      view[shortcut] = () => { shortcuts++; };
      const primary = card.querySelector(".lpa-margin-note")!;
      const secondary = card.querySelector(".lpa-margin-side-note")!;
      const controls = [primary, secondary, card.querySelector("button")!];
      const temporary: Element[] = [];
      for (const tag of ["input", "select", "a"]) {
        const control = card.createEl(tag); temporary.push(control); controls.push(control);
      }
      for (const value of ["", "true", "plaintext-only"]) {
        const editable = card.createEl("div", { attr: { contenteditable: value } });
        temporary.push(editable); controls.push(editable.createSpan({}));
      }
      for (const target of controls) {
        doc.activeElement = target;
        const event = new Event("dblclick", { cancelable: true });
        Object.defineProperty(event, "target", { value: target });
        card.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, "controls retain their default double-click behavior");
        assert.equal(doc.activeElement, target, "card must not move focus from an editable field");
        assert.equal(shortcuts, 0, "double-click inside controls must not invoke the card shortcut");
      }
      const background = new Event("dblclick", { cancelable: true });
      card.dispatchEvent(background);
      assert.equal(background.defaultPrevented, true);
      assert.equal(shortcuts, 1, "card background still opens the main note editor");
      for (const control of temporary) control.remove();
      doc.activeElement = null;
      view[shortcut] = original;
    };
    assertSelectionPreserved(built);
    const editor = built.querySelector(".lpa-margin-note")!;
    built.querySelector(".lpa-margin-note-preview")!.dispatchEvent(new Event("click"));
    editor.value = "Updated $x$"; editor.dispatchEvent(new Event("input"));
    assert.equal(left.children[0], built, "synchronous store notifications preserve the card being edited");
    assert.equal(doc.activeElement, editor);
    assert.equal(h.note, "Updated $x$");
    assert.equal(editor.hidden, false);
    editor.blur(); await settle();
    const current = left.children[0];
    assert.equal(current.querySelector(".lpa-margin-note")!.hidden, true);
    assert.equal(current.querySelector(".lpa-margin-note-preview")!.children[0].textContent, "Updated $x$");
    const sideEditor = current.querySelector(".lpa-margin-side-note")!;
    current.querySelector(".lpa-margin-side-note-preview")!.dispatchEvent(new Event("click"));
    sideEditor.value = "**Side changed**"; sideEditor.dispatchEvent(new Event("input"));
    assert.equal(h.noteContentCJK, "**Side changed**");
    enabled = false; view.refreshAnnotationPresentation();
    assert.equal(margins.querySelectorAll(".lpa-margin-note-preview, .lpa-margin-side-note-preview").length, 0);
    assert.equal(sideEditor.hidden, false);
    assert.equal(doc.activeElement, sideEditor);
    assertSelectionPreserved(current);
    doc.activeElement = sideEditor;
    enabled = true; view.refreshAnnotationPresentation();
    assert.equal(sideEditor.hidden, false, "enabling keeps an already focused editor open");
    sideEditor.blur(); await settle();
    if (!native) {
      // Tag/region pointerdown prevents the browser from blurring the old
      // textarea. Explicit navigation must finish that edit so a previously
      // hidden, unpinned target card can be built and receive focus.
      const other = { ...h, id: "region", type: "tag", tagStyle: "region", note: "Target region" };
      highlights.push(other);
      view.activeHighlightId = h.id;
      view.sidebarCardFor = (id: string) => left.children.find(card => card.dataset.hlId === id) ?? null;
      view.activateHighlight = (PdfAnnotatorView.prototype as any).activateHighlight;
      const last = left.children[0];
      last.querySelector(".lpa-margin-note-preview")!.dispatchEvent(new Event("click"));
      const editing = doc.activeElement;
      assert.equal(view.sidebarCardFor(other.id), null, "unpinned region starts without a margin card");
      view.renderAnnotationSidebar();
      assert.equal(doc.activeElement, editing, "background rendering still preserves editing");
      const previousWindow = (globalThis as any).window;
      (globalThis as any).window = { setTimeout };
      try {
        view.activateHighlight(other.id, { focusNote: true });
        await new Promise(resolve => setTimeout(resolve, 5));
        const target = view.sidebarCardFor(other.id);
        assert.ok(target, "explicit navigation creates the target region card while another note is being edited");
        const targetNote = target.querySelector(".lpa-margin-note");
        assert.equal(doc.activeElement, targetNote, "explicit navigation transfers focus to the target note");
        assert.equal(targetNote.hidden, false);
        assert.equal(h.note, "Updated $x$", "focus transfer preserves the saved source note");
      } finally {
        (globalThis as any).window = previousWindow;
      }
      visible = false; view.renderAnnotationSidebar();
      assert.equal(left.children.length, 0, "hiding a set removes its editing card");
    }
    view.markdownCards.release(native ? leafOwner : view);
    if (!native) { view.onunload = () => {}; view.unload(); }
    leafOwner.unload();
  }
  console.log("annotation Markdown smoke: raw text, edit/preview, OFF, source paths, async races, cleanup and card double-click selection passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
