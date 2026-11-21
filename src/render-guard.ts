/**
 * Render one annotation without letting it break the others. An annotation
 * with unexpected data (from a damaged file, a newer plugin version, or sync)
 * is skipped and reported once instead of stopping the whole page or list.
 */
const reported = new Set<string>();

export function renderGuard(id: string, render: () => void): void {
  try {
    render();
  } catch (error) {
    if (reported.has(id)) return;
    reported.add(id);
    console.warn(`[PDF Annotator] skipped drawing annotation ${id}: its data could not be displayed`, error);
  }
}
