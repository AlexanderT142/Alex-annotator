/**
 * Obsidian glue for the sync add-on: device identity, vault events, debounce,
 * the circuit breaker and notices. Created only when the user enables sync.
 */
import { Notice, type App, type EventRef, type TAbstractFile } from "obsidian";
import type { AnnotationSetWorkspace } from "../annotation-sets";
import { SyncBreaker, SyncGovernor } from "./breaker";
import { DocSyncEngine, type DeviceIdentity } from "./engine";
import type { WorkspaceSyncHook } from "./hooks";
import { randomToken } from "./util";
import { hideFolderCss } from "./vault-hiding";

export const DEFAULT_SYNC_FOLDER = "_pdf-annotator-sync";
export const SYNC_LOCAL_ROOT = ".pdf-annotator/sync";
const LOCAL_CHANGE_DELAY = 2000;
const REMOTE_CHANGE_DELAY = 400;

/** A synced folder must be visible (Obsidian Sync skips dot folders) and outside the config folder. */
export function normalizeSyncFolder(value: string): string {
  const clean = value.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter(Boolean).join("/");
  if (!clean || clean.split("/").some((part) => part.startsWith(".") || part === "..")) return DEFAULT_SYNC_FOLDER;
  return clean;
}

class LocalStorageIdentity implements DeviceIdentity {
  constructor(private app: App) {}

  private load(key: string): any {
    const a = this.app as any;
    try {
      if (typeof a.loadLocalStorage === "function") return a.loadLocalStorage(key);
      const raw = window.localStorage.getItem(this.fallbackKey(key));
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private save(key: string, value: unknown): void {
    const a = this.app as any;
    if (typeof a.saveLocalStorage === "function") a.saveLocalStorage(key, value);
    else window.localStorage.setItem(this.fallbackKey(key), JSON.stringify(value));
  }

  private fallbackKey(key: string): string {
    const vault = (this.app as any).appId ?? this.app.vault.getName();
    return `${vault}:${key}`;
  }

  get(): string {
    let id = this.load("pdf-annotator:sync-device-id");
    if (typeof id !== "string" || !/^dev_[a-z0-9]{6,32}$/.test(id)) id = this.regenerate();
    return id;
  }

  regenerate(): string {
    const id = `dev_${randomToken(10)}`;
    this.save("pdf-annotator:sync-device-id", id);
    return id;
  }

  getNonce(path: string): string | null {
    const all = this.load("pdf-annotator:sync-nonces");
    return all && typeof all[path] === "string" ? all[path] : null;
  }

  setNonce(path: string, nonce: string): void {
    const all = this.load("pdf-annotator:sync-nonces") ?? {};
    all[path] = nonce;
    this.save("pdf-annotator:sync-nonces", all);
  }
}

/** Why sync is not running for a PDF; null while it runs. */
export type SyncPauseReason = "error" | "slow" | "loop" | "undo" | "restore";

interface DocEntry {
  hash: string;
  workspace: AnnotationSetWorkspace;
  engine: DocSyncEngine;
  refs: number;
  timer: number | null;
  unsubscribe: () => void;
  closing: Promise<void> | null;
  governor: SyncGovernor;
  /** A user or AI change happened since the last cycle (sync's own changes excluded). */
  externalChange: boolean;
  pauseReason: SyncPauseReason | null;
}

function isEditingAnnotation(): boolean {
  const doc: Document | undefined = (globalThis as any).activeDocument ?? (globalThis as any).document;
  const el = doc?.activeElement as HTMLElement | null | undefined;
  if (!el || typeof el.matches !== "function") return false;
  return el.matches("textarea,input,[contenteditable='true']") && !!el.closest("[class*='lpa-']");
}

export class SyncController implements WorkspaceSyncHook {
  private docs = new Map<string, DocEntry>();
  private breaker = new SyncBreaker(3);
  private events: EventRef[] = [];
  private identity: DeviceIdentity;
  private stopped = false;
  private hideSheet: CSSStyleSheet | null = null;

  constructor(private app: App, private syncRoot: string) {
    this.identity = new LocalStorageIdentity(app);
  }

  start(): void {
    const onFile = (file: TAbstractFile, oldPath?: string) => {
      for (const path of [file.path, oldPath]) if (path) this.onVaultPath(path);
    };
    const vault = this.app.vault as any;
    for (const name of ["create", "modify", "delete"]) this.events.push(vault.on(name, (f: TAbstractFile) => onFile(f)));
    this.events.push(vault.on("rename", (f: TAbstractFile, old: string) => onFile(f, old)));
    try {
      // A constructed stylesheet, not a <style> element: the folder name is a
      // setting, so this one rule cannot live in styles.css.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(hideFolderCss(this.syncRoot));
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      this.hideSheet = sheet;
    } catch (error) {
      console.warn("[PDF Annotator] could not hide the sync folder", error);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.hideSheet) {
      const sheet = this.hideSheet;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
      this.hideSheet = null;
    }
    for (const ref of this.events) this.app.vault.offref(ref);
    this.events = [];
    for (const entry of this.docs.values()) this.dispose(entry);
    this.docs.clear();
  }

  attach(workspace: AnnotationSetWorkspace, hash: string): void {
    if (this.stopped) return;
    const existing = this.docs.get(hash);
    if (existing && existing.workspace === workspace) {
      existing.refs++;
      this.schedule(existing, 0);
      return;
    }
    const previous = existing?.closing ?? null;
    if (existing) {
      this.dispose(existing);
      this.docs.delete(hash);
    }
    const entry: DocEntry = {
      hash, workspace, engine: this.makeEngine(workspace, hash), refs: 1, timer: null, unsubscribe: () => {}, closing: null,
      governor: new SyncGovernor(), externalChange: false,
      // A PDF that failed earlier this session stays paused until resumed.
      pauseReason: this.breaker.isBlocked(hash) ? "error" : null,
    };
    entry.unsubscribe = workspace.onChange(() => {
      // Sync's own changes are emitted synchronously while isApplying is true.
      if (entry.engine.isApplying) return;
      entry.externalChange = true;
      this.schedule(entry, LOCAL_CHANGE_DELAY);
    });
    this.docs.set(hash, entry);
    // Never let two engines for one PDF overlap.
    void (previous ?? Promise.resolve()).then(() => this.schedule(entry, 0));
  }

  detach(workspace: AnnotationSetWorkspace, hash: string): void {
    const entry = this.docs.get(hash);
    if (!entry || entry.workspace !== workspace) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    // One final cycle publishes the last edits, then the engine is released.
    entry.closing = this.run(entry, false).then(() => {
      if (entry.refs === 0 && this.docs.get(hash) === entry) {
        this.dispose(entry);
        this.docs.delete(hash);
      }
    });
  }

  /** Commands target the PDF whose bundle hash the caller resolved. */
  deviceId(): string {
    return this.identity.get();
  }

  isAttached(hash: string): boolean {
    return this.docs.has(hash);
  }

  /** Run a cycle now, or report why sync is paused for this PDF. */
  async syncNow(hash: string): Promise<{ ok: true } | { ok: false; paused: SyncPauseReason } | null> {
    const entry = this.docs.get(hash);
    if (!entry) return null;
    if (entry.pauseReason) return { ok: false, paused: entry.pauseReason };
    await this.run(entry);
    return entry.pauseReason ? { ok: false, paused: entry.pauseReason } : { ok: true };
  }

  async applyPendingDeletions(hash: string): Promise<number> {
    const entry = this.docs.get(hash);
    if (!entry) return -1;
    const count = entry.engine.pendingDeletionCount;
    if (count === 0) return 0;
    await this.guarded(entry, () => entry.engine.confirmPendingDeletions());
    return count;
  }

  async undoLastSync(hash: string): Promise<boolean | null> {
    const entry = this.docs.get(hash);
    if (!entry) return null;
    // Recovery must work even when sync errored, so it bypasses the breaker.
    // Errors propagate to the command, which reports them.
    const restored = await entry.engine.restoreLastSnapshot();
    if (restored) this.pauseAfterRecovery(entry, "undo");
    return restored;
  }

  async preSyncBackupCounts(hash: string): Promise<{ backup: number; current: number } | null> {
    return this.docs.get(hash)?.engine.preSyncBackupCounts() ?? null;
  }

  async restorePreSync(hash: string): Promise<boolean | null> {
    const entry = this.docs.get(hash);
    if (!entry) return null;
    const restored = await entry.engine.restorePreSyncBackup();
    if (restored) this.pauseAfterRecovery(entry, "restore");
    return restored;
  }

  /** Resume after any pause, errors included. An errored engine is replaced by a fresh one. */
  async resume(hash: string): Promise<boolean> {
    const entry = this.docs.get(hash);
    if (!entry) return false;
    if (entry.pauseReason === "error" || entry.engine.isStopped || this.breaker.isBlocked(hash)) {
      this.breaker.clear(hash);
      entry.engine.stop();
      entry.engine = this.makeEngine(entry.workspace, hash); // reloads its state from disk
    }
    entry.pauseReason = null;
    entry.governor.reset();
    entry.externalChange = true; // a resume after undo publishes the restored state on purpose
    await this.guarded(entry, () => entry.engine.resume());
    return entry.pauseReason === null;
  }

  private pauseAfterRecovery(entry: DocEntry, reason: "undo" | "restore"): void {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    // Keep "error" visible if sync had failed; resume handles both.
    if (entry.pauseReason !== "error") entry.pauseReason = reason;
  }

  private makeEngine(workspace: AnnotationSetWorkspace, hash: string): DocSyncEngine {
    return new DocSyncEngine({
      adapter: this.app.vault.adapter as any,
      workspace,
      docHash: hash,
      syncRoot: this.syncRoot,
      localRoot: SYNC_LOCAL_ROOT,
      identity: this.identity,
      isEditing: isEditingAnnotation,
      notify: (message) => new Notice(message, 12000),
    });
  }


  // ------------------------------------------------------------------

  private onVaultPath(path: string): void {
    const prefix = `${this.syncRoot}/`;
    if (!path.startsWith(prefix)) return;
    const [hash, file] = path.slice(prefix.length).split("/");
    if (!hash || !file) return;
    if (file === `${this.identity.get()}.md`) return; // our own write
    const entry = this.docs.get(hash);
    if (entry) this.schedule(entry, REMOTE_CHANGE_DELAY);
  }

  private schedule(entry: DocEntry, delay: number): void {
    if (this.stopped || entry.pauseReason || this.breaker.isBlocked(entry.hash) || entry.engine.isPaused) return;
    delay += entry.governor.extraDelayMs;
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      void this.run(entry);
    }, delay);
  }

  private async run(entry: DocEntry, applyRemote = true): Promise<void> {
    await this.guarded(entry, async () => {
      const report = await entry.engine.sync({ applyRemote });
      const externalChange = entry.externalChange;
      entry.externalChange = false;
      if (!report) return;
      const verdict = entry.governor.record({ workMs: report.workMs, wroteShard: report.wroteShard, externalChange, now: Date.now() });
      if (verdict !== "ok") {
        entry.engine.pause();
        entry.pauseReason = verdict === "pause-slow" ? "slow" : "loop";
        new Notice(
          verdict === "pause-slow"
            ? "PDF Annotator: sync was slowing Obsidian down for this PDF and is paused. Your annotations are unaffected. Run “Resume sync for current PDF” to try again."
            : "PDF Annotator: sync kept rewriting this PDF's sync file without any edits, so it is paused. Your annotations are unaffected. Run “Resume sync for current PDF” to try again.",
          15000
        );
        return;
      }
      if (applyRemote && report.deferred) this.schedule(entry, LOCAL_CHANGE_DELAY);
    });
  }

  private async guarded(entry: DocEntry, fn: () => Promise<unknown>): Promise<void> {
    if (this.stopped || this.breaker.isBlocked(entry.hash)) return;
    try {
      await fn();
    } catch (error) {
      console.error("[PDF Annotator] sync failed; annotations keep working without it", error);
      const level = this.breaker.fail(entry.hash);
      entry.engine.stop();
      entry.pauseReason = "error";
      if (level === "all") {
        new Notice("PDF Annotator: sync hit repeated errors and is paused for all PDFs. Your annotations are unaffected. Run “Resume sync for current PDF” to try again; details are in the developer console.", 15000);
        for (const other of this.docs.values()) {
          other.engine.stop();
          other.pauseReason = "error";
        }
      } else {
        new Notice("PDF Annotator: sync failed for this PDF and is paused. Your annotations are unaffected. Run “Resume sync for current PDF” to try again.", 12000);
      }
    }
  }

  private dispose(entry: DocEntry): void {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    entry.unsubscribe();
    entry.engine.stop();
  }
}
