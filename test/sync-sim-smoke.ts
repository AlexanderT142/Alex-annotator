/**
 * Randomized three-device simulation. Devices make random edits while a fake
 * sync tool delivers shard files late, out of order, repeatedly, partially,
 * and sometimes as stale copies. After everything is delivered all devices
 * must converge, keep the last note written on every live annotation, and
 * stop writing.
 */
import assert from "node:assert/strict";
import { mergeShards } from "../src/sync/merge";
import { parseShard } from "../src/sync/shard";
import { stableStringify } from "../src/sync/util";
import { HASH, SHARD_DIR, makeDevice, mark, settle, stateOf, type Device } from "./sync-helpers";

const NO_GUARD = { deletionGuard: { maxCount: Infinity, maxRatio: 2, minCount: Infinity } };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(seed: number): Promise<void> {
  const rand = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const devices: Device[] = [await makeDevice("a", NO_GUARD), await makeDevice("b", NO_GUARD), await makeDevice("c", NO_GUARD)];
  if (seed % 4 === 0) devices[2].clock.now = Date.parse("2030-06-01T00:00:00Z"); // one badly wrong clock
  /** History of every version of every shard file, for stale replays. */
  const history = new Map<string, string[]>();
  /** Last note text written to each annotation, in real time. */
  const lastNote = new Map<string, string>();
  let n = 0;

  const snapshotFiles = () => {
    for (const d of devices) for (const path of d.fs.shardFiles()) {
      if (!path.endsWith(`/${d.identity.get()}.md`)) continue;
      const list = history.get(path) ?? [];
      const content = d.fs.text.get(path)!;
      if (list[list.length - 1] !== content) list.push(content);
      history.set(path, list);
    }
  };

  for (let step = 0; step < 160; step++) {
    const d = pick(devices);
    d.clock.now += Math.floor(rand() * 5000) + 1;
    const snap = d.ws.syncSnapshot();
    const live = snap.highlights;
    const activeSets = snap.sets.filter((s) => !s.archived);
    const op = rand();
    if (op < 0.25 || live.length === 0) {
      const id = `${d.name}${n++}`;
      const set = pick(activeSets);
      const note = rand() < 0.5 ? `note ${id} by ${d.name}` : undefined;
      d.ws.addToSet(set.id, [mark(id, { note })]);
      if (note) lastNote.set(id, note);
    } else if (op < 0.45) {
      const h = pick(live);
      const note = `edit ${n++} by ${d.name}`;
      d.ws.update(h.id, { note });
      lastNote.set(h.id, note);
    } else if (op < 0.6) {
      d.ws.update(pick(live).id, { color: `#${Math.floor(rand() * 0xffffff).toString(16)}` });
    } else if (op < 0.68) {
      d.ws.update(pick(live).id, { tagX: Math.round(rand() * 100), isPinned: rand() < 0.5 });
    } else if (op < 0.76) {
      const h = pick(live);
      d.ws.remove(h.id);
    } else if (op < 0.8) {
      await d.ws.createSet(`Set ${n++}`);
    } else if (op < 0.84) {
      const s = pick(activeSets);
      await d.ws.renameSet(s.id, `Renamed ${n++}`);
    } else if (op < 0.86) {
      const candidates = activeSets.filter((s) => s.id !== "default");
      if (candidates.length) await d.ws.archiveSet(pick(candidates).id);
    }

    if (rand() < 0.6) await d.engine.sync();
    snapshotFiles();

    // The fake sync tool.
    const deliveries = Math.floor(rand() * 3);
    for (let i = 0; i < deliveries; i++) {
      const from = pick(devices);
      const to = pick(devices.filter((x) => x !== from));
      const files = from.fs.shardFiles().filter((p) => !p.endsWith(`/${to.identity.get()}.md`));
      if (!files.length) continue;
      const path = pick(files);
      const kind = rand();
      let content = from.fs.text.get(path)!;
      if (kind < 0.1) content = content.slice(0, Math.floor(content.length * rand())); // partial write
      else if (kind < 0.2) content = pick(history.get(path) ?? [content]); // stale replay
      to.fs.text.set(path, content);
      if (rand() < 0.5) await to.engine.sync();
    }
  }

  // Quiescence: the sync tool finally delivers everything, then devices settle.
  await settle(devices, 8);

  const states = devices.map(stateOf);
  assert.equal(states[1], states[0], `seed ${seed}: device b differs from a`);
  assert.equal(states[2], states[0], `seed ${seed}: device c differs from a`);

  // No silent loss: the last note written to a live annotation is still there.
  const final = devices[0].ws.syncSnapshot().highlights;
  for (const h of final) {
    const last = lastNote.get(h.id);
    if (last) assert.ok((h.note ?? "").includes(last), `seed ${seed}: lost note ${JSON.stringify(last)} on ${h.id}: ${JSON.stringify(h.note)}`);
  }

  // Read purity: once settled, nobody writes.
  const before = devices.map((d) => d.fs.shardWrites());
  for (const d of devices) await d.engine.sync();
  assert.deepEqual(devices.map((d) => d.fs.shardWrites()), before, `seed ${seed}: settled devices kept writing`);

  // Merge is order independent and duplicate tolerant on the real shards.
  const shards = devices[0].fs.shardFiles().map((p) => parseShard(devices[0].fs.text.get(p)!, HASH));
  const json = (xs: typeof shards) => {
    const m = mergeShards(xs);
    return stableStringify({ s: [...m.sets.entries()], h: [...m.highlights.entries()] });
  };
  const ref = json(shards);
  const shuffled = [...shards, ...shards.slice(0, 1)].sort(() => rand() - 0.5);
  assert.equal(json(shuffled), ref, `seed ${seed}: merge depends on order`);
  void SHARD_DIR;
}

async function main(): Promise<void> {
  console.warn = () => {}; // damaged-file cases log expected warnings
  const seeds = Number(process.env.LPA_SYNC_SEEDS ?? 40);
  for (let seed = 1; seed <= seeds; seed++) await run(seed);
  console.log(`sync simulation smoke: ${seeds} randomized three-device runs converged with no lost notes and no write loops`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
