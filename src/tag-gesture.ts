import type { Highlight } from "./annotations";

export type TagGeometry = Pick<Highlight, "tagX" | "tagY" | "tagWidth" | "tagHeight">;
type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;
const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);

/** Page-relative geometry; resizing keeps the top-left corner in place. */
export function tagGestureGeometry(
  mode: "move" | "resize", page: Box, start: TagGeometry, size: Box,
  offset: { x: number; y: number }, pointer: { clientX: number; clientY: number }
): TagGeometry {
  const px = (pointer.clientX - page.left) / page.width * 100;
  const py = (pointer.clientY - page.top) / page.height * 100;
  const width = Math.min(100, size.width / page.width * 100);
  const height = Math.min(100, size.height / page.height * 100);
  if (mode === "move") {
    return {
      tagX: clamp(px - offset.x, width / 2, 100 - width / 2),
      tagY: clamp(py - offset.y, height / 2, 100 - height / 2),
    };
  }
  const left = clamp((start.tagX ?? 0) - width / 2, 0, 100);
  const top = clamp((start.tagY ?? 0) - height / 2, 0, 100);
  const tagWidth = clamp(px - offset.x - left, Math.min(40 / page.width * 100, 100 - left), 100 - left);
  const tagHeight = clamp(py - offset.y - top, Math.min(22 / page.height * 100, 100 - top), 100 - top);
  return { tagX: left + tagWidth / 2, tagY: top + tagHeight / 2, tagWidth, tagHeight };
}

export function applyTagGeometry(el: HTMLElement, geometry: TagGeometry): void {
  el.setCssProps({ left: `${geometry.tagX ?? 0}%`, top: `${geometry.tagY ?? 0}%` });
  const sized = Number.isFinite(geometry.tagWidth) && Number.isFinite(geometry.tagHeight)
    && geometry.tagWidth! > 0 && geometry.tagHeight! > 0;
  el.classList.toggle("is-resized", sized);
  el.setCssProps({
    width: sized ? `${Math.min(100, geometry.tagWidth!)}%` : "",
    height: sized ? `${Math.min(100, geometry.tagHeight!)}%` : "",
  });
}

/** One gesture per viewer. No persistence until release; cancellation restores the tag. */
export class TagGestureController {
  private active: { el: HTMLElement; id: string; geometry: TagGeometry } | null = null;
  private cleanup: (() => void) | null = null;
  private clearClickGuard: (() => void) | null = null;

  previewFor(id: string): TagGeometry {
    return this.active?.id === id ? this.active.geometry : {};
  }

  cancelIn(layer: HTMLElement): void {
    if (this.active && layer.contains(this.active.el)) this.cancel();
  }

  cancel(): void {
    this.cleanup?.();
  }

  destroy(): void {
    this.cancel();
    this.clearClickGuard?.();
  }

  bind(el: HTMLElement, layer: HTMLElement, tag: Highlight,
    commit: (geometry: TagGeometry) => void, layout: () => void): void {
    applyTagGeometry(el, tag);
    el.setAttribute("title", "Click to edit · Drag to move · Drag bottom-right corner to resize");
    const handle = el.createDiv({ cls: "lpa-tag-resize-handle", attr: {
      "aria-label": "Drag to resize page note", title: "Drag to resize page note",
    } });
    handle.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); });
    el.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0 || !evt.isPrimary) return;
      this.cancel();
      this.clearClickGuard?.();
      const doc = el.ownerDocument;
      const win = doc.defaultView;
      if (!win) return;
      const page = layer.getBoundingClientRect();
      if (page.width <= 0 || page.height <= 0) return;
      const mode = handle.contains(evt.target as Node) ? "resize" : "move";
      const size = el.getBoundingClientRect();
      const start = { tagX: tag.tagX, tagY: tag.tagY, tagWidth: tag.tagWidth, tagHeight: tag.tagHeight };
      const offset = {
        x: (evt.clientX - page.left) / page.width * 100 - (tag.tagX ?? 0)
          - (mode === "resize" ? size.width / page.width * 50 : 0),
        y: (evt.clientY - page.top) / page.height * 100 - (tag.tagY ?? 0)
          - (mode === "resize" ? size.height / page.height * 50 : 0),
      };
      let moved = false;
      let ended = false;
      this.active = { el, id: tag.id, geometry: start };
      evt.preventDefault();
      evt.stopPropagation();

      const guardClick = () => {
        this.clearClickGuard?.();
        const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
        doc.addEventListener("click", stop, true);
        const clear = () => {
          doc.removeEventListener("click", stop, true);
          win.clearTimeout(timer);
          this.clearClickGuard = null;
        };
        const timer = win.setTimeout(clear, 0);
        this.clearClickGuard = clear;
      };
      const finish = (save: boolean) => {
        if (ended) return;
        ended = true;
        const geometry = this.active?.geometry;
        doc.removeEventListener("pointermove", move, true);
        doc.removeEventListener("pointerup", up, true);
        doc.removeEventListener("pointercancel", cancel, true);
        doc.removeEventListener("keydown", key, true);
        el.removeEventListener("lostpointercapture", cancel);
        win.removeEventListener("blur", cancel);
        this.active = null;
        this.cleanup = null;
        el.classList.remove("is-dragging", "is-resizing");
        if (el.hasPointerCapture(evt.pointerId)) el.releasePointerCapture(evt.pointerId);
        if (moved) guardClick();
        if (save && moved && geometry) commit(geometry);
        else applyTagGeometry(el, start);
        layout();
      };
      const update = (e: PointerEvent) => {
        if (!el.isConnected || !layer.isConnected) { finish(false); return; }
        if (!moved && Math.hypot(e.clientX - evt.clientX, e.clientY - evt.clientY) < 4) return;
        const box = layer.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) { finish(false); return; }
        moved = true;
        el.classList.add(mode === "resize" ? "is-resizing" : "is-dragging");
        const scaledSize = { ...size,
          width: size.width * box.width / page.width,
          height: size.height * box.height / page.height,
        };
        const geometry = { ...start, ...tagGestureGeometry(mode, box, start, scaledSize, offset, e) };
        this.active = { el, id: tag.id, geometry };
        applyTagGeometry(el, geometry);
        layout();
      };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== evt.pointerId) return;
        if (!(e.buttons & 1)) { finish(false); return; }
        e.preventDefault();
        e.stopPropagation();
        update(e);
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== evt.pointerId) return;
        update(e); // Include the final release position even without a last move event.
        if (moved) { e.preventDefault(); e.stopPropagation(); }
        finish(true);
      };
      const cancel = (e: Event) => {
        if ("pointerId" in e && (e as PointerEvent).pointerId !== evt.pointerId) return;
        finish(false);
      };
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(false);
      };
      this.cleanup = () => finish(false);
      doc.addEventListener("pointermove", move, true);
      doc.addEventListener("pointerup", up, true);
      doc.addEventListener("pointercancel", cancel, true);
      doc.addEventListener("keydown", key, true);
      el.addEventListener("lostpointercapture", cancel);
      win.addEventListener("blur", cancel);
      el.setPointerCapture(evt.pointerId);
    });
  }
}
