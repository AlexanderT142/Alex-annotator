import type { App } from "obsidian";

export function panelPlacement(anchor: { left: number; right: number; top: number; bottom: number }, viewport: { width: number; height: number }, preferredWidth: number) {
  const gutter = 12, gap = 8;
  const width = Math.min(preferredWidth, Math.max(0, viewport.width - gutter * 2));
  const left = Math.max(gutter, Math.min(anchor.right - width, viewport.width - width - gutter));
  const below = viewport.height - anchor.bottom - gap - gutter;
  const above = anchor.top - gap - gutter;
  const openAbove = below < 180 && above > below;
  return {
    width, left,
    top: openAbove ? undefined : Math.max(gutter, anchor.bottom + gap),
    bottom: openAbove ? Math.max(gutter, viewport.height - anchor.top + gap) : undefined,
    maxHeight: Math.max(0, openAbove ? above : below),
  };
}

/** Non-modal toolbar panel: the PDF remains interactive, with no backdrop. */
export class AnchoredPanel {
  private static panels = new Set<AnchoredPanel>();
  contentEl!: HTMLElement;
  modalEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private cleanups: Array<() => void> = [];
  private frame = 0;
  private opened = false;

  constructor(public app: App, private anchor?: HTMLElement, private width = 520) {}

  static closeAll(): void {
    for (const panel of [...this.panels]) panel.close(false);
  }

  setTitle(title: string): void { this.titleEl.setText(title); }
  onOpen(): void {}
  onClose(): void {}

  open(): void {
    const anchor = this.anchor;
    if (!anchor?.isConnected) return;
    const doc = anchor.ownerDocument;
    const win = doc.defaultView!;
    const previous = [...AnchoredPanel.panels].find((panel) => panel.anchor?.ownerDocument === doc);
    const sameAnchor = previous?.anchor === anchor;
    previous?.close(false);
    if (sameAnchor) { anchor.focus({ preventScroll: true }); return; }

    this.modalEl = doc.createElement("section");
    this.modalEl.className = "lpa-toolbar-panel";
    this.modalEl.id = `lpa-panel-${crypto.randomUUID()}`;
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "false");
    const header = this.modalEl.createDiv({ cls: "lpa-toolbar-panel-header" });
    this.titleEl = header.createEl("h3");
    this.titleEl.id = `${this.modalEl.id}-title`;
    this.modalEl.setAttribute("aria-labelledby", this.titleEl.id);
    const close = header.createEl("button", { text: "×", attr: { type: "button", "aria-label": "Close panel" } });
    close.onclick = () => this.close();
    this.contentEl = this.modalEl.createDiv({ cls: "lpa-toolbar-panel-content" });
    doc.body.append(this.modalEl);
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", this.modalEl.id);
    anchor.setAttribute("aria-haspopup", "dialog");
    this.opened = true;
    AnchoredPanel.panels.add(this);

    const position = () => {
      if (!anchor.isConnected) { this.close(false); return; }
      const placement = panelPlacement(anchor.getBoundingClientRect(), { width: win.innerWidth, height: win.innerHeight }, this.width);
      Object.assign(this.modalEl.style, {
        width: `${placement.width}px`, left: `${placement.left}px`,
        top: placement.top === undefined ? "auto" : `${placement.top}px`,
        bottom: placement.bottom === undefined ? "auto" : `${placement.bottom}px`,
        maxHeight: `${placement.maxHeight}px`,
      });
    };
    const schedule = () => {
      if (!this.frame) this.frame = win.requestAnimationFrame(() => { this.frame = 0; position(); });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || this.modalEl.contains(target) || anchor.contains(target)) return;
      // Preserve the parent while a provider model chooser is open.
      if (target.closest?.(".modal-container, .suggestion-container")) return;
      this.close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || doc.querySelector(".modal-container")) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    };
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", escape, true);
    doc.addEventListener("scroll", schedule, true);
    win.addEventListener("resize", schedule);
    const observer = new MutationObserver(() => { if (!anchor.isConnected) this.close(false); });
    observer.observe(doc.body, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(anchor);
    this.cleanups.push(() => {
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", escape, true);
      doc.removeEventListener("scroll", schedule, true);
      win.removeEventListener("resize", schedule);
      observer.disconnect(); resize.disconnect();
      if (this.frame) win.cancelAnimationFrame(this.frame);
    });
    this.onOpen();
    position();
    this.contentEl.querySelector<HTMLElement>("button, input, select, textarea")?.focus({ preventScroll: true });
  }

  close(restoreFocus = true): void {
    if (!this.opened) return;
    this.opened = false;
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.onClose();
    this.modalEl.remove();
    this.anchor?.setAttribute("aria-expanded", "false");
    this.anchor?.removeAttribute("aria-controls");
    AnchoredPanel.panels.delete(this);
    if (restoreFocus && this.anchor?.isConnected) this.anchor.focus({ preventScroll: true });
  }
}
