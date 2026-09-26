import { App, Component, MarkdownRenderer } from "obsidian";

export async function renderAnnotationMarkdown(
  app: App, container: HTMLElement, markdown: string, sourcePath: string, component: Component
): Promise<void> {
  container.empty();
  if (markdown.trim()) await MarkdownRenderer.render(app, markdown, container, sourcePath, component);
}

/** Owns only presentation; the existing textarea input handler owns persistence. */
export class AnnotationMarkdownEditor extends Component {
  readonly preview: HTMLElement;
  editing: boolean;
  private disposed = false;
  private generation = 0;
  private renderedKey: string | null = null;
  private renderOwner: Component | null = null;

  constructor(
    private app: App,
    readonly textarea: HTMLTextAreaElement,
    private sourcePath: string,
    private changed: () => void,
    private finished: () => void
  ) {
    super();
    this.editing = textarea.ownerDocument.activeElement === textarea;
    this.preview = textarea.ownerDocument.createElement("div");
    this.preview.className = textarea.classList.contains("lpa-margin-side-note")
      ? "lpa-margin-side-note-preview" : "lpa-margin-note-preview";
    this.preview.tabIndex = 0;
    this.preview.setAttribute("aria-label", `${textarea.getAttribute("aria-label") ?? "Annotation"} — edit`);
    textarea.after(this.preview);
  }

  onload(): void {
    this.registerDomEvent(this.preview, "mousedown", (event: MouseEvent) => {
      // Keep the old editor focused until click can transfer focus directly to
      // the new editor. A blur-triggered card rebuild must not swallow click.
      const target = event.target as HTMLElement;
      if (event.button === 0 && !target.closest?.("button,input,select,[contenteditable='true']")) {
        event.preventDefault();
      }
    });
    this.registerDomEvent(this.preview, "click", (event: MouseEvent) => {
      event.stopPropagation();
      const target = event.target as HTMLElement;
      const link = target.closest?.("a");
      if (link) {
        if (link.classList.contains("internal-link")) {
          event.preventDefault();
          const href = link.getAttribute("data-href") ?? link.getAttribute("href");
          if (href) void this.app.workspace.openLinkText(href, this.sourcePath, event.ctrlKey || event.metaKey);
        }
        return;
      }
      if (target.closest?.("button,input,select,[contenteditable='true']")) return;
      this.beginEditing();
    });
    this.registerDomEvent(this.preview, "dblclick", (event: MouseEvent) => event.stopPropagation());
    this.registerDomEvent(this.preview, "keydown", (event: KeyboardEvent) => {
      if (event.target === this.preview && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        this.beginEditing();
      }
    });
    this.registerDomEvent(this.textarea, "blur", () => {
      // Input already saved the raw value, with the store's normal debounce.
      this.editing = false;
      this.sync(this.sourcePath);
      this.changed();
      this.finished();
    });
    const Observer = this.textarea.ownerDocument.defaultView?.ResizeObserver;
    if (Observer) {
      const observer = new Observer(() => { if (!this.disposed) this.changed(); });
      observer.observe(this.preview);
      this.register(() => observer.disconnect());
    }
    this.sync(this.sourcePath);
  }

  beginEditing(): void {
    if (this.disposed) return;
    this.editing = true;
    this.textarea.hidden = false;
    this.preview.hidden = true;
    this.textarea.focus({ preventScroll: true });
    this.changed();
  }

  sync(sourcePath: string): void {
    this.sourcePath = sourcePath;
    this.textarea.hidden = !this.editing;
    this.preview.hidden = this.editing;
    if (this.editing || this.disposed) return;
    const markdown = this.textarea.value;
    const key = JSON.stringify([sourcePath, markdown]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const generation = ++this.generation;
    if (this.renderOwner) this.removeChild(this.renderOwner);
    const owner = this.addChild(new Component());
    this.renderOwner = owner;
    // Each render gets its own attached target: late async writes cannot touch
    // a newer preview, while postprocessors can measure connected elements.
    this.preview.empty();
    const target = this.preview.createDiv({ cls: "lpa-annotation-markdown-content" });
    void renderAnnotationMarkdown(this.app, target, markdown, sourcePath, owner)
      .catch((error) => {
        if (!this.disposed && generation === this.generation) {
          target.textContent = markdown;
          console.error("PDF Annotator: annotation Markdown rendering failed", error);
        }
      })
      .finally(() => {
        if (this.disposed || generation !== this.generation) {
          // Async postprocessors may have registered children after disposal.
          owner.unload();
          return;
        }
        this.changed();
      });
  }

  onunload(): void {
    this.disposed = true;
    this.generation++;
    this.preview.remove();
    this.textarea.hidden = false;
  }
}

/** Small per-view registry, explicitly released before cards leave the DOM. */
export class AnnotationMarkdownCards {
  private editors = new Map<HTMLTextAreaElement, AnnotationMarkdownEditor>();

  syncCard(app: App, owner: Component, card: HTMLElement, enabled: boolean,
    sourcePath: string, changed: () => void, finished: () => void = changed): void {
    for (const textarea of card.querySelectorAll<HTMLTextAreaElement>(".lpa-margin-note, .lpa-margin-side-note")) {
      let editor = this.editors.get(textarea);
      if (!enabled) {
        if (editor) { owner.removeChild(editor); this.editors.delete(textarea); }
        continue;
      }
      if (!editor) {
        editor = new AnnotationMarkdownEditor(app, textarea, sourcePath, changed, finished);
        this.editors.set(textarea, editor);
        owner.addChild(editor);
      } else editor.sync(sourcePath);
    }
  }

  editingCard(): HTMLElement | null {
    for (const [textarea, editor] of this.editors) {
      if (editor.editing) return textarea.closest(".lpa-margin-card");
    }
    return null;
  }

  focus(textarea: HTMLTextAreaElement): void {
    const editor = this.editors.get(textarea);
    if (editor) editor.beginEditing();
    else textarea.focus({ preventScroll: true });
  }

  release(owner: Component, card?: HTMLElement): void {
    for (const [textarea, editor] of this.editors) {
      if (!card || card.contains(textarea)) {
        owner.removeChild(editor);
        this.editors.delete(textarea);
      }
    }
  }
}
