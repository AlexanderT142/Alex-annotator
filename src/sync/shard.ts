/** Device shard file format: Markdown wrapper + sentinel-delimited JSON. */
import type { ShardPayload, SyncHighlightRecord, SyncSetRecord, VV } from "./types";

export const SHARD_START = "<!-- pdf-annotator-sync:start -->";
export const SHARD_END = "<!-- pdf-annotator-sync:end -->";

export class IncompleteShardError extends Error {}

export function serializeShard(payload: ShardPayload): string {
  const live = payload.records.filter((r) => !r.deleted);
  const sorted = [...live].sort((a, b) => num(a.meta.page) - num(b.meta.page) || a.id.localeCompare(b.id));
  const lines = sorted.slice(0, 200).map((r) => {
    const quote = oneLine(typeof r.meta.text === "string" ? r.meta.text : "", 120);
    const note = oneLine(r.note, 120);
    return `- P.${num(r.meta.page) + 1}${quote ? ` “${quote}”` : ""}${note ? ` — ${note}` : ""}`;
  });
  if (live.length > sorted.slice(0, 200).length) lines.push(`- … ${live.length - 200} more`);
  return [
    "---",
    "pdf-annotator-sync: 1",
    `device: ${payload.deviceId}`,
    "---",
    "",
    "# PDF Annotator sync data",
    "",
    "Written automatically by the PDF Annotator plugin on one device. Do not edit; your changes would be ignored or overwritten.",
    "",
    ...lines,
    "",
    SHARD_START,
    "```json",
    // Escaping "<" keeps note text from ever forming a sentinel.
    JSON.stringify(payload).replace(/</g, "\\u003c"),
    "```",
    SHARD_END,
    "",
  ].join("\n");
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").replace(/</g, "‹").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * Parse a shard. Throws IncompleteShardError when the file is partial or
 * damaged, so callers retry instead of treating it as empty. Invalid
 * individual records are dropped; the rest of the shard is still used.
 */
export function parseShard(raw: string, docHash: string): ShardPayload {
  const start = raw.indexOf(SHARD_START);
  const end = raw.lastIndexOf(SHARD_END);
  if (start < 0 || end < 0 || end < start) throw new IncompleteShardError("Sync shard is incomplete.");
  const body = raw.slice(start + SHARD_START.length, end);
  const json = body.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let value: any;
  try {
    value = JSON.parse(json);
  } catch {
    throw new IncompleteShardError("Sync shard JSON could not be parsed.");
  }
  if (!value || typeof value !== "object" || value.schema !== 1 || value.kind !== "device-shard") {
    throw new IncompleteShardError("Unknown sync shard format.");
  }
  if (value.docHash !== docHash) throw new IncompleteShardError("Sync shard belongs to another PDF.");
  if (typeof value.deviceId !== "string" || !value.deviceId) throw new IncompleteShardError("Sync shard has no device.");
  return {
    schema: 1,
    kind: "device-shard",
    docHash,
    deviceId: value.deviceId,
    writeNonce: typeof value.writeNonce === "string" ? value.writeNonce : "",
    sets: Array.isArray(value.sets) ? value.sets.filter(validSet) : [],
    records: Array.isArray(value.records) ? value.records.filter(validRecord) : [],
  };
}

const SET_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validVV(v: unknown): v is VV {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((n) => finite(n) && n >= 0);
}

function validRect(r: any): boolean {
  return !!r && finite(r.x1) && finite(r.y1) && finite(r.x2) && finite(r.y2);
}

export function validRecord(r: any): r is SyncHighlightRecord {
  if (!r || typeof r !== "object") return false;
  if (typeof r.id !== "string" || !r.id || r.id.length > 100) return false;
  if (typeof r.setId !== "string" || !SET_ID.test(r.setId)) return false;
  if (typeof r.created !== "string") return false;
  if (typeof r.deleted !== "boolean" || !finite(r.statusTs) || typeof r.statusBy !== "string") return false;
  if (!finite(r.metaTs) || typeof r.metaBy !== "string") return false;
  if (typeof r.note !== "string" || typeof r.noteContentCJK !== "string") return false;
  if (!validVV(r.noteVV) || !finite(r.noteTs) || typeof r.noteBy !== "string") return false;
  const m = r.meta;
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  if (!Number.isInteger(m.page) || m.page < 0) return false;
  if (typeof m.color !== "string") return false;
  if (typeof m.text !== "string") return false;
  if (!Array.isArray(m.rects) || !m.rects.every(validRect)) return false;
  for (const key of ["tagX", "tagY", "tagWidth", "tagHeight"]) {
    if (m[key] !== undefined && !finite(m[key])) return false;
  }
  return true;
}

export function validSet(s: any): s is SyncSetRecord {
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.id === "string" &&
    SET_ID.test(s.id) &&
    typeof s.name === "string" &&
    (s.kind === "manual" || s.kind === "import" || s.kind === "ai") &&
    typeof s.accent === "string" &&
    typeof s.created === "string" &&
    typeof s.archived === "boolean" &&
    finite(s.ts) &&
    typeof s.by === "string"
  );
}
