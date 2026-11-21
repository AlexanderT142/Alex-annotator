/**
 * Pure merge of every device shard for one PDF. No I/O, no clock: the same
 * shards in any order (with duplicates) always produce the same state.
 */
import type {
  MergedHighlight,
  MergedSet,
  MergedState,
  NoteVersion,
  ShardPayload,
  SyncHighlightRecord,
  SyncSetRecord,
} from "./types";
import { compareLww, stableStringify, vvDominates } from "./util";

export function mergeShards(shards: ShardPayload[]): MergedState {
  const byId = new Map<string, SyncHighlightRecord[]>();
  const setsById = new Map<string, SyncSetRecord[]>();
  for (const shard of shards) {
    for (const rec of shard.records) {
      const list = byId.get(rec.id);
      if (list) list.push(rec);
      else byId.set(rec.id, [rec]);
    }
    for (const set of shard.sets) {
      const list = setsById.get(set.id);
      if (list) list.push(set);
      else setsById.set(set.id, [set]);
    }
  }

  const highlights = new Map<string, MergedHighlight>();
  for (const id of [...byId.keys()].sort()) highlights.set(id, mergeHighlight(byId.get(id)!));

  const sets = new Map<string, MergedSet>();
  for (const id of [...setsById.keys()].sort()) sets.set(id, { ...pickNewestSet(setsById.get(id)!) });

  // Annotations can arrive before their set's metadata. Keep them reachable.
  for (const h of highlights.values()) {
    if (h.effectiveDeleted || sets.has(h.setId)) continue;
    sets.set(h.setId, {
      id: h.setId,
      name: `Synced set (${h.setId.slice(0, 6)})`,
      kind: "manual",
      accent: "#888888",
      created: h.created,
      archived: false,
      ts: 0,
      by: "",
      synthetic: true,
    });
  }
  return { sets, highlights };
}

function setContent(s: SyncSetRecord): string {
  return stableStringify([s.name, s.kind, s.accent, s.archived, s.created]);
}

function pickNewestSet(list: SyncSetRecord[]): SyncSetRecord {
  return list.reduce((a, b) => (compareLww(a.ts, a.by, setContent(a), b.ts, b.by, setContent(b)) >= 0 ? a : b));
}

function metaContent(r: SyncHighlightRecord): string {
  return stableStringify([r.setId, r.created, r.meta]);
}

function statusContent(r: SyncHighlightRecord): string {
  return r.deleted ? "1" : "0";
}

function noteContent(v: NoteVersion): string {
  return stableStringify([v.note, v.noteContentCJK]);
}

function noteOf(r: SyncHighlightRecord): NoteVersion {
  return { note: r.note, noteContentCJK: r.noteContentCJK, noteVV: r.noteVV, noteTs: r.noteTs, noteBy: r.noteBy };
}

function compareNotes(a: NoteVersion, b: NoteVersion): number {
  return compareLww(a.noteTs, a.noteBy, noteContent(a) + stableStringify(a.noteVV), b.noteTs, b.noteBy, noteContent(b) + stableStringify(b.noteVV));
}

function mergeHighlight(versions: SyncHighlightRecord[]): MergedHighlight {
  const winMeta = versions.reduce((a, b) =>
    compareLww(a.metaTs, a.metaBy, metaContent(a), b.metaTs, b.metaBy, metaContent(b)) >= 0 ? a : b
  );
  const winStatus = versions.reduce((a, b) =>
    compareLww(a.statusTs, a.statusBy, statusContent(a), b.statusTs, b.statusBy, statusContent(b)) >= 0 ? a : b
  );

  // Heads: note versions not causally superseded by any other version.
  const notes = versions.map(noteOf);
  const heads = notes.filter((v) => !notes.some((o) => vvDominates(o.noteVV, v.noteVV)));
  // Same vector + same text is one version seen by several devices.
  const unique = new Map<string, NoteVersion>();
  for (const v of heads) {
    const key = stableStringify(v.noteVV) + "\u0000" + noteContent(v);
    const prev = unique.get(key);
    if (!prev || compareNotes(v, prev) > 0) unique.set(key, v);
  }
  const ordered = [...unique.values()].sort((a, b) => -compareNotes(a, b));
  // Collapse identical text reached independently; it is not a conflict.
  const distinct: NoteVersion[] = [];
  const seen = new Set<string>();
  for (const v of ordered) {
    const key = noteContent(v);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(v);
  }
  const primary = distinct[0];
  const hasNoteConflict = distinct.length > 1;

  return {
    id: winMeta.id,
    setId: winMeta.setId,
    created: winMeta.created,
    meta: winMeta.meta,
    metaTs: winMeta.metaTs,
    metaBy: winMeta.metaBy,
    deleted: winStatus.deleted,
    statusTs: winStatus.statusTs,
    statusBy: winStatus.statusBy,
    // A note written after the deletion keeps the annotation alive.
    effectiveDeleted: winStatus.deleted && winStatus.statusTs >= primary.noteTs,
    note: hasNoteConflict ? stitch(distinct.map((v) => ({ text: v.note, by: v.noteBy, ts: v.noteTs }))) : primary.note,
    noteContentCJK: hasNoteConflict
      ? stitch(distinct.map((v) => ({ text: v.noteContentCJK, by: v.noteBy, ts: v.noteTs })))
      : primary.noteContentCJK,
    primaryNote: primary,
    noteHeads: ordered.map((v) => v.noteVV),
    hasNoteConflict,
  };
}

/** Newest text first, every other concurrent version appended. Deterministic. */
export function stitch(entries: Array<{ text: string; by: string; ts: number }>): string {
  const nonEmpty = entries.filter((e) => e.text.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  const seen = new Set<string>();
  const unique = nonEmpty.filter((e) => (seen.has(e.text) ? false : (seen.add(e.text), true)));
  if (unique.length === 1) return unique[0].text;
  const [first, ...rest] = unique;
  const blocks = [first.text];
  for (const e of rest) {
    const when = Number.isFinite(e.ts) && e.ts > 0 ? new Date(e.ts).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown time";
    blocks.push(`\n---\n[Sync conflict kept · ${e.by || "unknown device"} · ${when}]\n${e.text}`);
  }
  return blocks.join("\n");
}
