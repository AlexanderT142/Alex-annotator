import assert from "node:assert/strict";
import { AnnotationSetWorkspace } from "../src/annotation-sets";
import { AnnotationStore, parseAnnotations, type Highlight } from "../src/annotations";
import { AiJobService, type AiAnnotationJobState } from "../src/ai-jobs";
import { AiCredentialStore, connectionForJob, connectionIdentity } from "../src/ai-credentials";
import { AI_PROVIDER_PRESETS, DEFAULT_AI_SETTINGS, requestAiAnnotations, safeProviderError } from "../src/ai-provider";
import { anchorQuoteOnPage, type DocIndex } from "../src/anchor";
import { MemoryAdapter } from "./memory-adapter";

const mark = (id: string): Highlight => ({ id, page: 0, text: "Original quote", note: "Original note", rects: [{ x1: 1, y1: 1, x2: 30, y2: 10 }], color: "#FBF719", created: new Date().toISOString() });
const options = (adapter: MemoryAdapter) => ({ adapter: adapter as any, setsRootPath: "sets", indexPath: "sets/index.json", legacyAnnotationPath: "legacy.md", pdfBasename: "Book", pdfVaultPath: "Book.pdf" });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

async function checkSets(): Promise<void> {
  const adapter = new MemoryAdapter();
  const [a, b] = await Promise.all([AnnotationSetWorkspace.open(options(adapter)), AnnotationSetWorkspace.open(options(adapter))]);
  assert.equal(a, b, "two simultaneous tabs must share one workspace");
  const extra = await a.createSet("Translation", "ai");
  a.add(mark("first"));
  await b.setVisible("default", false);
  assert.equal(b.listSets().length, 2, "a visibility change must preserve a set created in another tab");
  await a.release();
  b.add(mark("second"));
  await b.release();
  const reopened = await AnnotationSetWorkspace.open(options(adapter));
  assert.notEqual(reopened, a, "closed workspaces reload from disk");
  assert.equal(reopened.highlightsForSet(extra.id).length, 2);
  await reopened.release();

  // Both the registry and its backup are damaged: recover all sidecar files.
  await adapter.write("sets/index.json", "{truncated");
  await adapter.write("sets/index.previous.json", "{also truncated");
  const recovered = await AnnotationSetWorkspace.open(options(adapter));
  assert.equal(recovered.listSets().length, 2);
  assert.equal(recovered.highlightsForSet(extra.id).length, 2);
  assert.equal(recovered.setMeta(extra.id)?.name, "Translation");
  assert.ok(recovered.recoveryMessages.length);
  assert.equal([...adapter.text.keys()].filter(p => p.includes(".damaged-")).length, 2);
  await recovered.setVisible("default", false);
  await recovered.setVisible(extra.id, false);
  await recovered.release();
  const hidden = await AnnotationSetWorkspace.open(options(adapter));
  assert.equal(hidden.doc.highlights.length, 0, "all-hidden visibility must survive reload");
  await hidden.release();

  const primary = JSON.parse(await adapter.read("sets/index.json"));
  await adapter.write("sets/index.previous.json", JSON.stringify({ ...primary, sets: primary.sets.filter((s: any) => s.id === "default"), activeSetId: "default", visibleSetIds: ["default"] }));
  await adapter.write("sets/index.json", "{truncated again");
  const backup = await AnnotationSetWorkspace.open(options(adapter));
  assert.equal(backup.listSets().length, 2, "registry backup must recover newer orphan sidecars too");
  await backup.release();
}

async function checkSaveDuringWrite(): Promise<void> {
  const adapter = new MemoryAdapter();
  const store = new AnnotationStore(adapter as any, "notes.md", "Book", "Book.pdf");
  store.add(mark("edit"));
  const entered = deferred(); const gate = deferred(); let first = true;
  adapter.beforeWrite = async path => { if (path === "notes.md" && first) { first = false; entered.resolve(); await gate.promise; } };
  const pending = store.flush();
  await entered.promise;
  store.update("edit", { note: "Typed while the write was in flight" });
  const secondFlush = store.flush();
  gate.resolve();
  await Promise.all([pending, secondFlush]);
  assert.equal(parseAnnotations(await adapter.read("notes.md"))!.highlights[0].note, "Typed while the write was in flight");
}

function checkAnchors(): void {
  const text = "A long genuine beginning that is present in the book. The central argument is about work. A long genuine ending that is present in the book.";
  const index: DocIndex = { pages: [{ page: 0, items: [{ str: text, x: 0, y: 20, w: 500, h: 12 }] }], search: "", map: [] };
  assert.equal(anchorQuoteOnPage(index, 0, text).length, 1);
  const invented = text.slice(0, 52) + "A FABRICATED MIDDLE CLAIM" + text.slice(-51);
  assert.equal(anchorQuoteOnPage(index, 0, invented).length, 0, "invented middle text must never anchor");
  assert.equal(anchorQuoteOnPage(index, 1, text).length, 0, "quotes never move to another page");
  assert.equal(anchorQuoteOnPage(index, 0, text.toLowerCase()).length, 0, "word case is preserved");
  const repeated = "First: repeated passage. Second: repeated passage.";
  index.pages[0].items[0].str = repeated;
  assert.equal(anchorQuoteOnPage(index, 0, "repeated passage").length, 0, "ambiguous duplicate quotes are rejected");
  assert.equal(anchorQuoteOnPage(index, 0, "repeated passage", "Second:").length, 1);
}

function checkCredentials(): void {
  const entries = new Map<string, string>();
  const storage = { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => { entries.set(k, v); }, removeItem: (k: string) => { entries.delete(k); } };
  const store = new AiCredentialStore(storage);
  const original = { ...DEFAULT_AI_SETTINGS, apiKey: "local-unit-test-sentinel" };
  const other = { ...original, provider: "glm" as const, baseUrl: "https://open.bigmodel.cn/api/paas/v4" };
  store.write(original, original.apiKey);
  assert.equal(store.read(other), "", "provider switching cannot reuse another provider's key");
  assert.throws(() => connectionForJob(other, original), /original/);
  assert.throws(() => connectionForJob({ ...original, baseUrl: "https://different.example/v1" }, original), /original/);
  const snapshot = connectionForJob(original, original);
  original.apiKey = "changed-in-settings";
  assert.equal(snapshot.apiKey, "local-unit-test-sentinel", "running job retains its credential snapshot");
  assert.throws(() => connectionIdentity({ ...original, baseUrl: "http://remote.example/v1" }), /HTTPS/);
  assert.doesNotThrow(() => connectionIdentity({ ...original, baseUrl: "http://localhost:8000/v1" }));
  entries.set("local-pdf-annotator.ai-api-key", "legacy-sentinel");
  assert.equal(store.migrate(other, ""), "legacy-sentinel");
  assert.equal(entries.has("local-pdf-annotator.ai-api-key"), false);
  const broken = new AiCredentialStore({ ...storage, setItem: () => { throw new Error("Storage unavailable"); } });
  entries.set("local-pdf-annotator.ai-api-key", "keep-this-copy");
  assert.throws(() => broken.migrate({ ...other, baseUrl: "https://another.example/v1" }, ""));
  assert.equal(entries.get("local-pdf-annotator.ai-api-key"), "keep-this-copy");
  assert.equal(safeProviderError(new Error("Echoed local-unit-test-sentinel"), "local-unit-test-sentinel").message, "Echoed [redacted]");
}

async function checkJobRecovery(): Promise<void> {
  const adapter = new MemoryAdapter();
  await adapter.mkdir("jobs");
  const job: AiAnnotationJobState = { version: 1, id: "interrupted", jobsRootPath: "jobs", setId: "default", setName: "Translation", fromPage: 1, toPage: 10, nextPage: 3, prompt: "Translate", provider: "openai", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "chosen-model", status: "requesting", completedPages: 2, createdAnnotations: 2, rejectedAnnotations: 0, message: "Working", created: "2026-09-07T00:00:00Z", updated: "2026-09-07T00:00:00Z" };
  await adapter.write("jobs/interrupted.json", JSON.stringify(job));
  const service = new AiJobService(); const context = { adapter: adapter as any, jobsRootPath: "jobs" };
  const recovered = await service.list(context);
  assert.equal(recovered[0].status, "paused");
  assert.equal(recovered[0].nextPage, 3);
  await service.cancel(job.id, context);
  assert.equal((await service.list(context))[0].status, "cancelled", "restored and paused jobs can be cancelled");
  await adapter.write("jobs/interrupted.previous.json", JSON.stringify(job));
  await adapter.write("jobs/interrupted.json", "{broken");
  assert.equal((await new AiJobService().list(context))[0].status, "paused", "damaged checkpoint recovers from backup");
  assert.ok([...adapter.text.keys()].some(p => p.includes(".damaged-")));
  const workspace = await AnnotationSetWorkspace.open(options(adapter));
  const wrongConnection = { ...DEFAULT_AI_SETTINGS, provider: "glm" as const, baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "unit-only" };
  await assert.rejects(service.resume({ ...context, workspace, pdfDoc: { numPages: 10 }, getConnection: () => wrongConnection }, job.id), /original/);
  assert.equal((await service.list(context))[0].status, "paused", "wrong-provider resume must not mutate checkpoint or make requests");
  await workspace.release();
}

/** Inspect outgoing requests, then abort locally. No provider response or
 * annotation output is simulated by these contract checks. */
async function checkRequestContracts(): Promise<void> {
  const realFetch = globalThis.fetch;
  try {
    for (const preset of AI_PROVIDER_PRESETS.filter(p => p.id !== "custom")) {
      let called = false;
      globalThis.fetch = (async (url: any, init: any) => {
        called = true;
        const body = JSON.parse(init.body);
        assert.equal("temperature" in body, false);
        assert.equal("temperature" in (body.generationConfig ?? {}), false);
        assert.equal(body.model ?? preset.defaultModel, preset.defaultModel);
        assert.ok(String(url).startsWith(preset.baseUrl + "/"));
        assert.equal(String(url).includes("unit-test-key"), false);
        if (preset.protocol === "anthropic-messages") assert.equal(init.headers["x-api-key"], "unit-test-key");
        else if (preset.protocol === "gemini-generate-content") assert.equal(init.headers["x-goog-api-key"], "unit-test-key");
        else assert.equal(init.headers.Authorization, "Bearer unit-test-key");
        throw new Error("Request inspected and aborted locally");
      }) as typeof fetch;
      await assert.rejects(requestAiAnnotations({ ...preset, provider: preset.id, model: preset.defaultModel, apiKey: "unit-test-key" }, "Explain", [{ pageNumber: 1, text: "Source text." }]), /aborted locally/);
      assert.ok(called, `${preset.id} request must reach the transport boundary`);
    }
  } finally { globalThis.fetch = realFetch; }
}

async function checkRunningJobControls(): Promise<void> {
  const adapter = new MemoryAdapter();
  const workspace = await AnnotationSetWorkspace.open(options(adapter));
  const service = new AiJobService();
  const entered = deferred(); const gate = deferred();
  const connection = { ...DEFAULT_AI_SETTINGS, apiKey: "unit-test-key" };
  const context = { adapter: adapter as any, jobsRootPath: "jobs", workspace, getConnection: () => connection, pdfDoc: { numPages: 1, getPage: async () => { entered.resolve(); await gate.promise; return { getTextContent: async () => ({ items: [] }) }; } } };
  const started = await service.start(context, { setId: "default", setName: "Test", fromPage: 1, toPage: 1, prompt: "Explain" });
  await entered.promise;
  assert.equal((await service.list(context))[0].status, "indexing", "opening the job dialog must not reset a live job");
  await assert.rejects(service.resume(context, started.id), /already running/);
  const stopped = new Promise<AiAnnotationJobState>(resolve => {
    const unsub = service.subscribe(state => { if (state.status === "cancelled") { unsub(); resolve(state); } });
  });
  await service.cancel(started.id, context);
  assert.equal((await stopped).status, "cancelled");
  gate.resolve();
  assert.equal(JSON.parse(await adapter.read(`jobs/${started.id}.json`)).status, "cancelled", "terminal events are emitted after the checkpoint is durable");
  await workspace.release();
}

async function checkLateTransportFailure(): Promise<void> {
  const adapter = new MemoryAdapter();
  const workspace = await AnnotationSetWorkspace.open(options(adapter));
  const service = new AiJobService();
  const entered = deferred(); const gate = deferred();
  const realFetch = globalThis.fetch;
  let connection = { ...DEFAULT_AI_SETTINGS, apiKey: "original-key-sentinel" };
  const events: string[] = [];
  const unsubscribe = service.subscribe(state => events.push(state.status));
  try {
    globalThis.fetch = (async (_url: any, init: any) => {
      assert.equal(init.headers.Authorization, "Bearer original-key-sentinel");
      entered.resolve(); await gate.promise;
      throw new Error("Locally aborted transport after cancellation");
    }) as typeof fetch;
    const context = { adapter: adapter as any, jobsRootPath: "jobs", workspace, getConnection: () => connection, pdfDoc: { numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [] }) }) } };
    const job = await service.start(context, { setId: "default", setName: "Test", fromPage: 1, toPage: 1, prompt: "Explain" });
    await entered.promise;
    connection = { ...connection, baseUrl: "https://another.example/v1", apiKey: "different-key-sentinel" };
    const stopped = new Promise<void>(resolve => {
      const remove = service.subscribe(state => { if (state.status === "cancelled") { remove(); resolve(); } });
    });
    await service.cancel(job.id, context);
    await stopped;
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(events.at(-1), "cancelled", "late transport completion cannot restart or fail a cancelled job");
    assert.equal((await service.list(context))[0].status, "cancelled");
    assert.equal(workspace.doc.highlights.length, 0);
  } finally {
    gate.resolve(); globalThis.fetch = realFetch; unsubscribe(); await workspace.release();
  }
}

async function main(): Promise<void> {
  await checkSets(); await checkSaveDuringWrite(); checkAnchors(); checkCredentials(); await checkJobRecovery(); await checkRequestContracts(); await checkRunningJobControls(); await checkLateTransportFailure();
  console.log("reliability smoke: shared tabs, registry recovery, in-flight saves, strict anchors, credentials, provider request contracts, restart, cancellation and duplicate resume passed (no provider calls)");
}
void main();
