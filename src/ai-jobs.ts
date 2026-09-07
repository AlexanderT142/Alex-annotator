import type { DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";
import { AnnotationSetWorkspace } from "./annotation-sets";
import { PALETTE, markStyleOf, newId, type Highlight } from "./annotations";
import { anchorQuoteOnPage, buildDocIndexRange, plainTextForPage } from "./anchor";
import {
  AiProviderError,
  requestAiAnnotations,
  safeProviderError,
  type AiConnectionSettings,
} from "./ai-provider";
import { connectionForJob } from "./ai-credentials";

export type AiJobStatus = "queued" | "indexing" | "requesting" | "anchoring" | "paused" | "completed" | "cancelled" | "failed";

export interface AiAnnotationJobState {
  version: 1;
  id: string;
  jobsRootPath: string;
  setId: string;
  setName: string;
  fromPage: number;
  toPage: number;
  nextPage: number;
  prompt: string;
  provider: string;
  protocol: string;
  baseUrl: string;
  model: string;
  status: AiJobStatus;
  completedPages: number;
  createdAnnotations: number;
  rejectedAnnotations: number;
  message: string;
  error?: string;
  created: string;
  updated: string;
}

export interface AiJobContext {
  adapter: DataAdapter;
  jobsRootPath: string;
  pdfDoc: any;
  workspace: AnnotationSetWorkspace;
  getConnection: () => AiConnectionSettings;
}

export interface StartAiJobOptions {
  setId: string;
  setName: string;
  fromPage: number;
  toPage: number;
  prompt: string;
}

interface JobControl {
  pauseRequested: boolean;
  cancelRequested: boolean;
  stopped: Promise<never>;
  stop: () => void;
}

function jobControl(): JobControl {
  let stop!: () => void;
  const stopped = new Promise<never>((_, reject) => { stop = () => reject(new Error("Job stopped; saved annotations were kept.")); });
  void stopped.catch(() => {});
  return { pauseRequested: false, cancelRequested: false, stopped, stop };
}

const PAGE_BATCH_SIZE = 2;

export class AiJobService {
  private states = new Map<string, AiAnnotationJobState>();
  private controls = new Map<string, JobControl>();
  private listeners = new Set<(state: AiAnnotationJobState) => void>();
  private checkpointWrites = new Map<string, Promise<void>>();
  private pendingStarts = new Set<string>();

  subscribe(listener: (state: AiAnnotationJobState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activeForRoot(jobsRootPath: string): AiAnnotationJobState[] {
    const root = normalizePath(jobsRootPath);
    return [...this.states.values()].filter((state) =>
      normalizePath(state.jobsRootPath) === root &&
      state.status !== "completed" &&
      state.status !== "cancelled"
    ).sort((a, b) =>
      Number(this.controls.has(b.id)) - Number(this.controls.has(a.id)) ||
      b.updated.localeCompare(a.updated)
    );
  }

  async list(context: Pick<AiJobContext, "adapter" | "jobsRootPath">): Promise<AiAnnotationJobState[]> {
    const root = normalizePath(context.jobsRootPath);
    if (!(await context.adapter.exists(root))) return [];
    const listing = await context.adapter.list(root);
    const jobs: AiAnnotationJobState[] = [];
    const ids = new Set(listing.files.map((file) => file.split("/").pop()?.match(/^([a-zA-Z0-9_-]+)(?:\.previous)?\.json$/)?.[1]).filter((id): id is string => !!id));
    for (const id of ids) {
      try {
        const current = this.states.get(id);
        if (this.controls.has(id) && current?.jobsRootPath === root) {
          jobs.push({ ...current });
          continue;
        }
        const parsed = await this.readCheckpoint(context, id);
        if (!["paused", "failed", "completed", "cancelled"].includes(parsed.status)) {
          this.update(parsed, "paused", "Interrupted before completion. Resume to continue from the last saved pages.");
          await this.persist(context, parsed);
        }
        jobs.push({ ...parsed });
        this.states.set(parsed.id, parsed);
      } catch {
        throw new Error("An AI job checkpoint could not be recovered. Its files were preserved.");
      }
    }
    return jobs.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async start(context: AiJobContext, options: StartAiJobOptions): Promise<AiAnnotationJobState> {
    const connection = { ...context.getConnection() };
    this.validateStart(context, options);
    connectionForJob(connection, connection);
    const now = new Date().toISOString();
    const state: AiAnnotationJobState = {
      version: 1,
      id: crypto.randomUUID(),
      jobsRootPath: normalizePath(context.jobsRootPath),
      setId: options.setId,
      setName: options.setName,
      fromPage: options.fromPage,
      toPage: options.toPage,
      nextPage: options.fromPage,
      prompt: options.prompt.trim(),
      provider: connection.provider,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      model: connection.model,
      status: "queued",
      completedPages: 0,
      createdAnnotations: 0,
      rejectedAnnotations: 0,
      message: "Queued",
      created: now,
      updated: now,
    };
    this.states.set(state.id, state);
    this.controls.set(state.id, jobControl());
    context.workspace.retain();
    try { await this.persist(context, state); }
    catch (error) {
      this.controls.delete(state.id);
      this.states.delete(state.id);
      await context.workspace.release();
      throw error;
    }
    void this.run(context, state, connection);
    return state;
  }

  async resume(context: AiJobContext, jobId: string): Promise<AiAnnotationJobState> {
    if (this.pendingStarts.has(jobId) || this.controls.has(jobId)) throw new Error("This job is already running.");
    this.pendingStarts.add(jobId);
    try {
    const parsed = await this.readCheckpoint(context, jobId);
    if (this.controls.has(jobId)) throw new Error("This job is already running.");
    if (parsed.status === "completed" || parsed.status === "cancelled") return parsed;
    this.validateStart(context, parsed);
    const connection = connectionForJob(context.getConnection(), parsed);
    parsed.status = "queued";
    parsed.error = undefined;
    parsed.message = "Queued to resume";
    parsed.updated = new Date().toISOString();
    this.states.set(parsed.id, parsed);
    this.controls.set(parsed.id, jobControl());
    context.workspace.retain();
    try { await this.persist(context, parsed); }
    catch (error) {
      this.controls.delete(parsed.id);
      await context.workspace.release();
      throw error;
    }
    void this.run(context, parsed, connection);
    return parsed;
    } finally { this.pendingStarts.delete(jobId); }
  }

  pause(jobId: string): void {
    const control = this.controls.get(jobId);
    if (control) { control.pauseRequested = true; control.stop(); }
  }

  async cancel(jobId: string, context?: Pick<AiJobContext, "adapter" | "jobsRootPath">): Promise<void> {
    const control = this.controls.get(jobId);
    if (control) { control.cancelRequested = true; control.stop(); return; }
    if (!context) return;
    const state = await this.readCheckpoint(context, jobId);
    if (state.status === "completed" || state.status === "cancelled") return;
    this.update(state, "cancelled", "Cancelled; completed annotations were kept");
    await this.persist(context, state);
  }

  pauseForRoot(jobsRootPath: string): void {
    const root = normalizePath(jobsRootPath);
    for (const state of this.states.values()) {
      if (normalizePath(state.jobsRootPath) === root) this.pause(state.id);
    }
  }

  private async run(context: AiJobContext, state: AiAnnotationJobState, connection: AiConnectionSettings): Promise<void> {
    const control = this.controls.get(state.id)!;
    try {
      const seen = new Set(
        context.workspace.highlightsForSet(state.setId).map((h) => `${h.page}|${dedupe(h.text)}`)
      );
      for (let start = state.nextPage; start <= state.toPage; start += PAGE_BATCH_SIZE) {
        if (control.cancelRequested) {
          this.update(state, "cancelled", "Cancelled; completed annotations were kept");
          await this.persist(context, state);
          return;
        }
        if (control.pauseRequested) {
          this.update(state, "paused", `Paused before page ${start}`);
          await this.persist(context, state);
          return;
        }

        const end = Math.min(state.toPage, start + PAGE_BATCH_SIZE - 1);
        this.update(state, "indexing", `Reading pages ${start}–${end}`);
        await this.persist(context, state);
        const index = await Promise.race([buildDocIndexRange(context.pdfDoc, start - 1, end - 1), control.stopped]);
        if (control.cancelRequested || control.pauseRequested) {
          this.update(state, control.cancelRequested ? "cancelled" : "paused", "Stopped before the next request; saved annotations were kept");
          await this.persist(context, state);
          return;
        }
        const pages = [];
        for (let pageNumber = start; pageNumber <= end; pageNumber++) {
          pages.push({ pageNumber, text: plainTextForPage(index, pageNumber - 1) });
        }
        this.update(state, "requesting", `Requesting pages ${start}–${end}`);
        await this.persist(context, state);
        const response = await this.requestWithRetry(connection, state.prompt, pages, control);
        if (control.cancelRequested || control.pauseRequested) {
          this.update(state, control.cancelRequested ? "cancelled" : "paused", "Stopped; completed annotations were kept");
          await this.persist(context, state);
          return;
        }

        this.update(state, "anchoring", `Anchoring pages ${start}–${end}`);
        const created: Highlight[] = [];
        let rejected = 0;
        for (const candidate of response.annotations) {
          if (candidate.pageNumber < start || candidate.pageNumber > end) {
            rejected++;
            continue;
          }
          const page = candidate.pageNumber - 1;
          const anchors = anchorQuoteOnPage(index, page, candidate.exactQuote, candidate.prefix, candidate.suffix);
          if (!anchors.length) {
            rejected++;
            continue;
          }
          const cleanText = candidate.exactQuote.replace(/\s+/g, " ").trim();
          const key = `${page}|${dedupe(cleanText)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const anchor = anchors[0];
          created.push({
            id: newId(),
            type: "highlight",
            page,
            color: colorValue(candidate.color),
            style: markStyleOf({ style: candidate.style ?? "comment" }),
            text: cleanText,
            note: candidate.note,
            rects: anchor.rects,
            created: new Date().toISOString(),
            source: "ai",
            setId: state.setId,
            marginSide: "auto",
            isPinned: false,
            context: { prefix: candidate.prefix, suffix: candidate.suffix },
            ai: {
              jobId: state.id,
              provider: state.provider,
              model: state.model,
              generatedAt: new Date().toISOString(),
            },
          });
        }
        if (created.length) context.workspace.addToSet(state.setId, created);
        await context.workspace.flush();
        state.createdAnnotations = context.workspace.highlightsForSet(state.setId).filter((h) => h.ai?.jobId === state.id).length;
        state.rejectedAnnotations += rejected;
        state.completedPages = end - state.fromPage + 1;
        state.nextPage = end + 1;
        this.update(state, "requesting", `Saved through page ${end}`);
        await this.persist(context, state);
      }

      this.update(
        state,
        "completed",
        `Completed ${state.completedPages} pages; ${state.createdAnnotations} annotations`
      );
      await this.persist(context, state);
    } catch (error: any) {
      state.error = safeProviderError(error, connection.apiKey).message;
      const status = control.cancelRequested ? "cancelled" : control.pauseRequested ? "paused" : "failed";
      this.update(state, status, status === "failed" ? state.error : "Stopped; resume from the last saved pages when ready");
      try { await this.persist(context, state); }
      catch {
        this.update(state, "failed", "Could not save the job checkpoint. Existing annotations were kept; reopen the job to recover.");
        this.notify(state);
      }
    } finally {
      this.controls.delete(state.id);
      try { await context.workspace.release(); }
      catch {
        this.update(state, "failed", "Could not finish saving annotations. Keep this PDF open and retry saving.");
        this.notify(state);
      }
    }
  }

  private async requestWithRetry(
    connection: AiConnectionSettings,
    prompt: string,
    pages: Array<{ pageNumber: number; text: string }>,
    control: JobControl
  ) {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (control.cancelRequested || control.pauseRequested) throw new Error("Job stopped before retrying the request.");
      try {
        return await Promise.race([requestAiAnnotations(connection, prompt, pages), control.stopped]);
      } catch (error) {
        last = error;
        const status = error instanceof AiProviderError ? error.status : undefined;
        if (attempt >= 3 || (status !== 429 && (!status || status < 500))) throw error;
        await Promise.race([delay(1000 * 2 ** attempt), control.stopped]);
      }
    }
    throw last;
  }

  private update(state: AiAnnotationJobState, status: AiJobStatus, message: string): void {
    state.status = status;
    state.message = message;
    state.updated = new Date().toISOString();
    this.states.set(state.id, state);
    if (!["paused", "completed", "cancelled", "failed"].includes(status)) this.notify(state);
  }

  private notify(state: AiAnnotationJobState): void {
    for (const listener of this.listeners) {
      try { listener({ ...state }); } catch { /* UI listeners cannot fail a persisted job. */ }
    }
  }

  private async persist(context: Pick<AiJobContext, "adapter" | "jobsRootPath">, state: AiAnnotationJobState): Promise<void> {
    const path = this.jobPath(context.jobsRootPath, state.id);
    const snapshot = JSON.stringify(state, null, 2);
    const write = (this.checkpointWrites.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await ensureFolder(context.adapter, context.jobsRootPath);
      if (await context.adapter.exists(path)) {
        const current = await context.adapter.read(path);
        let valid = false;
        try { valid = isJobState(JSON.parse(current)); } catch { /* Keep the last good checkpoint. */ }
        if (valid) await context.adapter.write(path.replace(/\.json$/, ".previous.json"), current);
      }
      await context.adapter.write(path, snapshot);
    });
    this.checkpointWrites.set(path, write);
    await write;
    if (["paused", "completed", "cancelled", "failed"].includes(state.status)) this.notify(state);
  }

  private async readCheckpoint(context: Pick<AiJobContext, "adapter" | "jobsRootPath">, id: string): Promise<AiAnnotationJobState> {
    const path = this.jobPath(context.jobsRootPath, id);
    for (const candidate of [path, path.replace(/\.json$/, ".previous.json")]) {
      if (!(await context.adapter.exists(candidate))) continue;
      const raw = await context.adapter.read(candidate);
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { /* Try the backup. */ }
      if (isJobState(parsed) && parsed.id === id && normalizePath(parsed.jobsRootPath) === normalizePath(context.jobsRootPath)) return parsed;
      await context.adapter.write(`${candidate}.damaged-${Date.now()}`, raw);
    }
    throw new Error("The AI job checkpoint is invalid.");
  }

  private validateStart(context: AiJobContext, options: StartAiJobOptions): void {
    if (!Number.isInteger(options.fromPage) || !Number.isInteger(options.toPage) || options.fromPage < 1 || options.toPage < options.fromPage || options.toPage > context.pdfDoc.numPages) throw new Error("Choose a valid PDF page range.");
    if (!options.prompt.trim()) throw new Error("Write a prompt for the annotation job.");
    if (!context.getConnection().model.trim()) throw new Error("Choose a model first.");
    context.workspace.highlightsForSet(options.setId);
  }

  private jobPath(root: string, jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid AI job ID.");
    return normalizePath(`${root}/${jobId}.json`);
  }
}

function isJobState(value: any): value is AiAnnotationJobState {
  return (
    value?.version === 1 &&
    typeof value.id === "string" &&
    typeof value.jobsRootPath === "string" &&
    typeof value.setId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(value.setId) &&
    Number.isInteger(value.fromPage) &&
    Number.isInteger(value.toPage) &&
    value.fromPage >= 1 && value.toPage >= value.fromPage &&
    Number.isInteger(value.nextPage) && value.nextPage >= value.fromPage && value.nextPage <= value.toPage + 1 &&
    ["queued", "indexing", "requesting", "anchoring", "paused", "completed", "cancelled", "failed"].includes(value.status) &&
    ["setName", "provider", "protocol", "baseUrl", "model", "created", "updated", "message", "prompt"].every((key) => typeof value[key] === "string") &&
    ["completedPages", "createdAnnotations", "rejectedAnnotations"].every((key) => Number.isInteger(value[key]) && value[key] >= 0)
  );
}

function colorValue(name: string | undefined): string {
  const normalized = (name ?? "yellow").trim().toLowerCase();
  return PALETTE.find((entry) => entry.name === normalized)?.fill ?? PALETTE[0].fill;
}

function dedupe(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function ensureFolder(adapter: DataAdapter, folder: string): Promise<void> {
  const parts = normalizePath(folder).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const stat = await adapter.stat(current);
    if (stat?.type === "folder") continue;
    if (stat) throw new Error(`Cannot create ${current}; a file already exists there.`);
    try {
      await adapter.mkdir(current);
    } catch (error) {
      if ((await adapter.stat(current))?.type !== "folder") throw error;
    }
  }
}
