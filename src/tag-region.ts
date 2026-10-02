import type { Highlight } from "./annotations";

/** A region is a presentation of a page note, retaining its ID, card and set. */
export function tagStylePatch(tag: Highlight, style: "label" | "region"): Partial<Highlight> {
  if (style === "label") return { tagStyle: style };
  const positive = (n: number | undefined, fallback: number) =>
    Number.isFinite(n) && n! > 0 ? Math.min(n!, 100) : fallback;
  const width = positive(tag.tagWidth, 24);
  const height = positive(tag.tagHeight, 14);
  const center = (n: number | undefined, size: number) =>
    Math.max(size / 2, Math.min(100 - size / 2, Number.isFinite(n) ? n! : 50));
  return { tagStyle: style, tagX: center(tag.tagX, width), tagY: center(tag.tagY, height),
    tagWidth: width, tagHeight: height };
}

/** Only the outline intercepts pointers; diagram links and text inside remain usable. */
export function applyTagStyle(el: HTMLElement, tag: Highlight): void {
  const region = tag.tagStyle === "region";
  el.classList.toggle("is-region", region);
  el.setAttribute("aria-label", region ? `Region annotation: ${tag.note || "Page note"}` : tag.note || "Page note");
  if (region) {
    for (const side of ["top", "right", "bottom", "left"]) {
      el.createDiv({ cls: `lpa-region-edge lpa-region-edge--${side}`, attr: { "aria-hidden": "true" } });
    }
  }
}

/** Connect cards to the near edge so the connector does not cross the diagram. */
export function tagAnchorXPercent(tag: Highlight, side: "left" | "right"): number {
  const center = tag.tagX ?? 0;
  const halfWidth = tag.tagStyle === "region" && Number.isFinite(tag.tagWidth)
    ? Math.max(0, Math.min(tag.tagWidth!, 100)) / 2 : 0;
  return Math.max(0, Math.min(100, center + (side === "left" ? -halfWidth : halfWidth)));
}
