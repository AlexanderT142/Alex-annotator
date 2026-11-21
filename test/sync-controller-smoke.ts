import assert from "node:assert/strict";
import { Notice } from "./obsidian-stub";
import { SyncController } from "../src/sync/controller";
import { HASH, Mem, mark, openWorkspace } from "./sync-helpers";

// Minimal browser/Obsidian globals: manual timers, no DOM.
const timers = new Map<number, () => void>();
let nextTimer = 1;
(globalThis as any).window = {
  setTimeout: (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; },
  clearTimeout: (id: number) => { timers.delete(id); },
  localStorage: { getItem: () => null, setItem: () => {} },
};

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

async function runTimers(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const due = [...timers.entries()];
    timers.clear();
    for (const [, fn] of due) fn();
    await tick();
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  console.warn = () => {};
  const fs = new Mem();
  const store = new Map<string, unknown>();
  const app: any = {
    vault: { adapter: fs, on: () => ({}), offref: () => {}, getName: () => "test" },
    loadLocalStorage: (k: string) => store.get(k) ?? null,
    saveLocalStorage: (k: string, v: unknown) => store.set(k, v),
  };
  const ws = await openWorkspace(fs);
  ws.add(mark("h1", { note: "mine" }));
  const controller = new SyncController(app, "_pdf-annotator-sync");
  controller.start();
  controller.attach(ws, HASH);
  await runTimers();
  assert.deepEqual(await controller.syncNow(HASH), { ok: true });

  // An error pauses this PDF; "Sync now" says why instead of claiming success.
  fs.failPaths = (p) => p.startsWith("_pdf-annotator-sync/");
  ws.update("h1", { color: "#changed" });
  await runTimers();
  assert.deepEqual(await controller.syncNow(HASH), { ok: false, paused: "error" });
  assert.ok(Notice.messages.some((m) => m.includes("sync failed for this PDF")));

  // Recovery works even while sync is in the error state.
  assert.equal(await controller.restorePreSync(HASH), true);
  assert.equal(ws.get("h1")!.color, "#FBF719", "pre-sync state restored");
  assert.deepEqual(await controller.syncNow(HASH), { ok: false, paused: "error" }, "error stays visible");

  // Resume clears the error pause without restarting Obsidian.
  fs.failPaths = undefined;
  assert.equal(await controller.resume(HASH), true);
  assert.deepEqual(await controller.syncNow(HASH), { ok: true });

  // The failure counter was reset: a new error pauses only this PDF again.
  fs.failPaths = (p) => p.startsWith("_pdf-annotator-sync/");
  ws.update("h1", { color: "#again" });
  await runTimers();
  assert.deepEqual(await controller.syncNow(HASH), { ok: false, paused: "error" });
  fs.failPaths = undefined;
  assert.equal(await controller.resume(HASH), true);

  controller.stop();
  console.log("sync controller smoke: paused reasons, recovery while errored, and resume clearing error pauses passed");
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
