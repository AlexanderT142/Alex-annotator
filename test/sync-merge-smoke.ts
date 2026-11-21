import assert from "node:assert/strict";
import { mergeShards, stitch } from "../src/sync/merge";
import { parseShard, serializeShard, IncompleteShardError } from "../src/sync/shard";
import { legacyRecord } from "../src/sync/records";
import type { ShardPayload, SyncHighlightRecord, SyncSetRecord } from "../src/sync/types";
import { compareLww, nextTs, nextVV, stableStringify, vvDominates } from "../src/sync/util";

const HASH = "b".repeat(64);

function rec(id: string, patch: Partial<SyncHighlightRecord> = {}): SyncHighlightRecord {
  return {
    id,
    setId: "default",
    created: "2026-01-01T00:00:00.000Z",
    deleted: false,
    statusTs: 1,
    statusBy: "d1",
    meta: { page: 0, color: "red", text: "q", rects: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] },
    metaTs: 1,
    metaBy: "d1",
    note: "",
    noteContentCJK: "",
    noteVV: {},
    noteTs: 1,
    noteBy: "d1",
    ...patch,
  };
}

function shard(deviceId: string, records: SyncHighlightRecord[], sets: SyncSetRecord[] = []): ShardPayload {
  return { schema: 1, kind: "device-shard", docHash: HASH, deviceId, writeNonce: "n", sets, records };
}

function mergedJson(shards: ShardPayload[]): string {
  const m = mergeShards(shards);
  return stableStringify({ sets: [...m.sets.entries()], highlights: [...m.highlights.entries()] });
}

// ---- utilities ----
assert.equal(nextTs(100, 50), 100);
assert.equal(nextTs(100, 1_900_000_000_000), 1_900_000_000_001, "edits of a future-stamped record still win");
assert.ok(compareLww(2, "a", "", 1, "z", "") > 0);
assert.ok(compareLww(1, "b", "", 1, "a", "") > 0, "same ms: device id breaks the tie");
assert.ok(vvDominates({ a: 2, b: 1 }, { b: 1 }));
assert.ok(!vvDominates({ a: 1 }, { b: 1 }) && !vvDominates({ b: 1 }, { a: 1 }));
assert.ok(!vvDominates({ a: 1 }, { a: 1 }));
assert.deepEqual(nextVV([{ a: 1, b: 2 }, { a: 3 }], "c"), { a: 3, b: 2, c: 1 });

// ---- LWW on meta ----
{
  const a = rec("h", { meta: { ...rec("h").meta, color: "blue" }, metaTs: 5, metaBy: "dA" });
  const b = rec("h", { meta: { ...rec("h").meta, color: "green" }, metaTs: 7, metaBy: "dB" });
  assert.equal(mergeShards([shard("dA", [a]), shard("dB", [b])]).highlights.get("h")!.meta.color, "green");
}

// ---- version vectors: Gemini's overwritten-intermediate case ----
{
  // B writes revB; A edits on top (A:1,B:1) then again (A:2,B:1), overwriting its shard.
  const b = rec("h", { note: "B text", noteVV: { dB: 1 }, noteTs: 10, noteBy: "dB" });
  const a = rec("h", { note: "A text 2", noteVV: { dA: 2, dB: 1 }, noteTs: 30, noteBy: "dA" });
  const m = mergeShards([shard("dB", [b]), shard("dA", [a])]).highlights.get("h")!;
  assert.equal(m.hasNoteConflict, false);
  assert.equal(m.note, "A text 2");
}

// ---- version vectors: my case (B copies rev1 on a colour change) ----
{
  const bCopy = rec("h", { note: "rev1", noteVV: { dA: 1 }, noteTs: 10, noteBy: "dA", metaTs: 20, metaBy: "dB" });
  const a = rec("h", { note: "rev2", noteVV: { dA: 2 }, noteTs: 30, noteBy: "dA" });
  const m = mergeShards([shard("dB", [bCopy]), shard("dA", [a])]).highlights.get("h")!;
  assert.equal(m.hasNoteConflict, false);
  assert.equal(m.note, "rev2");
}

// ---- true concurrency is stitched, never dropped ----
{
  const a = rec("h", { note: "from A", noteVV: { dA: 1 }, noteTs: 10, noteBy: "dA" });
  const b = rec("h", { note: "from B", noteVV: { dB: 1 }, noteTs: 20, noteBy: "dB" });
  const m = mergeShards([shard("dA", [a]), shard("dB", [b])]).highlights.get("h")!;
  assert.equal(m.hasNoteConflict, true);
  assert.ok(m.note.startsWith("from B"), "newest version first");
  assert.ok(m.note.includes("from A") && m.note.includes("Sync conflict kept"));
  assert.equal(m.noteHeads.length, 2);
  // Same vector, different text (cloned device id) is also a conflict.
  const c1 = rec("x", { note: "clone 1", noteVV: { dA: 2 }, noteTs: 10, noteBy: "dA" });
  const c2 = rec("x", { note: "clone 2", noteVV: { dA: 2 }, noteTs: 11, noteBy: "dA" });
  assert.equal(mergeShards([shard("a", [c1]), shard("b", [c2])]).highlights.get("x")!.hasNoteConflict, true);
  // Identical text reached independently is not a conflict.
  const s1 = rec("y", { note: "same", noteVV: { dA: 1 }, noteTs: 10, noteBy: "dA" });
  const s2 = rec("y", { note: "same", noteVV: { dB: 1 }, noteTs: 11, noteBy: "dB" });
  assert.equal(mergeShards([shard("a", [s1]), shard("b", [s2])]).highlights.get("y")!.hasNoteConflict, false);
  assert.equal(stitch([{ text: "a", by: "x", ts: 0 }, { text: "", by: "y", ts: 0 }]), "a");
}

// ---- deletion vs later note ----
{
  const del = rec("h", { deleted: true, statusTs: 100, statusBy: "dA" });
  const noteLater = rec("h", { note: "kept", noteVV: { dB: 1 }, noteTs: 150, noteBy: "dB" });
  assert.equal(mergeShards([shard("a", [del]), shard("b", [noteLater])]).highlights.get("h")!.effectiveDeleted, false);
  const delLater = rec("h", { deleted: true, statusTs: 200, statusBy: "dA" });
  assert.equal(mergeShards([shard("a", [delLater]), shard("b", [noteLater])]).highlights.get("h")!.effectiveDeleted, true);
}

// ---- order independence and idempotence ----
{
  const shards = [
    shard("dA", [rec("1", { metaTs: 5 }), rec("2", { note: "x", noteVV: { dA: 1 } })], [{ id: "s", name: "S", kind: "manual", accent: "#000", created: "", archived: false, ts: 3, by: "dA" }]),
    shard("dB", [rec("1", { metaTs: 5, metaBy: "dB", meta: { ...rec("1").meta, color: "c" } }), rec("2", { note: "y", noteVV: { dB: 1 } })], [{ id: "s", name: "T", kind: "manual", accent: "#000", created: "", archived: false, ts: 3, by: "dB" }]),
    shard("dC", [rec("3", { setId: "orphan" })]),
  ];
  const ref = mergedJson(shards);
  assert.equal(mergedJson([shards[2], shards[0], shards[1]]), ref);
  assert.equal(mergedJson([shards[1], shards[1], shards[2], shards[0], shards[0]]), ref);
  const m = mergeShards(shards);
  assert.equal(m.sets.get("s")!.name, "T");
  assert.equal(m.sets.get("orphan")!.synthetic, true, "annotations whose set has not arrived stay reachable");
}

// ---- legacy export is deterministic ----
{
  const b = { setId: "default", created: "2026-01-01T00:00:00.000Z", meta: { page: 1 }, note: "n", noteContentCJK: "" };
  assert.deepEqual(legacyRecord("h", b), legacyRecord("h", { ...b }));
  assert.notDeepEqual(legacyRecord("h", b).noteVV, legacyRecord("h", { ...b, note: "other" }).noteVV);
  assert.deepEqual(legacyRecord("h", { ...b, note: "" }).noteVV, {});
}

// ---- shard format ----
{
  const payload = shard("dA", [rec("1", { note: "tricky <!-- pdf-annotator-sync:end --> ``` text" })]);
  const raw = serializeShard(payload);
  const back = parseShard(raw, HASH);
  assert.equal(back.records[0].note, payload.records[0].note, "note text cannot break the sentinels");
  // Linter-style edits around the data block are harmless.
  const linted = raw.replace("---\npdf-annotator-sync: 1", "---\ntags: [x]\nmodified: today\npdf-annotator-sync: 1").replace(/\n/g, "\r\n");
  assert.equal(parseShard(linted, HASH).records.length, 1);
  assert.throws(() => parseShard(raw.slice(0, raw.length / 2), HASH), IncompleteShardError, "partial file");
  assert.throws(() => parseShard("", HASH), IncompleteShardError, "empty file");
  assert.throws(() => parseShard(raw.replace('"schema":1', '"schema":1,,'), HASH), IncompleteShardError, "damaged JSON");
  assert.throws(() => parseShard(raw, "c".repeat(64)), IncompleteShardError, "other PDF");
  // Invalid records are dropped individually.
  const bad = {
    ...payload,
    records: [
      rec("ok"),
      { ...rec("badPage"), meta: { ...rec("x").meta, page: -1 } } as any,
      { ...rec("badRects"), meta: { ...rec("x").meta, rects: [{ x1: "a" }] } } as any,
      { ...rec("badVV"), noteVV: { a: "1" } } as any,
    ],
  };
  assert.deepEqual(parseShard(serializeShard(bad), HASH).records.map((r) => r.id), ["ok"]);
}

console.log("sync merge smoke: LWW, clocks, version vectors, stitching, deletion, order independence, legacy export and shard format passed");
