/**
 * Pure conversions between the core's local data and sync records:
 * detecting local edits (local vs baseline) and planning what to apply
 * locally (merged vs local). No I/O.
 */
import type { Highlight } from "../annotations";
import type { AnnotationSetMeta } from "../annotation-sets";
import type {
  DeviceId,
  HighlightMeta,
  VV,
  MergedHighlight,
  MergedSet,
  MergedState,
  SyncHighlightRecord,
  SyncSetRecord,
} from "./types";
import { hash64, nextTs, nextVV, stableStringify } from "./util";

export const LEGACY: DeviceId = "legacy";

/** What the core holds right now, including archived sets. */
export interface LocalSnapshot {
  sets: AnnotationSetMeta[];
  highlights: Highlight[];
}

export interface BaselineHighlight {
  setId: string;
  created: string;
  meta: HighlightMeta;
  note: string;
  noteContentCJK: string;
}

export interface BaselineSet {
  name: string;
  kind: SyncSetRecord["kind"];
  accent: string;
  archived: boolean;
  created: string;
}

/** Sync clocks of the version the user was looking at. */
export interface HighlightClock {
  heads: VV[];
  metaTs: number;
  statusTs: number;
  noteTs: number;
}

/**
 * Local state as of the end of the last sync cycle; differences are local
 * edits. The clocks record which versions that state was built from, so a
 * local edit only supersedes what the user had actually seen, not versions
 * that arrived between the edit and its detection.
 */
export interface Baseline {
  version: 1;
  sets: Record<string, BaselineSet>;
  highlights: Record<string, BaselineHighlight>;
  clocks?: Record<string, HighlightClock>;
  setClocks?: Record<string, number>;
}

export interface OwnState {
  sets: Map<string, SyncSetRecord>;
  records: Map<string, SyncHighlightRecord>;
}

export interface SetChange extends BaselineSet {
  id: string;
}

export interface ApplyPlan {
  sets: SetChange[];
  upserts: Highlight[];
  removals: string[];
}

const NON_META = new Set(["id", "setId", "created", "note", "noteContentCJK"]);

export function metaOf(h: Highlight): HighlightMeta {
  const out: HighlightMeta = {};
  for (const [key, value] of Object.entries(h)) {
    if (NON_META.has(key) || value === undefined || typeof value === "function") continue;
    out[key] = JSON.parse(JSON.stringify(value));
  }
  return out;
}

export function baselineHighlightOf(h: Highlight): BaselineHighlight {
  return {
    setId: h.setId ?? "default",
    created: h.created ?? "",
    meta: metaOf(h),
    note: h.note ?? "",
    noteContentCJK: h.noteContentCJK ?? "",
  };
}

export function baselineSetOf(s: AnnotationSetMeta): BaselineSet {
  return { name: s.name, kind: s.kind, accent: s.accent, archived: !!s.archived, created: s.created };
}

export function baselineOf(local: LocalSnapshot, merged?: MergedState, prev?: Baseline | null, own?: OwnState): Baseline {
  const sets: Record<string, BaselineSet> = {};
  const setClocks: Record<string, number> = {};
  for (const s of local.sets) {
    const form = baselineSetOf(s);
    sets[s.id] = form;
    const m = merged?.sets.get(s.id);
    if (m && !m.synthetic && setKey(m) === setKey(form)) setClocks[s.id] = m.ts;
    else if (prev?.setClocks?.[s.id] !== undefined) setClocks[s.id] = prev.setClocks[s.id];
    else if (own?.sets.get(s.id)) setClocks[s.id] = own.sets.get(s.id)!.ts;
  }
  const highlights: Record<string, BaselineHighlight> = {};
  const clocks: Record<string, HighlightClock> = {};
  for (const h of local.highlights) {
    const form = baselineHighlightOf(h);
    highlights[h.id] = form;
    const m = merged?.highlights.get(h.id);
    const r = own?.records.get(h.id);
    if (m && !m.effectiveDeleted && stableStringify(displayedOf(m)) === stableStringify(form)) {
      clocks[h.id] = { heads: m.noteHeads, metaTs: m.metaTs, statusTs: m.statusTs, noteTs: m.primaryNote.noteTs };
    } else if (prev?.clocks?.[h.id]) {
      clocks[h.id] = prev.clocks[h.id];
    } else if (r) {
      clocks[h.id] = { heads: [r.noteVV], metaTs: r.metaTs, statusTs: r.statusTs, noteTs: r.noteTs };
    }
  }
  return { version: 1, sets, highlights, clocks, setClocks };
}

function metaKey(b: Pick<BaselineHighlight, "setId" | "meta">): string {
  return stableStringify([b.setId, b.meta]);
}

function noteKey(b: Pick<BaselineHighlight, "note" | "noteContentCJK">): string {
  return stableStringify([b.note, b.noteContentCJK]);
}

function setKey(s: BaselineSet): string {
  return stableStringify([s.name, s.kind, s.accent, s.archived]);
}

function createdTs(created: string): number {
  const t = Date.parse(created);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Deterministic record for data that predates sync on this device. Two
 * devices exporting the same old data produce identical records, so they
 * never conflict; different old text gets different vectors and is kept.
 */
export function legacyRecord(id: string, b: BaselineHighlight): SyncHighlightRecord {
  const ts = createdTs(b.created);
  const hasNote = b.note.length > 0 || b.noteContentCJK.length > 0;
  return {
    id,
    setId: b.setId,
    created: b.created,
    deleted: false,
    statusTs: ts,
    statusBy: LEGACY,
    meta: b.meta,
    metaTs: ts,
    metaBy: LEGACY,
    note: b.note,
    noteContentCJK: b.noteContentCJK,
    noteVV: hasNote ? { [`legacy_${hash64(`${id}|${b.note}|${b.noteContentCJK}`)}`]: 1 } : {},
    noteTs: ts,
    noteBy: LEGACY,
  };
}

export function legacySet(id: string, s: BaselineSet): SyncSetRecord {
  return { id, name: s.name, kind: s.kind, accent: s.accent, created: s.created, archived: s.archived, ts: createdTs(s.created), by: LEGACY };
}

export function recordFromMerged(m: MergedHighlight): SyncHighlightRecord {
  return {
    id: m.id,
    setId: m.setId,
    created: m.created,
    deleted: m.deleted,
    statusTs: m.statusTs,
    statusBy: m.statusBy,
    meta: m.meta,
    metaTs: m.metaTs,
    metaBy: m.metaBy,
    note: m.primaryNote.note,
    noteContentCJK: m.primaryNote.noteContentCJK,
    noteVV: { ...m.primaryNote.noteVV },
    noteTs: m.primaryNote.noteTs,
    noteBy: m.primaryNote.noteBy,
  };
}

/** The form the core would show for a merged annotation. */
export function displayedOf(m: MergedHighlight): BaselineHighlight {
  return { setId: m.setId, created: m.created, meta: m.meta, note: m.note, noteContentCJK: m.noteContentCJK };
}

function recordAsBaseline(r: SyncHighlightRecord): BaselineHighlight {
  return { setId: r.setId, created: r.created, meta: r.meta, note: r.note, noteContentCJK: r.noteContentCJK };
}

export interface DetectInput {
  local: LocalSnapshot;
  /** null on the first cycle for this PDF on this device. */
  baseline: Baseline | null;
  own: OwnState;
  merged: MergedState;
  deviceId: DeviceId;
  now: number;
}

/**
 * Turn local edits since the baseline into records in this device's own
 * shard. Returns a new OwnState and whether anything changed.
 */
export function detectLocalEdits(input: DetectInput): { own: OwnState; changed: boolean } {
  const { local, baseline, merged, deviceId: me, now } = input;
  const sets = new Map(input.own.sets);
  const records = new Map(input.own.records);
  let changed = false;
  const put = (r: SyncHighlightRecord) => {
    const prev = records.get(r.id);
    if (prev && stableStringify(prev) === stableStringify(r)) return;
    records.set(r.id, r);
    changed = true;
  };
  const putSet = (s: SyncSetRecord) => {
    const prev = sets.get(s.id);
    if (prev && stableStringify(prev) === stableStringify(s)) return;
    sets.set(s.id, s);
    changed = true;
  };

  // ---- sets ----
  for (const s of local.sets) {
    const cur = baselineSetOf(s);
    const m = merged.sets.get(s.id);
    const ownRec = sets.get(s.id);
    let base: BaselineSet | null;
    if (baseline) base = baseline.sets[s.id] ?? (m && !m.synthetic ? m : null);
    else base = ownRec ?? null;
    if (!baseline && !ownRec) {
      putSet(legacySet(s.id, cur));
      continue;
    }
    if (!base) {
      putSet({ id: s.id, ...cur, ts: nextTs(now, 0), by: me });
      continue;
    }
    if (setKey(base) === setKey(cur)) {
      if (!m && !ownRec) putSet(legacySet(s.id, cur)); // orphan: its record vanished
      continue;
    }
    const seen = baseline?.setClocks?.[s.id] ?? (m && !m.synthetic ? m.ts : 0);
    const prevTs = Math.max(seen, ownRec?.ts ?? 0);
    putSet({ id: s.id, ...cur, created: base.created || cur.created, ts: nextTs(now, prevTs), by: me });
  }

  // ---- highlights ----
  const localIds = new Set<string>();
  for (const h of local.highlights) {
    localIds.add(h.id);
    const cur = baselineHighlightOf(h);
    const m = merged.highlights.get(h.id);
    const ownRec = records.get(h.id);

    if (!baseline && !ownRec) {
      put(legacyRecord(h.id, cur));
      continue;
    }
    let base: BaselineHighlight | null;
    if (baseline) base = baseline.highlights[h.id] ?? (m && !m.effectiveDeleted ? displayedOf(m) : null);
    else base = ownRec ? recordAsBaseline(ownRec) : null;

    if (!base) {
      if (m) {
        // Present locally, deleted in the merged view (e.g. restored from a
        // snapshot): bring it back, carrying this device's content.
        const rec = { ...(ownRec ?? recordFromMerged(m)) };
        rec.deleted = false;
        rec.statusTs = nextTs(now, Math.max(m.statusTs, rec.statusTs));
        rec.statusBy = me;
        if (metaKey(recordAsBaseline(rec)) !== metaKey(cur)) applyMetaEdit(rec, cur, m.metaTs, me, now);
        if (noteKey(recordAsBaseline(rec)) !== noteKey(cur)) applyNoteEdit(rec, cur, [...m.noteHeads, rec.noteVV], m.primaryNote.noteTs, me, now);
        put(rec);
        continue;
      }
      const ts = nextTs(now, 0);
      const hasNote = cur.note.length > 0 || cur.noteContentCJK.length > 0;
      put({
        id: h.id,
        setId: cur.setId,
        created: cur.created,
        deleted: false,
        statusTs: ts,
        statusBy: me,
        meta: cur.meta,
        metaTs: ts,
        metaBy: me,
        note: cur.note,
        noteContentCJK: cur.noteContentCJK,
        noteVV: hasNote ? { [me]: 1 } : {},
        noteTs: ts,
        noteBy: me,
      });
      continue;
    }

    const metaChanged = metaKey(base) !== metaKey(cur);
    const noteChanged = noteKey(base) !== noteKey(cur);
    if (!metaChanged && !noteChanged) {
      if (!m && !ownRec) put(legacyRecord(h.id, cur)); // orphan: its record vanished
      continue;
    }
    const rec: SyncHighlightRecord = ownRec ? { ...ownRec, noteVV: { ...ownRec.noteVV } } : m ? recordFromMerged(m) : legacyRecord(h.id, base);
    // Supersede only what the user was looking at (the baseline's versions).
    const clk = baseline?.clocks?.[h.id];
    const heads = clk ? clk.heads : m ? m.noteHeads : [];
    if (metaChanged) applyMetaEdit(rec, cur, Math.max(clk?.metaTs ?? m?.metaTs ?? 0, ownRec?.metaTs ?? 0), me, now);
    if (noteChanged) {
      applyNoteEdit(rec, cur, ownRec ? [...heads, ownRec.noteVV] : heads, Math.max(clk?.noteTs ?? m?.primaryNote.noteTs ?? 0, ownRec?.noteTs ?? 0), me, now);
    }
    put(rec);
  }

  // ---- deletions ----
  if (baseline) {
    for (const [id, base] of Object.entries(baseline.highlights)) {
      if (localIds.has(id)) continue;
      const m = merged.highlights.get(id);
      if (m?.effectiveDeleted) continue;
      const ownRec = records.get(id);
      if (!m && ownRec?.deleted) continue;
      const rec: SyncHighlightRecord = ownRec ? { ...ownRec } : m ? recordFromMerged(m) : legacyRecord(id, base);
      rec.deleted = true;
      // The deletion must also outrank the current note, or it would not take effect.
      const clk = baseline.clocks?.[id];
      const seen = clk ? Math.max(clk.statusTs, clk.noteTs) : m ? Math.max(m.statusTs, m.primaryNote.noteTs) : 0;
      const floor = Math.max(seen, ownRec ? Math.max(ownRec.statusTs, ownRec.noteTs) : 0);
      rec.statusTs = nextTs(now, floor);
      rec.statusBy = me;
      put(rec);
    }
  }

  return { own: { sets, records }, changed };
}

function applyMetaEdit(rec: SyncHighlightRecord, cur: BaselineHighlight, floorTs: number, me: DeviceId, now: number): void {
  rec.setId = cur.setId;
  rec.meta = cur.meta;
  rec.metaTs = nextTs(now, floorTs);
  rec.metaBy = me;
}

function applyNoteEdit(rec: SyncHighlightRecord, cur: BaselineHighlight, heads: VV[], floorTs: number, me: DeviceId, now: number): void {
  rec.note = cur.note;
  rec.noteContentCJK = cur.noteContentCJK;
  rec.noteVV = nextVV(heads, me);
  rec.noteTs = nextTs(now, floorTs);
  rec.noteBy = me;
}

export function toLocalHighlight(m: MergedHighlight): Highlight {
  const h: Record<string, unknown> = { ...JSON.parse(JSON.stringify(m.meta)) };
  h.id = m.id;
  h.setId = m.setId;
  h.created = m.created;
  if (m.note) h.note = m.note;
  if (m.noteContentCJK) h.noteContentCJK = m.noteContentCJK;
  return h as unknown as Highlight;
}

/** What must change locally so the core shows the merged state. */
export function planApply(merged: MergedState, local: LocalSnapshot): ApplyPlan {
  const localSets = new Map(local.sets.map((s) => [s.id, s]));
  const localHighlights = new Map(local.highlights.map((h) => [h.id, h]));
  const plan: ApplyPlan = { sets: [], upserts: [], removals: [] };

  for (const s of merged.sets.values()) {
    const l = localSets.get(s.id);
    if (l && s.synthetic) continue; // never overwrite a real local name with a placeholder
    const target = mergedSetForm(s);
    if (!l || setKey(baselineSetOf(l)) !== setKey(target)) plan.sets.push({ id: s.id, ...target });
  }
  for (const m of merged.highlights.values()) {
    const l = localHighlights.get(m.id);
    if (m.effectiveDeleted) {
      if (l) plan.removals.push(m.id);
      continue;
    }
    const target = displayedOf(m);
    if (!l || stableStringify(baselineHighlightOf(l)) !== stableStringify(target)) plan.upserts.push(toLocalHighlight(m));
  }
  return plan;
}

function mergedSetForm(s: MergedSet): BaselineSet {
  return { name: s.name, kind: s.kind, accent: s.accent, archived: s.archived, created: s.created };
}

export function isEmptyPlan(plan: ApplyPlan): boolean {
  return plan.sets.length === 0 && plan.upserts.length === 0 && plan.removals.length === 0;
}
