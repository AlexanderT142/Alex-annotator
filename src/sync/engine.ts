/**
 * Sync engine for one PDF on one device. Talks to the core only through
 * syncSnapshot()/applySyncedChanges() and to storage only through a small
 * adapter, so it can be tested with in-memory devices.
 */
import type { Highlight } from "../annotations";
import type { AnnotationSetMeta } from "../annotation-sets";
import { mergeShards } from "./merge";
import {
  baselineHighlightOf,
  baselineOf,
  baselineSetOf,
  detectLocalEdits,
  isEmptyPlan,
  planApply,
  type ApplyPlan,
  type Baseline,
  type LocalSnapshot,
  type OwnState,
} from "./records";
import { IncompleteShardError, parseShard, serializeShard } from "./shard";
import type { ShardPayload, SyncHighlightRecord, SyncSetRecord } from "./types";
import { randomToken, stableStringify } from "./util";

export interface SyncAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  remove?(path: string): Promise<void>;
}

export interface SyncWorkspace {
  syncSnapshot(): LocalSnapshot;
  applySyncedChanges(changes: ApplyPlan): Promise<void>;
  /** Persist the core's own files. Awaited before the baseline is saved. */
  flush(): Promise<void>;
}

/** Machine-local identity. Must never live in a file that syncs. */
export interface DeviceIdentity {
  get(): string;
  regenerate(): string;
  getNonce(path: string): string | null;
  setNonce(path: string, nonce: string): void;
}

export interface DeletionGuard {
  /** Any batch larger than this needs confirmation. */
  maxCount: number;
  /** Batches of at least minCount that remove more than this share need confirmation. */
  maxRatio: number;
  minCount: number;
}

export interface EngineOptions {
  adapter: SyncAdapter;
  workspace: SyncWorkspace;
  docHash: string;
  /** Visible, synced folder, e.g. "_pdf-annotator-sync". */
  syncRoot: string;
  /** Hidden, device-local folder, e.g. ".pdf-annotator/sync". */
  localRoot: string;
  identity: DeviceIdentity;
  now?: () => number;
  isEditing?: () => boolean;
  notify?: (message: string) => void;
  retryDelays?: number[];
  sleep?: (ms: number) => Promise<void>;
  deletionGuard?: DeletionGuard;
  maxSnapshots?: number;
}

export const DEFAULT_DELETION_GUARD: DeletionGuard = { maxCount: 5, maxRatio: 0.2, minCount: 3 };

export interface CycleReport {
  /** Main-thread time spent merging and comparing, in ms (I/O waits excluded). */
  workMs: number;
  localEdits: boolean;
  applied: ApplyPlan | null;
  deferred: boolean;
  pendingDeletions: number;
  wroteShard: boolean;
}

export class DocSyncEngine {
  private loaded = false;
  private baseline: Baseline | null = null;
  private own: OwnState = { sets: new Map(), records: new Map() };
  private ownDirty = false;
  private cache = new Map<string, ShardPayload>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastLocalJson = { baseline: "", own: "" };
  private confirmedDeletions = new Set<string>();
  private pendingDeletions: string[] = [];
  private notifiedPending = "";
  private paused = false;
  private stopped = false;
  private applyingNow = false;
  private ownFromLocalFile = false;
  private workMs = 0;
  writes = 0;

  constructor(private o: EngineOptions) {}

  get isPaused(): boolean { return this.paused; }
  get isStopped(): boolean { return this.stopped; }
  /**
   * True only while sync itself is changing the workspace. The core emits
   * change events synchronously inside applySyncedChanges, so listeners can
   * tell sync-made changes from user or AI edits.
   */
  get isApplying(): boolean { return this.applyingNow; }
  get pendingDeletionCount(): number { return this.pendingDeletions.length; }

  /**
   * Run one full cycle. Cycles never overlap. With applyRemote false, local
   * edits are published but nothing is changed locally (used when closing).
   */
  sync(options: { applyRemote?: boolean } = {}): Promise<CycleReport | null> {
    const applyRemote = options.applyRemote !== false;
    const run = this.queue.catch(() => {}).then(() => this.cycle(applyRemote));
    this.queue = run;
    return run;
  }

  stop(): void { this.stopped = true; }
  pause(): void { this.paused = true; }
  resume(): Promise<CycleReport | null> { this.paused = false; return this.sync(); }

  /** Approve the deletions that were held back and apply them. */
  confirmPendingDeletions(): Promise<CycleReport | null> {
    for (const id of this.pendingDeletions) this.confirmedDeletions.add(id);
    this.pendingDeletions = [];
    return this.sync();
  }

  /**
   * Put the local data back to how it was before the last applied sync, then
   * pause. Each call steps one snapshot further back.
   */
  restoreLastSnapshot(): Promise<boolean> {
    return this.enqueue(async () => {
      const dir = `${this.localDir()}/snapshots`;
      if (!(await this.o.adapter.exists(dir))) return false;
      const files = (await this.o.adapter.list(dir)).files.filter((f) => f.endsWith(".json")).sort();
      const latest = files[files.length - 1];
      if (!latest) return false;
      await this.restoreFrom(latest);
      if (this.o.adapter.remove) await this.o.adapter.remove(latest);
      return true;
    });
  }

  /** Put the local data back to how it was before sync first ran for this PDF, then pause. */
  restorePreSyncBackup(): Promise<boolean> {
    return this.enqueue(async () => {
      const path = await this.findPreSyncBackup();
      if (!path) return false;
      await this.restoreFrom(path);
      return true;
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(fn);
    this.queue = run;
    return run;
  }

  private async restoreFrom(path: string): Promise<void> {
    const snapshot = JSON.parse(await this.o.adapter.read(path)) as LocalSnapshot;
    if (!Array.isArray(snapshot.sets) || !Array.isArray(snapshot.highlights)) throw new Error("Sync backup is unreadable.");
    this.paused = true;
    await this.applyGuarded(planRestore(snapshot, this.o.workspace.syncSnapshot()));
    await this.o.workspace.flush();
  }

  /** Apply with the change flag set; the synchronous part runs inside the flag. */
  private applyGuarded(plan: ApplyPlan): Promise<void> {
    this.applyingNow = true;
    try {
      return this.o.workspace.applySyncedChanges(plan);
    } finally {
      this.applyingNow = false;
    }
  }

  private preSyncBackupPath(): string { return `${this.localDir()}/pre-sync-backup.json`; }

  private async findPreSyncBackup(): Promise<string | null> {
    if (await this.o.adapter.exists(this.preSyncBackupPath())) return this.preSyncBackupPath();
    // The device id may have changed since (copied profile); look in every device folder.
    if (!(await this.o.adapter.exists(this.o.localRoot))) return null;
    let best: { path: string; takenAt: number } | null = null;
    for (const dir of (await this.o.adapter.list(this.o.localRoot)).folders) {
      const path = `${dir}/${this.o.docHash}/pre-sync-backup.json`;
      if (!(await this.o.adapter.exists(path))) continue;
      try {
        const takenAt = Number(JSON.parse(await this.o.adapter.read(path)).takenAt) || 0;
        if (!best || takenAt < best.takenAt) best = { path, takenAt };
      } catch {
        /* unreadable candidate */
      }
    }
    return best?.path ?? null;
  }

  /** Written once, before sync first touches this PDF on this device. Never rotated. */
  private async ensurePreSyncBackup(): Promise<void> {
    const path = this.preSyncBackupPath();
    if (await this.o.adapter.exists(path)) return;
    await this.ensureFolder(this.localDir());
    await this.o.adapter.write(path, JSON.stringify({ takenAt: this.now(), ...this.o.workspace.syncSnapshot() }));
  }

  // ------------------------------------------------------------------

  private now(): number { return (this.o.now ?? Date.now)(); }
  private shardDir(): string { return `${this.o.syncRoot}/${this.o.docHash}`; }
  private ownShardPath(): string { return `${this.shardDir()}/${this.o.identity.get()}.md`; }
  private localDir(): string { return `${this.o.localRoot}/${this.o.identity.get()}/${this.o.docHash}`; }

  private async cycle(applyRemote: boolean): Promise<CycleReport | null> {
    if (this.stopped || this.paused) return null;
    if (!this.loaded) await this.load();
    if (!this.baseline) await this.ensurePreSyncBackup();
    this.workMs = 0;
    const foreign = await this.readShards();
    if (this.stopped || this.paused) return null;

    // ---- synchronous section: no awaits until the baseline is updated ----
    const started = clockMs();
    const previousBaseline = this.baseline;
    const me = this.o.identity.get();
    const local = this.o.workspace.syncSnapshot();
    const pre = mergeShards([...foreign, this.ownPayload("")]);
    const det = detectLocalEdits({ local, baseline: this.baseline, own: this.own, merged: pre, deviceId: me, now: this.now() });
    this.own = det.own;
    if (det.changed) this.ownDirty = true;
    const merged = det.changed ? mergeShards([...foreign, this.ownPayload("")]) : pre;
    const plan = planApply(merged, local);
    this.holdLargeDeletions(plan, local);

    let applying: Promise<void> | null = null;
    let deferred = false;
    if (!isEmptyPlan(plan)) {
      if (!applyRemote || this.o.isEditing?.()) deferred = true;
      else applying = this.applyGuarded(plan);
    }
    this.baseline = baselineOf(applying ? this.o.workspace.syncSnapshot() : local, merged, this.baseline, this.own);
    this.workMs += clockMs() - started;
    // ---- end synchronous section ----

    if (applying) {
      try {
        await applying;
      } catch (error) {
        // The core rejects invalid plans before changing anything; if it
        // failed part-way anyway, put the in-memory state back as it was.
        this.baseline = previousBaseline;
        try {
          await this.applyGuarded(planRestore(local, this.o.workspace.syncSnapshot()));
        } catch (rollbackError) {
          console.error("[PDF Annotator] sync could not roll back a failed change", rollbackError);
        }
        throw error;
      }
      await this.writeSnapshot(local);
      // The core must hold the applied changes on disk before the baseline
      // says so; otherwise a crash here would look like local deletions.
      await this.o.workspace.flush();
    }
    // Order: shard, then own.json, then baseline. Any failure leaves the next
    // cycle to detect the same local edits again, never to lose them.
    let wroteShard = false;
    if (this.ownDirty) {
      await this.writeOwnShard();
      wroteShard = true;
    }
    await this.persistLocal();
    return { workMs: this.workMs, localEdits: det.changed, applied: applying ? plan : null, deferred, pendingDeletions: this.pendingDeletions.length, wroteShard };
  }

  private holdLargeDeletions(plan: ApplyPlan, local: LocalSnapshot): void {
    const unconfirmed = plan.removals.filter((id) => !this.confirmedDeletions.has(id));
    const g = this.o.deletionGuard ?? DEFAULT_DELETION_GUARD;
    const total = Math.max(1, local.highlights.length);
    const large = unconfirmed.length > g.maxCount || (unconfirmed.length >= g.minCount && unconfirmed.length / total > g.maxRatio);
    if (!large) {
      this.pendingDeletions = [];
      return;
    }
    const held = new Set(unconfirmed);
    plan.removals = plan.removals.filter((id) => !held.has(id));
    this.pendingDeletions = unconfirmed;
    const key = [...unconfirmed].sort().join(",");
    if (key !== this.notifiedPending) {
      this.notifiedPending = key;
      this.o.notify?.(
        `PDF Annotator sync: another device deleted ${unconfirmed.length} annotations in this PDF. ` +
          `They were kept here. Run “Apply pending sync deletions” to delete them.`
      );
    }
  }

  private async load(): Promise<void> {
    const dir = this.localDir();
    const baselinePath = `${dir}/baseline.json`;
    const ownPath = `${dir}/own.json`;
    if (await this.o.adapter.exists(baselinePath)) {
      try {
        const raw = await this.o.adapter.read(baselinePath);
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1 && parsed.sets && parsed.highlights) {
          this.baseline = parsed;
          this.lastLocalJson.baseline = raw;
        }
      } catch {
        this.baseline = null; // treated as a first cycle: everything is re-exported deterministically
      }
    }
    if (await this.o.adapter.exists(ownPath)) {
      try {
        const raw = await this.o.adapter.read(ownPath);
        const parsed = JSON.parse(raw);
        this.own = {
          sets: new Map((parsed.sets ?? []).map((s: SyncSetRecord) => [s.id, s])),
          records: new Map((parsed.records ?? []).map((r: SyncHighlightRecord) => [r.id, r])),
        };
        this.lastLocalJson.own = raw;
        this.ownFromLocalFile = true;
      } catch {
        this.own = { sets: new Map(), records: new Map() };
      }
    }
    this.loaded = true;
  }

  private async readShards(): Promise<ShardPayload[]> {
    const dir = this.shardDir();
    if (!(await this.o.adapter.exists(dir))) {
      this.cache.clear();
      if (this.own.records.size || this.own.sets.size) this.ownDirty = true;
      return [];
    }
    const files = (await this.o.adapter.list(dir)).files.filter((f) => f.endsWith(".md"));
    const present = new Set(files);
    for (const path of [...this.cache.keys()]) if (!present.has(path)) this.cache.delete(path);

    const ownPath = this.ownShardPath();
    if (present.has(ownPath)) {
      const payload = await this.readWithRetry(ownPath);
      const expected = this.o.identity.getNonce(ownPath);
      if (payload && payload.writeNonce === expected && !this.ownFromLocalFile && !this.own.records.size && !this.own.sets.size) {
        // Local record of our own shard was lost; the published copy is ours.
        this.own = { sets: new Map(payload.sets.map((x) => [x.id, x])), records: new Map(payload.records.map((r) => [r.id, r])) };
        this.ownFromLocalFile = true;
      } else if (payload && payload.writeNonce !== expected) {
        // Another machine writes under our device id (cloned profile, restored
        // backup). Keep its file as read-only history and move to a new id.
        this.o.identity.regenerate();
        this.ownDirty = true;
        this.lastLocalJson = { baseline: "", own: "" };
        this.o.notify?.("PDF Annotator sync: this device's sync id was in use by another computer. A new id was created; no annotations were lost.");
      }
    } else if (this.own.records.size || this.own.sets.size) {
      this.ownDirty = true; // our shard is missing (deleted or not yet synced); republish it
    }

    const out: ShardPayload[] = [];
    const myPath = this.ownShardPath();
    for (const path of files) {
      if (path === myPath) continue;
      const payload = await this.readWithRetry(path);
      if (payload) {
        this.cache.set(path, payload);
        out.push(payload);
      } else if (this.cache.has(path)) {
        out.push(this.cache.get(path)!); // keep the last good copy; never treat a partial file as empty
      }
    }
    return out;
  }

  private async readWithRetry(path: string): Promise<ShardPayload | null> {
    const delays = this.o.retryDelays ?? [300, 800, 2000];
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await this.o.adapter.read(path);
        const t = clockMs();
        try {
          return parseShard(raw, this.o.docHash);
        } finally {
          this.workMs += clockMs() - t;
        }
      } catch (error) {
        if (attempt >= delays.length) {
          if (!(error instanceof IncompleteShardError)) console.warn(`[PDF Annotator] sync could not read ${path}`, error);
          else console.warn(`[PDF Annotator] sync skipped an incomplete or damaged file: ${path}`);
          return null;
        }
        await sleep(delays[attempt]);
      }
    }
  }

  private ownPayload(nonce: string): ShardPayload {
    return {
      schema: 1,
      kind: "device-shard",
      docHash: this.o.docHash,
      deviceId: this.o.identity.get(),
      writeNonce: nonce,
      sets: [...this.own.sets.values()].sort((a, b) => a.id.localeCompare(b.id)),
      records: [...this.own.records.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!(await this.o.adapter.exists(p))) await this.o.adapter.mkdir(p);
    }
  }

  private async writeOwnShard(): Promise<void> {
    const nonce = randomToken(12);
    const path = this.ownShardPath();
    await this.ensureFolder(this.shardDir());
    await this.o.adapter.write(path, serializeShard(this.ownPayload(nonce)));
    this.o.identity.setNonce(path, nonce);
    this.ownDirty = false;
    this.writes++;
  }

  private async persistLocal(): Promise<void> {
    const dir = this.localDir();
    const baselineJson = JSON.stringify(this.baseline);
    const ownJson = JSON.stringify({ sets: [...this.own.sets.values()], records: [...this.own.records.values()] });
    if (baselineJson === this.lastLocalJson.baseline && ownJson === this.lastLocalJson.own) return;
    await this.ensureFolder(dir);
    // own.json before baseline: it is the record of what this device has published.
    if (ownJson !== this.lastLocalJson.own) {
      await this.o.adapter.write(`${dir}/own.json`, ownJson);
      this.lastLocalJson.own = ownJson;
    }
    if (baselineJson !== this.lastLocalJson.baseline) {
      await this.o.adapter.write(`${dir}/baseline.json`, baselineJson);
      this.lastLocalJson.baseline = baselineJson;
    }
  }

  private async writeSnapshot(before: LocalSnapshot): Promise<void> {
    const dir = `${this.localDir()}/snapshots`;
    await this.ensureFolder(dir);
    const name = `${String(this.now()).padStart(15, "0")}-${randomToken(4)}.json`;
    await this.o.adapter.write(`${dir}/${name}`, JSON.stringify(before));
    if (!this.o.adapter.remove) return;
    const files = (await this.o.adapter.list(dir)).files.filter((f) => f.endsWith(".json")).sort();
    const keep = this.o.maxSnapshots ?? 15;
    for (const old of files.slice(0, Math.max(0, files.length - keep))) await this.o.adapter.remove(old);
  }
}

function clockMs(): number {
  const perf = (globalThis as any).performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

/** Changes that make `current` equal to `snapshot`. */
export function planRestore(snapshot: LocalSnapshot, current: LocalSnapshot): ApplyPlan {
  const plan: ApplyPlan = { sets: [], upserts: [], removals: [] };
  const curSets = new Map(current.sets.map((s) => [s.id, s]));
  for (const s of snapshot.sets as AnnotationSetMeta[]) {
    const c = curSets.get(s.id);
    if (!c || stableStringify(baselineSetOf(c)) !== stableStringify(baselineSetOf(s))) plan.sets.push({ id: s.id, ...baselineSetOf(s) });
  }
  const snapIds = new Set<string>();
  const curById = new Map(current.highlights.map((h) => [h.id, h]));
  for (const h of snapshot.highlights as Highlight[]) {
    snapIds.add(h.id);
    const c = curById.get(h.id);
    if (!c || stableStringify(baselineHighlightOf(c)) !== stableStringify(baselineHighlightOf(h))) plan.upserts.push(h);
  }
  for (const h of current.highlights) if (!snapIds.has(h.id)) plan.removals.push(h.id);
  return plan;
}
