/** Card navigation shortcuts must not steal selection or control interactions.
 * Duck typing also works for elements in Obsidian pop-out windows. */
export function isMarginCardInteractiveTarget(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.(
    "textarea,input,select,button,a,[contenteditable]:not([contenteditable='false'])"
  );
}

/** Preserve the complete selected passage while normalising PDF text-layer
 * whitespace for a readable margin-card quotation. */
export function marginCardSourceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export const FOLDED_CARD_MIN_HEIGHT = 54;
const FOLDED_CARD_MAX_HEIGHT = 188;

/** A linear-then-logarithmic fold keeps length legible without letting several
 * long notes consume the rail. Every additional passage still makes the
 * resting card taller, but progressively less so. */
export function foldedMarginCardHeight(displayUnits: number): number {
  const units = Math.max(0, displayUnits);
  // Keep the first few hundred characters close to linear so a glance at the
  // rail genuinely communicates "short / medium / long". Only the tail is
  // logarithmic, which prevents very long notes from taking over a busy page.
  const linearUnits = Math.min(units, 360);
  const tailUnits = Math.max(0, units - linearUnits);
  const scaled =
    FOLDED_CARD_MIN_HEIGHT +
    linearUnits * 0.24 +
    18 * Math.log2(1 + tailUnits / 220);
  return Math.round(Math.min(FOLDED_CARD_MAX_HEIGHT, scaled));
}

/** Compress a whole rail only when its resting cards would not fit. The same
 * factor is applied to every card's extra height, so their relative lengths
 * remain visible instead of collapsing into one uniform stack. */
export function fitFoldedMarginCardHeights(heights: number[], availableHeight: number): number[] {
  if (!heights.length) return [];
  const clean = heights.map((height) => Math.max(24, height));
  const available = Math.max(24 * clean.length, availableHeight);
  const total = clean.reduce((sum, height) => sum + height, 0);
  if (total <= available) return clean.map(Math.round);

  const floors = clean.map((height) => Math.min(height, FOLDED_CARD_MIN_HEIGHT));
  const floorTotal = floors.reduce((sum, height) => sum + height, 0);
  if (floorTotal >= available) {
    const scale = available / floorTotal;
    return floors.map((height) => Math.max(24, Math.floor(height * scale)));
  }

  const extraBudget = available - floorTotal;
  const extras = clean.map((height, index) => height - floors[index]);
  const extraTotal = extras.reduce((sum, height) => sum + height, 0);
  const scale = extraTotal > 0 ? Math.min(1, extraBudget / extraTotal) : 0;
  return clean.map((_, index) => Math.round(floors[index] + extras[index] * scale));
}

export interface PageBoundedCardLayoutItem {
  page: number;
  idealY: number;
  height: number;
  pageTopY: number;
  pageBottomY: number;
}

/** Stack cards inside their own page band instead of the viewport band.
 *
 * Keeping the page bounds in the same coordinate space as `idealY` makes the
 * result translation invariant: when a page scrolls by 100px, every card for
 * that page also moves by 100px. The viewport clips cards naturally as they
 * leave it, and cards from an entering adjacent page start in that page's own
 * band instead of being packed into the outgoing page's stack. */
export function layoutPageBoundedCardTops(
  items: PageBoundedCardLayoutItem[],
  gap = 5,
  inset = 8
): number[] {
  const tops = new Array<number>(items.length);
  const byPage = new Map<number, Array<{ item: PageBoundedCardLayoutItem; index: number }>>();
  items.forEach((item, index) => {
    const group = byPage.get(item.page) ?? [];
    group.push({ item, index });
    byPage.set(item.page, group);
  });

  for (const group of byPage.values()) {
    group.sort((a, b) => a.item.idealY - b.item.idealY || a.index - b.index);
    const pageTop = Math.min(...group.map(({ item }) => item.pageTopY));
    const pageBottom = Math.max(...group.map(({ item }) => item.pageBottomY));
    const pageStart = pageTop + inset;
    const pageEnd = Math.max(pageStart, pageBottom - inset);

    let y = pageStart;
    for (const entry of group) {
      y = Math.max(entry.item.idealY, y);
      tops[entry.index] = y;
      y += Math.max(24, entry.item.height) + gap;
    }

    const overflow = y - gap - pageEnd;
    if (overflow > 0) {
      const firstTop = tops[group[0].index];
      const shift = Math.min(overflow, Math.max(0, firstTop - pageStart));
      if (shift > 0) {
        for (const entry of group) tops[entry.index] -= shift;
      }
    }
  }

  return tops;
}

function displayUnits(text: string, weight = 1): number {
  const lineBreaks = (text.match(/\n/g) ?? []).length;
  const wideCharacters = (text.match(/[\u2e80-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return (text.length + lineBreaks * 24 + wideCharacters * 0.65) * weight;
}

/** Textareas do not grow with their value by default. Size every margin-card
 * editor to its content so the card's natural height reflects the annotation
 * length; the card itself supplies the collapsed/expanded viewport rules. */
export function syncMarginCardPresentation(card: HTMLElement): void {
  for (const textarea of card.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    if (textarea.hidden) continue;
    textarea.setCssProps({ height: "auto" });
    textarea.setCssProps({ height: `${Math.max(textarea.scrollHeight, 20)}px` });
  }

  const note = card.querySelector<HTMLTextAreaElement>(".lpa-margin-note")?.value ?? "";
  const sideNote = card.querySelector<HTMLTextAreaElement>(".lpa-margin-side-note")?.value ?? "";
  const source = card.querySelector<HTMLElement>(".lpa-margin-source")?.textContent ?? "";
  // User-authored comments are the strongest signal; the quoted source still
  // contributes enough to distinguish short and long selected passages.
  const units = displayUnits(note) + displayUnits(sideNote) + displayUnits(source, 0.25);
  const foldedHeight = foldedMarginCardHeight(units);
  card.style.setProperty("--lpa-card-folded-height", `${foldedHeight}px`);
  card.dataset.foldedHeight = String(foldedHeight);
  card.classList.toggle("is-folded", units > 64);
}
