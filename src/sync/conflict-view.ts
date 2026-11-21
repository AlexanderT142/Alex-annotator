/**
 * Display-only helpers for notes that sync stitched together. The stored
 * text (see stitch() in merge.ts) is never changed here: these functions only
 * read it to present the kept versions more clearly.
 */

const MARKER = /^\[Sync conflict kept · (.+?) · (.+?)\]$/;

export interface KeptVersion {
  /** Device id written in the marker, e.g. "dev_k8x9m2". */
  device: string;
  /** Marker time as stored, e.g. "2026-11-21 06:01 UTC". */
  when: string;
  text: string;
}

export function hasSyncConflict(note: string): boolean {
  return note.includes("[Sync conflict kept · ") && note.split("\n").some((line) => MARKER.test(line.trim()));
}

/** Split a stitched note into its main text and the kept versions, or null when it has none. */
export function splitSyncConflicts(note: string): { main: string; kept: KeptVersion[] } | null {
  if (!hasSyncConflict(note)) return null;
  const lines = note.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => { if (MARKER.test(line.trim())) starts.push(index); });
  const trimEnd = (part: string[], dropRule: boolean): string[] => {
    const out = [...part];
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (dropRule && out.length && out[out.length - 1].trim() === "---") out.pop();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  };
  const main = trimEnd(lines.slice(0, starts[0]), true).join("\n");
  const kept = starts.map((start, k) => {
    const marker = MARKER.exec(lines[start].trim())!;
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const body = trimEnd(lines.slice(start + 1, end), k + 1 < starts.length);
    while (body.length && !body[0].trim()) body.shift();
    return { device: marker[1], when: marker[2], text: body.join("\n") };
  });
  return { main, kept };
}

/** Who wrote a kept version. Without sync running the device is unknown, so stay neutral. */
export function conflictSourceLabel(device: string, currentDeviceId: string | null): string {
  if (!currentDeviceId) return "Saved version";
  return device === currentDeviceId ? "This computer" : "Other device";
}

/** "2026-11-21 06:01 UTC" → local "Nov 21, 14:01". Anything else is shown as stored. */
export function conflictLocalTime(when: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC$/.exec(when.trim());
  if (!m) return when;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  // Obsidian's moment follows the app language; fall back to the system locale.
  const moment = typeof window === "undefined" ? undefined : (window as any).moment;
  if (typeof moment === "function") return moment(date).format("MMM D, HH:mm");
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Show or remove the small "Sync conflict" line under a card header. */
export function syncConflictTag(card: HTMLElement, note: string): void {
  const head = card.querySelector<HTMLElement>(".lpa-margin-card-head");
  if (!head) return;
  const existing = card.querySelector<HTMLElement>(".lpa-sync-conflict-tag");
  if (!hasSyncConflict(note)) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const tag = head.ownerDocument.createElement("span");
  tag.className = "lpa-sync-conflict-tag";
  tag.textContent = "Sync conflict";
  tag.title = "Two versions of this note were kept. Edit the note to resolve.";
  head.after(tag);
}
