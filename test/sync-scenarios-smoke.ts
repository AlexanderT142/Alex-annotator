import assert from "node:assert/strict";
import { parseShard, serializeShard } from "../src/sync/shard";
import { SyncBreaker, SyncGovernor } from "../src/sync/breaker";
import { hideFolderCss, withExcludedFolder } from "../src/sync/vault-hiding";
import { renderGuard } from "../src/render-guard";
import { notifyWorkspaceClosed, notifyWorkspaceOpened, setWorkspaceSyncHook } from "../src/sync/hooks";
import {
  HASH,
  LOCAL_ROOT,
  SHARD_DIR,
  Mem,
  deliver,
  deliverAll,
  has,
  makeDevice,
  mark,
  noteOf,
  openWorkspace,
  settle,
  stateOf,
  type Device,
} from "./sync-helpers";

const NO_GUARD = { deletionGuard: { maxCount: Infinity, maxRatio: 2, minCount: Infinity } };

async function main(): Promise<void> {
  console.warn = () => {}; // damaged-file cases log expected warnings

async function pair(extra = NO_GUARD): Promise<[Device, Device]> {
  return [await makeDevice("a", extra), await makeDevice("b", extra)];
}

// ---- basic two-way sync ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1", { note: "hello" }));
  await settle([a, b]);
  assert.equal(noteOf(b, "h1"), "hello", "B receives A's annotation");
  b.ws.update("h1", { color: "#00ff00" });
  b.clock.now += 1000;
  await settle([a, b]);
  assert.equal(a.ws.get("h1")!.color, "#00ff00", "A receives B's colour change");
  a.clock.now += 1000;
  a.ws.remove("h1");
  await settle([a, b]);
  assert.ok(!has(b, "h1"), "deletion propagates");
  assert.equal(stateOf(a), stateOf(b));
}

// ---- read purity: receiving devices never write shards ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1", { note: "x" }));
  await settle([a, b]);
  const before = b.fs.shardWrites();
  await b.engine.sync();
  await b.engine.sync();
  assert.equal(b.fs.shardWrites(), before, "idle cycles write nothing");
  a.clock.now += 10;
  a.ws.update("h1", { note: "y" });
  await a.engine.sync();
  deliver(a, b);
  const r = await b.engine.sync();
  assert.ok(r?.applied, "B applied A's change");
  assert.equal(b.fs.shardWrites(), before, "applying a remote change does not write back");
}

// ---- C1: both devices export identical old data ----
{
  const fsA = new Mem();
  const old = await openWorkspace(fsA);
  old.add(mark("h1", { note: "old note" }));
  old.add(mark("h2"));
  await old.flush();
  await old.release();
  const fsB = new Mem();
  for (const [k, v] of fsA.text) fsB.text.set(k, v); // the same old bundle on both machines
  for (const f of fsA.folders) fsB.folders.add(f);
  const a = await makeDevice("a", NO_GUARD, fsA);
  const b = await makeDevice("b", NO_GUARD, fsB);
  await settle([a, b]);
  assert.equal(noteOf(a, "h1"), "old note", "no conflict from identical exports");
  assert.equal(a.ws.syncSnapshot().highlights.length, 2, "no duplicates");
  assert.equal(stateOf(a), stateOf(b));
}

// ---- C2 + C3: late upgrade of a stale copy ----
{
  const fsA = new Mem();
  const old = await openWorkspace(fsA);
  old.add(mark("h1", { note: "v1" }));
  old.add(mark("h2"));
  old.add(mark("h3"));
  old.add(mark("h4", { note: "shared" }));
  await old.flush();
  await old.release();
  const fsB = new Mem();
  for (const [k, v] of fsA.text) fsB.text.set(k, v);
  for (const f of fsA.folders) fsB.folders.add(f);
  const a = await makeDevice("a", NO_GUARD, fsA);
  const b = await makeDevice("b", NO_GUARD, fsB);
  // B diverged before upgrading (offline edit of h4 on the old version).
  b.ws.update("h4", { note: "B offline edit" });
  await a.engine.sync();
  a.clock.now += 5000;
  a.ws.update("h1", { note: "v2 by A" });
  a.ws.remove("h2");
  a.ws.update("h3", { color: "#123456" });
  await a.engine.sync();
  // Five days later B upgrades.
  b.clock.now = a.clock.now + 5 * 86_400_000;
  deliver(a, b);
  await settle([a, b]);
  assert.equal(noteOf(b, "h1"), "v2 by A", "A's edit is not rolled back");
  assert.ok(!has(b, "h2"), "A's deletion does not come back");
  assert.equal(b.ws.get("h3")!.color, "#123456", "A's colour stays");
  const h4 = noteOf(b, "h4")!;
  assert.ok(h4.includes("shared") && h4.includes("B offline edit"), "diverged old notes are both kept");
  assert.equal(stateOf(a), stateOf(b));
}

// ---- E3: three-way concurrent notes, resolved in stages ----
{
  const [a, b] = await pair();
  const c = await makeDevice("c", NO_GUARD);
  a.ws.add(mark("h", { note: "base" }));
  await settle([a, b, c]);
  a.ws.update("h", { note: "A" });
  b.ws.update("h", { note: "B" });
  c.ws.update("h", { note: "C" });
  for (const d of [a, b, c]) { d.clock.now += 100; await d.engine.sync(); }
  deliver(b, a);
  await a.engine.sync();
  assert.ok(noteOf(a, "h")!.includes("A") && noteOf(a, "h")!.includes("B"));
  a.clock.now += 100;
  a.ws.update("h", { note: "A+B resolved" });
  await a.engine.sync();
  deliverAll([a, b, c]);
  await settle([a, b, c]);
  const final = noteOf(a, "h")!;
  assert.ok(final.includes("A+B resolved") && final.includes("C"), "late third version is still kept");
  assert.ok(!final.includes("\nB\n") && !final.startsWith("B"), "resolved versions are not resurrected");
  assert.equal(stateOf(a), stateOf(c));
}

// ---- E1: a device with a 2030 clock ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1"));
  a.ws.add(mark("h2"));
  await settle([a, b]);
  b.clock.now = Date.parse("2030-01-01T00:00:00Z");
  b.ws.update("h1", { color: "#2030" });
  await settle([a, b]);
  assert.equal(a.ws.get("h1")!.color, "#2030");
  a.clock.now += 1000;
  a.ws.update("h1", { color: "#fixed" });
  a.ws.update("h2", { color: "#normal" });
  await settle([a, b]);
  assert.equal(b.ws.get("h1")!.color, "#fixed", "a future-stamped record can still be edited");
  assert.equal(b.ws.get("h2")!.color, "#normal");
  const shard = parseShard(a.fs.text.get(`${SHARD_DIR}/dev_a.md`)!, HASH);
  assert.ok(shard.records.find((r) => r.id === "h2")!.metaTs < Date.parse("2029-01-01T00:00:00Z"), "other records are not contaminated");
}

// ---- E2: clock moved backwards ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1"));
  await settle([a, b]);
  a.ws.update("h1", { color: "#first" });
  await a.engine.sync();
  a.clock.now -= 2 * 3_600_000;
  a.ws.update("h1", { color: "#second" });
  await settle([a, b]);
  assert.equal(b.ws.get("h1")!.color, "#second", "the later edit wins even after the clock went back");
}

// ---- E4: delete vs offline note edit ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h"));
  a.ws.add(mark("k"));
  await settle([a, b]);
  a.clock.now += 100;
  a.ws.remove("h");
  await a.engine.sync();
  b.clock.now += 150;
  b.ws.update("h", { note: "written after the delete" });
  await b.engine.sync();
  await settle([a, b]);
  assert.equal(noteOf(a, "h"), "written after the delete", "a newer note keeps the annotation");
  b.clock.now += 1000;
  b.ws.update("k", { note: "before delete" });
  await b.engine.sync();
  a.clock.now = b.clock.now + 1000;
  a.ws.remove("k");
  await a.engine.sync();
  await settle([a, b]);
  assert.ok(!has(b, "k"), "a later deletion wins");
}

// ---- D3: annotations arrive before their set ----
{
  const [a, b] = await pair();
  const set = await a.ws.createSet("Translation");
  a.ws.addToSet(set.id, [mark("t1", { note: "译文" })]);
  await a.engine.sync();
  // Deliver a hand-made shard carrying only the record, not the set.
  const payload = parseShard(a.fs.text.get(`${SHARD_DIR}/dev_a.md`)!, HASH);
  await b.fs.write(`${SHARD_DIR}/dev_a.md`, serializeShard({ ...payload, sets: payload.sets.filter((s) => s.id !== set.id) }));
  await b.engine.sync();
  assert.equal(noteOf(b, "t1"), "译文", "annotation is reachable before its set metadata");
  assert.match(b.ws.syncSnapshot().sets.find((s) => s.id === set.id)!.name, /Synced set/);
  await settle([a, b]);
  assert.equal(b.ws.syncSnapshot().sets.find((s) => s.id === set.id)!.name, "Translation", "real name replaces the placeholder");
  assert.notEqual(b.ws.activeSet().id, set.id, "remote sets never change where this device writes");
}

// ---- archive syncs; view state does not ----
{
  const [a, b] = await pair();
  const s = await a.ws.createSet("Extra");
  await settle([a, b]);
  await b.ws.setVisible(s.id, false);
  await settle([a, b]);
  assert.ok(a.ws.isVisible(s.id), "visibility is per device");
  a.clock.now += 100;
  await a.ws.archiveSet(s.id);
  await settle([a, b]);
  assert.ok(b.ws.syncSnapshot().sets.find((x) => x.id === s.id)!.archived, "archive propagates");
}

// ---- A2 / A5: damaged, partial and empty files ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1", { note: "safe" }));
  await settle([a, b]);
  const good = a.fs.text.get(`${SHARD_DIR}/dev_a.md`)!;
  for (const bad of ["", good.slice(0, good.length / 2), good.replace('"schema":1', '"schema":1,,')]) {
    b.fs.text.set(`${SHARD_DIR}/dev_a.md`, bad);
    await b.engine.sync();
    assert.equal(noteOf(b, "h1"), "safe", "a broken file never empties the data");
    assert.equal(b.fs.text.get(`${SHARD_DIR}/dev_a.md`), bad, "another device's file is never rewritten");
  }
  b.fs.text.set(`${SHARD_DIR}/dev_a.md`, good);
  await b.engine.sync();
  assert.equal(stateOf(a), stateOf(b));
}

// ---- A4: a sync tool's conflict copy is merged read-only ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1", { note: "one" }));
  await a.engine.sync();
  const first = a.fs.text.get(`${SHARD_DIR}/dev_a.md`)!;
  a.clock.now += 10;
  a.ws.add(mark("h2", { note: "two" }));
  await a.engine.sync();
  // Simulate a stale write that a sync tool kept as a conflict copy of an older version.
  b.fs.text.set(`${SHARD_DIR}/dev_a (conflicted copy).md`, first);
  deliver(a, b);
  await b.engine.sync();
  assert.ok(has(b, "h1") && has(b, "h2"));
  assert.ok(b.fs.text.has(`${SHARD_DIR}/dev_a (conflicted copy).md`));
}

// ---- E6: an old version of a shard is replayed ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1", { note: "v1" }));
  await settle([a, b]);
  const stale = a.fs.text.get(`${SHARD_DIR}/dev_a.md`)!;
  a.clock.now += 100;
  a.ws.update("h1", { note: "v2" });
  await settle([a, b]);
  b.fs.text.set(`${SHARD_DIR}/dev_a.md`, stale);
  await b.engine.sync();
  b.clock.now += 100;
  b.ws.update("h1", { color: "#edit-during-stale" });
  await b.engine.sync();
  deliverAll([a, b]);
  await settle([a, b]);
  assert.ok(noteOf(a, "h1")!.includes("v2"), "the newer note survives a replay");
  assert.equal(stateOf(a), stateOf(b));
}

// ---- B1/B2: device id copied to another machine ----
{
  const a = await makeDevice("a", NO_GUARD);
  a.ws.add(mark("h1", { note: "shared" }));
  a.ws.add(mark("h2"));
  await a.engine.sync();
  await a.ws.flush();
  // Clone: same files, same identity (nonces too).
  const fsClone = new Mem();
  for (const [k, v] of a.fs.text) fsClone.text.set(k, v);
  for (const f of a.fs.folders) fsClone.folders.add(f);
  const clone = await makeDevice("a", NO_GUARD, fsClone);
  for (const [k, v] of a.identity.nonces) clone.identity.nonces.set(k, v);
  a.clock.now += 100;
  a.ws.update("h1", { note: "A edit" });
  await a.engine.sync();
  clone.clock.now += 200;
  clone.ws.update("h2", { color: "#clone" });
  // The clone receives A's newer file under the shared id before it syncs.
  clone.fs.text.set(`${SHARD_DIR}/dev_a.md`, a.fs.text.get(`${SHARD_DIR}/dev_a.md`)!);
  await clone.engine.sync();
  assert.notEqual(clone.identity.get(), "dev_a", "clone detected and given a new id");
  assert.ok(clone.notices.some((n) => n.includes("sync id")));
  deliver(clone, a);
  await settle([a, clone]);
  assert.equal(noteOf(a, "h1"), "A edit");
  assert.equal(a.ws.get("h2")!.color, "#clone", "both machines' edits survive");
  assert.equal(stateOf(a), stateOf(clone));
}

// ---- S2: large remote deletions need confirmation ----
{
  const a = await makeDevice("a");
  const b = await makeDevice("b");
  for (let i = 0; i < 10; i++) a.ws.add(mark(`m${i}`));
  await settle([a, b]);
  a.clock.now += 100;
  for (let i = 0; i < 8; i++) a.ws.remove(`m${i}`);
  await a.engine.sync();
  deliver(a, b);
  const writesBefore = b.fs.shardWrites();
  await b.engine.sync();
  assert.equal(b.ws.syncSnapshot().highlights.length, 10, "held back");
  assert.equal(b.engine.pendingDeletionCount, 8);
  assert.equal(b.notices.length, 1);
  await b.engine.sync();
  assert.equal(b.notices.length, 1, "not repeated every cycle");
  assert.equal(b.fs.shardWrites(), writesBefore, "holding back is not treated as a local edit");
  await b.engine.confirmPendingDeletions();
  assert.equal(b.ws.syncSnapshot().highlights.length, 2);
  // A single deletion goes through without asking.
  a.clock.now += 100;
  a.ws.remove("m8");
  await a.engine.sync();
  deliver(a, b);
  await b.engine.sync();
  assert.ok(!has(b, "m8"));
}

// ---- S3: undo the last applied sync ----
{
  const [a, b] = await pair();
  b.ws.add(mark("mine", { note: "my note" }));
  await settle([a, b]);
  a.clock.now += 100;
  a.ws.update("mine", { note: "overwritten remotely" });
  a.ws.add(mark("theirs"));
  await a.engine.sync();
  deliver(a, b);
  await b.engine.sync();
  assert.equal(noteOf(b, "mine"), "overwritten remotely");
  assert.ok(await b.engine.restoreLastSnapshot());
  assert.equal(noteOf(b, "mine"), "my note", "local data restored");
  assert.ok(!has(b, "theirs"));
  assert.ok(b.engine.isPaused);
  assert.equal(await b.engine.sync(), null, "paused after restore");
  // Resuming publishes the restored state as this device's edit.
  b.clock.now = a.clock.now + 1000;
  await b.engine.resume();
  await settle([a, b]);
  assert.equal(noteOf(a, "mine"), "my note");
  assert.equal(stateOf(a), stateOf(b));
}

// ---- E5: remote changes wait while the user is typing ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h", { note: "x" }));
  await settle([a, b]);
  a.clock.now += 100;
  a.ws.update("h", { note: "remote" });
  await a.engine.sync();
  deliver(a, b);
  b.editing = true;
  const r = await b.engine.sync();
  assert.equal(r?.deferred, true);
  assert.equal(noteOf(b, "h"), "x", "nothing changes under the cursor");
  b.editing = false;
  await b.engine.sync();
  assert.equal(noteOf(b, "h"), "remote");
}

// ---- S1: failures stay inside the add-on ----
{
  const fs = new Mem();
  const a = await makeDevice("a", NO_GUARD, fs);
  a.ws.add(mark("h"));
  fs.failWrites = true;
  await assert.rejects(a.engine.sync());
  fs.failWrites = false;
  a.ws.update("h", { note: "core still works" });
  await a.ws.flush();
  assert.equal(noteOf(a, "h"), "core still works");
  const breaker = new SyncBreaker(3);
  assert.equal(breaker.fail("doc1"), "doc");
  assert.ok(breaker.isBlocked("doc1") && !breaker.isBlocked("doc2"));
  assert.equal(breaker.fail("doc2"), "doc");
  assert.equal(breaker.fail("doc3"), "all");
  assert.ok(breaker.isBlocked("anything"));
}

// ---- crash window: core save fails right after applying remote changes ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1", { note: "keep me" }));
  await settle([a, b]);
  a.clock.now += 100;
  a.ws.add(mark("h2", { note: "new" }));
  await a.engine.sync();
  deliver(a, b);
  b.fs.failPaths = (p) => p.includes("/annotation-sets/");
  await assert.rejects(b.engine.sync(), "the cycle fails when the core cannot save");
  // "Restart" b from what is actually on its disk.
  const disk = new Mem();
  for (const [k, v] of b.fs.text) disk.text.set(k, v);
  for (const f of b.fs.folders) disk.folders.add(f);
  const b2 = await makeDevice("b", NO_GUARD, disk);
  for (const [k, v] of b.identity.nonces) b2.identity.nonces.set(k, v);
  b2.clock.now = a.clock.now + 1000;
  await settle([a, b2]);
  assert.ok(has(a, "h1") && has(a, "h2"), "nothing is mistaken for a local deletion");
  assert.ok(has(b2, "h2"));
  assert.equal(stateOf(a), stateOf(b2));
}

// ---- closing publishes local edits but applies nothing ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h1"));
  await settle([a, b]);
  a.clock.now += 100;
  a.ws.update("h1", { color: "#remote" });
  await a.engine.sync();
  deliver(a, b);
  b.clock.now = a.clock.now + 100;
  b.ws.add(mark("closing-edit"));
  const r = await b.engine.sync({ applyRemote: false });
  assert.equal(r?.applied, null);
  assert.notEqual(b.ws.get("h1")!.color, "#remote", "nothing applied while closing");
  deliver(b, a);
  await a.engine.sync();
  assert.ok(has(a, "closing-edit"), "the last local edit was still published");
}

// ---- pre-sync backup: taken once, covers every set, restores, never rotated ----
{
  const fs = new Mem();
  const old = await openWorkspace(fs);
  old.add(mark("mine", { note: "before sync" }));
  const extra = await old.createSet("Archived one");
  old.addToSet(extra.id, [mark("in-archived")]);
  await old.archiveSet(extra.id);
  await old.flush();
  await old.release();
  const a = await makeDevice("a", NO_GUARD, fs);
  const b = await makeDevice("b", NO_GUARD);
  await a.engine.sync();
  const backupPath = `${LOCAL_ROOT}/dev_a/${HASH}/pre-sync-backup.json`;
  const backup = JSON.parse(fs.text.get(backupPath)!);
  assert.equal(backup.sets.length, 2, "all sets, archived included");
  assert.ok(backup.highlights.some((h: any) => h.id === "in-archived"));
  b.ws.add(mark("from-b"));
  await settle([a, b]);
  a.clock.now += 100;
  a.ws.update("mine", { note: "changed later" });
  await settle([a, b]);
  assert.equal(fs.text.get(backupPath), JSON.stringify(backup), "backup is never rewritten");
  assert.ok(await a.engine.restorePreSyncBackup());
  assert.equal(noteOf(a, "mine"), "before sync");
  assert.ok(!has(a, "from-b"), "back to exactly the pre-sync state");
  assert.ok(a.engine.isPaused);
  // Still found after the device id changes.
  a.identity.id = "dev_other";
  assert.ok(await a.engine.restorePreSyncBackup());
}

// ---- snapshots: rolling cap of 15, only before remote changes ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h"));
  await settle([a, b]);
  const snapDir = `${LOCAL_ROOT}/dev_b/${HASH}/snapshots/`;
  const count = () => [...b.fs.text.keys()].filter((k) => k.startsWith(snapDir)).length;
  const before = count();
  for (let i = 0; i < 5; i++) { b.clock.now += 10; b.ws.update("h", { note: `local ${i}` }); await b.engine.sync(); }
  assert.equal(count(), before, "local edits never take snapshots");
  for (let i = 0; i < 20; i++) {
    a.clock.now += 1000;
    a.ws.update("h", { color: `#${i}` });
    await a.engine.sync();
    deliver(a, b);
    b.clock.now = a.clock.now + 1;
    await b.engine.sync();
  }
  assert.equal(count(), 15);
}

// ---- validate before apply; roll back if a change fails part-way ----
{
  const fs = new Mem();
  const ws = await openWorkspace(fs);
  ws.add(mark("x", { note: "untouched" }));
  const before = JSON.stringify(ws.syncSnapshot());
  await assert.rejects(ws.applySyncedChanges({ sets: [], upserts: [{ ...mark("y"), setId: "nope" }], removals: ["x"] }));
  assert.equal(JSON.stringify(ws.syncSnapshot()), before, "an invalid plan changes nothing, not even its valid parts");
  await assert.rejects(ws.applySyncedChanges({ sets: [], upserts: [{ ...mark("y"), setId: "default" }, { ...mark("y"), setId: "default" }], removals: [] }));
  assert.equal(JSON.stringify(ws.syncSnapshot()), before, "duplicate ids are rejected");

  const [a, b] = await pair();
  a.ws.add(mark("h1", { note: "keep" }));
  await settle([a, b]);
  a.clock.now += 100;
  a.ws.update("h1", { note: "remote" });
  a.ws.add(mark("h2"));
  await a.engine.sync();
  deliver(a, b);
  const real = b.ws.applySyncedChanges.bind(b.ws);
  let calls = 0;
  (b.ws as any).applySyncedChanges = (plan: any) => {
    calls++;
    if (calls === 1) {
      const p = real(plan); // the change lands in memory…
      return p.then(() => { throw new Error("failed part-way"); }); // …then fails
    }
    return real(plan);
  };
  const stateBefore = JSON.stringify(b.ws.syncSnapshot().highlights.map((h) => [h.id, h.note]));
  await assert.rejects(b.engine.sync());
  assert.equal(JSON.stringify(b.ws.syncSnapshot().highlights.map((h) => [h.id, h.note])), stateBefore, "rolled back");
  (b.ws as any).applySyncedChanges = real;
}

// ---- sync's own changes are flagged synchronously (loop detection input) ----
{
  const [a, b] = await pair();
  a.ws.add(mark("h"));
  await settle([a, b]);
  const seen: boolean[] = [];
  b.ws.onChange(() => seen.push(b.engine.isApplying));
  a.clock.now += 100;
  a.ws.update("h", { note: "remote" });
  await a.engine.sync();
  deliver(a, b);
  await b.engine.sync();
  assert.ok(seen.length > 0 && seen.every((x) => x === true), "every change event from a remote apply is flagged");
  seen.length = 0;
  b.ws.update("h", { color: "#user" });
  await b.ws.flush();
  await b.engine.sync();
  assert.deepEqual(seen, [false], "user edits are not flagged");
}

// ---- governor: loops and slowness pause; normal editing never does ----
{
  const g = new SyncGovernor({ slowMs: 300, firstBackoffMs: 2000, maxBackoffMs: 8000, loopLimit: 3, loopWindowMs: 60_000 });
  for (let i = 0; i < 50; i++) assert.equal(g.record({ workMs: 5, wroteShard: true, externalChange: true, now: i }), "ok", "user/AI writes never count");
  assert.equal(g.record({ workMs: 5, wroteShard: true, externalChange: false, now: 1 }), "ok");
  assert.equal(g.record({ workMs: 5, wroteShard: true, externalChange: false, now: 2 }), "ok");
  assert.equal(g.record({ workMs: 5, wroteShard: true, externalChange: false, now: 3 }), "ok");
  assert.equal(g.record({ workMs: 5, wroteShard: true, externalChange: false, now: 4 }), "pause-loop");
  g.reset();
  assert.equal(g.record({ workMs: 5, wroteShard: true, externalChange: false, now: 200_000 }), "ok", "old loop writes expire");
  g.reset();
  assert.equal(g.record({ workMs: 400, wroteShard: false, externalChange: true, now: 0 }), "ok");
  assert.equal(g.extraDelayMs, 2000);
  g.record({ workMs: 400, wroteShard: false, externalChange: true, now: 0 });
  g.record({ workMs: 400, wroteShard: false, externalChange: true, now: 0 });
  assert.equal(g.extraDelayMs, 8000, "backs off to the cap");
  assert.equal(g.record({ workMs: 400, wroteShard: false, externalChange: true, now: 0 }), "pause-slow", "still slow at the cap: pause");
  g.reset();
  g.record({ workMs: 400, wroteShard: false, externalChange: true, now: 0 });
  g.record({ workMs: 10, wroteShard: false, externalChange: true, now: 0 });
  assert.equal(g.extraDelayMs, 0, "recovers when fast again");
}

// ---- sync folder hiding, excluded-files list, renderer guard, forward compatibility ----
{
  assert.match(hideFolderCss("_pdf-annotator-sync"), /data-path="_pdf-annotator-sync"/);
  const once = withExcludedFolder(["Templates/"], "_pdf-annotator-sync");
  assert.deepEqual(once, { filters: ["Templates/", "_pdf-annotator-sync/"], changed: true });
  assert.equal(withExcludedFolder(once.filters, "_pdf-annotator-sync").changed, false, "idempotent");
  assert.equal(withExcludedFolder(["_pdf-annotator-sync"], "_pdf-annotator-sync/").changed, false);
  assert.deepEqual(withExcludedFolder(undefined, "x").filters, ["x/"]);
  const drawn: string[] = [];
  const origWarn = console.warn;
  console.warn = () => {};
  for (const id of ["a", "bad", "c"]) renderGuard(id, () => { if (id === "bad") throw new Error("x"); drawn.push(id); });
  console.warn = origWarn;
  assert.deepEqual(drawn, ["a", "c"], "one broken annotation does not stop the others");
  // A newer plugin's annotation type passes through sync untouched.
  const [a, b] = await pair();
  a.ws.add(mark("future", { type: "ink" as any, inkPath: [1, 2, 3] } as any));
  await settle([a, b]);
  assert.equal((b.ws.get("future") as any)?.inkPath?.length, 3);
}

// ---- S4: with sync off the hooks do nothing ----
{
  setWorkspaceSyncHook(null);
  const fs = new Mem();
  const ws = await openWorkspace(fs);
  notifyWorkspaceOpened(ws, HASH);
  notifyWorkspaceClosed(ws, HASH);
  ws.add(mark("h"));
  await ws.flush();
  assert.ok(![...fs.text.keys()].some((p) => p.startsWith("_pdf-annotator-sync") || p.startsWith(LOCAL_ROOT)), "no sync files when off");
  // A throwing hook can never break opening a PDF.
  setWorkspaceSyncHook({ attach() { throw new Error("boom"); }, detach() { throw new Error("boom"); } });
  const origError = console.error;
  console.error = () => {};
  try {
    notifyWorkspaceOpened(ws, HASH);
    notifyWorkspaceClosed(ws, HASH);
  } finally {
    console.error = origError;
    setWorkspaceSyncHook(null);
  }
}

console.log("sync scenarios smoke: two-way sync, read purity, legacy export (C1-C3), clocks (E1-E2), delete vs note (E4), sets (D3), damaged/partial/conflict/replayed files (A2, A4, A5, E6), cloned id (B1-B2), deletion guard, undo, typing deferral, failure isolation, pre-sync backup, 15-snapshot cap, validate/rollback, apply flag, governor, folder hiding, render guard, forward compatibility and sync-off passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
