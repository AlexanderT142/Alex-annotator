/** Keep the sync folder out of the way. Pure helpers; the controller applies them. */

/** CSS that hides the sync folder in the file explorer. Sync tools still see it. */
export function hideFolderCss(folder: string): string {
  const v = folder.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    `.nav-folder:has(> .nav-folder-title[data-path="${v}"]) { display: none; }`,
    `.nav-folder-title[data-path="${v}"], .nav-folder-title[data-path="${v}"] + .nav-folder-children { display: none; }`,
  ].join("\n");
}

/**
 * Add the folder to Obsidian's "Excluded files" list. Idempotent: an entry for
 * the same folder (with or without a trailing slash) is never added twice.
 */
export function withExcludedFolder(current: unknown, folder: string): { filters: string[]; changed: boolean } {
  const filters = Array.isArray(current) ? current.filter((x): x is string => typeof x === "string") : [];
  const bare = (x: string) => x.trim().replace(/\/+$/, "");
  if (filters.some((x) => bare(x) === bare(folder))) return { filters, changed: false };
  return { filters: [...filters, `${bare(folder)}/`], changed: true };
}
