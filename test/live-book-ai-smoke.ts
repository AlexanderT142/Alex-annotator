import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.js";
import { AnnotationSetWorkspace } from "../src/annotation-sets";
import { AiJobService, type AiAnnotationJobState } from "../src/ai-jobs";
import { listAiModels, type AiConnectionSettings } from "../src/ai-provider";

(globalThis as any).window = globalThis;

const fixture = process.env.LPA_BOOK_FIXTURE;
const key = process.env.LPA_LIVE_API_KEY?.trim() ?? "";

class FsAdapter {
  constructor(private root: string) {}
  private full(p: string): string { return path.join(this.root, p); }
  async exists(p: string): Promise<boolean> {
    try { await stat(this.full(p)); return true; } catch { return false; }
  }
  async stat(p: string): Promise<any> {
    try {
      const value = await stat(this.full(p));
      return { type: value.isDirectory() ? "folder" : "file", size: value.size };
    } catch { return null; }
  }
  async list(p: string): Promise<{ files: string[]; folders: string[] }> {
    const entries = await readdir(this.full(p), { withFileTypes: true });
    return {
      files: entries.filter((entry) => entry.isFile()).map((entry) => `${p}/${entry.name}`),
      folders: entries.filter((entry) => entry.isDirectory()).map((entry) => `${p}/${entry.name}`),
    };
  }
  async read(p: string): Promise<string> { return readFile(this.full(p), "utf8"); }
  async write(p: string, value: string): Promise<void> {
    await mkdir(path.dirname(this.full(p)), { recursive: true });
    await writeFile(this.full(p), value, "utf8");
  }
  async mkdir(p: string): Promise<void> { await mkdir(this.full(p)); }
}

function waitForJob(service: AiJobService, jobId: string): Promise<AiAnnotationJobState> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for AI job ${jobId}`));
    }, 10 * 60 * 1000);
    const cleanup = service.subscribe((state) => {
      if (state.id !== jobId) return;
      if (state.status === "completed") {
        clearTimeout(timeout);
        cleanup();
        resolve(state);
      } else if (state.status === "failed" || state.status === "cancelled") {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(state.error ?? state.message));
      }
    });
  });
}

async function runOne(
  service: AiJobService,
  context: any,
  workspace: AnnotationSetWorkspace,
  name: string,
  prompt: string
): Promise<AiAnnotationJobState> {
  const set = await workspace.createSet(name, "ai");
  const started = await service.start(context, {
    setId: set.id,
    setName: set.name,
    fromPage: 20,
    toPage: 29,
    prompt,
  });
  const finished = await waitForJob(service, started.id);
  assert.equal(finished.completedPages, 10);
  assert.ok(finished.createdAnnotations > 0, `${name} must create at least one grounded annotation`);
  assert.equal(workspace.highlightsForSet(set.id).length, finished.createdAnnotations);
  return finished;
}

async function main(): Promise<void> {
  assert.ok(fixture, "Set LPA_BOOK_FIXTURE to a non-vault PDF copy for the live book test");
  assert.ok(key, "LPA_LIVE_API_KEY must be supplied without writing it to disk");
  const connection: AiConnectionSettings = {
    provider: "glm",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.2",
    apiKey: key,
  };
  const temp = await mkdtemp(path.join(os.tmpdir(), "lpa-live-ai-"));
  try {
    const models = await listAiModels(connection);
    assert.ok(models.includes(connection.model), `provider model list must include ${connection.model}`);
    GlobalWorkerOptions.workerSrc = path.join(
      process.cwd(),
      "node_modules/pdfjs-dist/legacy/build/pdf.worker.js"
    );
    const pdf = await getDocument({ data: new Uint8Array(await readFile(fixture)) }).promise;
    const adapter = new FsAdapter(temp);
    const workspace = await AnnotationSetWorkspace.open({
      adapter: adapter as any,
      setsRootPath: "bundle/annotation-sets",
      indexPath: "bundle/annotation-sets/index.json",
      legacyAnnotationPath: "bundle/annotations.md",
      pdfBasename: "Economic and Philosophic Manuscripts of 1844",
      pdfVaultPath: "Books/economic-and-philosophic-manuscripts-of-1844.pdf",
      fingerprint: "book-live-ai",
    });
    const service = new AiJobService();
    const context = {
      adapter: adapter as any,
      jobsRootPath: "bundle/ai-jobs",
      pdfDoc: pdf,
      workspace,
      getConnection: () => connection,
    };

    const translation = await runOne(
      service,
      context,
      workspace,
      "Chinese translation",
      "For each page, select one important sentence and translate it into clear Simplified Chinese. Put only the translation in the note."
    );
    const partner = await runOne(
      service,
      context,
      workspace,
      "Study partner",
      "For each page, select one important passage and add a concise explanation or conceptual connection that helps a serious reader understand it more deeply."
    );
    assert.equal(workspace.listSets().filter((set) => set.kind === "ai").length, 2);
    console.log(
      `live GLM book test passed: ${models.length} current models discovered; pages 20-29; translation=${translation.createdAnnotations} grounded (${translation.rejectedAnnotations} rejected); study=${partner.createdAnnotations} grounded (${partner.rejectedAnnotations} rejected)`
    );
    await pdf.destroy();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

void main();
