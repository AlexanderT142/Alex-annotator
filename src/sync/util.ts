import type { VV } from "./types";

/** Deterministic JSON: sorted keys, undefined dropped. Used for comparison and hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || typeof v === "function") continue;
      out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** Fast deterministic 64-bit string hash (cyrb53 pair) as 16 hex chars. Not cryptographic. */
export function hash64(input: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export function randomToken(length = 12): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Timestamp for an edit of a domain whose current timestamp is `current`. */
export function nextTs(now: number, current: number): number {
  return Math.max(now, (Number.isFinite(current) ? current : 0) + 1);
}

/** Last-writer-wins order: timestamp, then device id, then content. Positive => a wins. */
export function compareLww(aTs: number, aBy: string, aContent: string, bTs: number, bBy: string, bContent: string): number {
  if (aTs !== bTs) return aTs > bTs ? 1 : -1;
  if (aBy !== bBy) return aBy > bBy ? 1 : -1;
  if (aContent !== bContent) return aContent > bContent ? 1 : -1;
  return 0;
}

/** True when `a` has seen everything `b` has and strictly more. */
export function vvDominates(a: VV, b: VV): boolean {
  let greater = false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    if (va < vb) return false;
    if (va > vb) greater = true;
  }
  return greater;
}

export function vvMax(vvs: VV[]): VV {
  const out: VV = {};
  for (const vv of vvs) for (const [k, n] of Object.entries(vv)) out[k] = Math.max(out[k] ?? 0, n);
  return out;
}

/** Version vector for a new note edit that supersedes every given head. */
export function nextVV(heads: VV[], deviceId: string): VV {
  const out = vvMax(heads);
  out[deviceId] = (out[deviceId] ?? 0) + 1;
  return out;
}
