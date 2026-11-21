import { AnnotationSetWorkspace } from "../src/annotation-sets";
import type { Highlight } from "../src/annotations";
import { DocSyncEngine, type DeviceIdentity, type EngineOptions } from "../src/sync/engine";
import { baselineHighlightOf, baselineSetOf } from "../src/sync/records";
import { stableStringify } from "../src/sync/util";
import { normalizePath } from "./obsidian-stub";

export const HASH = "a".repeat(64);
export const SYNC_ROOT = "_pdf-annotator-sync";
export const LOCAL_ROOT = ".pdf-annotator/sync";
export const SHARD_DIR = `${SYNC_ROOT}/${HASH}`;

export class Mem {
  text = new Map<string, string>();
  folders = new Set<string>([""]);
  writes: string[] = [];
  failWrites = false;
  async exists(path: string): Promise<boolean> {
    path = normalizePath(path);
    return this.text.has(path) || this.folders.has(path);
  }
  async stat(path: string): Promise<any> {
    path = normalizePath(path);
    if (this.folders.has(path)) return { type: "folder", size: 0 };
    if (this.text.has(path)) return { type: "file", size: this.text.get(path)!.length };
    return null;
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    path = normalizePath(path);
    const prefix = path ? `${path}/` : "";
    const direct = (c: string) => c.startsWith(prefix) && !c.slice(prefix.length).includes("/");
    return { files: [...this.text.keys()].filter(direct), folders: [...this.folders].filter((f) => f !== path && direct(f)) };
  }
  async read(path: string): Promise<string> {
    const v = this.text.get(normalizePath(path));
    if (v === undefined) throw new Error(`Missing ${path}`);
    return v;
  }
  failPaths?: (path: string) => boolean;
  async write(path: string, value: string): Promise<void> {
    if (this.failWrites || this.failPaths?.(normalizePath(path))) throw new Error("disk full");
    path = normalizePath(path);
    this.writes.push(path);
    this.text.set(path, value);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
  }
  async mkdir(path: string): Promise<void> { this.folders.add(normalizePath(path)); }
  async remove(path: string): Promise<void> { this.text.delete(normalizePath(path)); }
  shardFiles(): string[] { return [...this.text.keys()].filter((p) => p.startsWith(`${SHARD_DIR}/`)).sort(); }
  shardWrites(): number { return this.writes.filter((p) => p.startsWith(`${SYNC_ROOT}/`)).length; }
}

export class MemIdentity implements DeviceIdentity {
  nonces = new Map<string, string>();
  constructor(public id: string) {}
  get(): string { return this.id; }
  regenerate(): string { this.id = `${this.id}_r${Math.floor(Math.random() * 1e6)}`; return this.id; }
  getNonce(path: string): string | null { return this.nonces.get(path) ?? null; }
  setNonce(path: string, nonce: string): void { this.nonces.set(path, nonce); }
}

export interface Device {
  name: string;
  fs: Mem;
  ws: AnnotationSetWorkspace;
  engine: DocSyncEngine;
  identity: MemIdentity;
  clock: { now: number };
  notices: string[];
  editing: boolean;
}

export async function openWorkspace(fs: Mem): Promise<AnnotationSetWorkspace> {
  const root = `.pdf-annotator/bundles/sha256/${HASH}`;
  return AnnotationSetWorkspace.open({
    adapter: fs as any,
    setsRootPath: `${root}/annotation-sets`,
    indexPath: `${root}/annotation-sets/index.json`,
    legacyAnnotationPath: `${root}/annotations.md`,
    pdfBasename: "Book",
    pdfVaultPath: "Book.pdf",
  });
}

export async function makeDevice(name: string, extra: Partial<EngineOptions> = {}, fs = new Mem()): Promise<Device> {
  const ws = await openWorkspace(fs);
  const identity = new MemIdentity(`dev_${name}`);
  const clock = { now: 1_800_000_000_000 };
  const notices: string[] = [];
  const device: Device = { name, fs, ws, identity, clock, notices, editing: false, engine: null as any };
  device.engine = new DocSyncEngine({
    adapter: fs,
    workspace: ws,
    docHash: HASH,
    syncRoot: SYNC_ROOT,
    localRoot: LOCAL_ROOT,
    identity,
    now: () => clock.now,
    isEditing: () => device.editing,
    notify: (m) => notices.push(m),
    retryDelays: [0, 0, 0],
    sleep: async () => {},
    ...extra,
  });
  return device;
}

/** Copy every shard file from one device's vault to another's (a sync tool). */
export function deliver(from: Device, to: Device, only?: string[]): void {
  for (const path of from.fs.shardFiles()) {
    if (only && !only.some((o) => path.includes(o))) continue;
    const content = from.fs.text.get(path)!;
    // A sync tool never delivers our own file back over a newer local write.
    if (to.fs.text.has(path) && path.endsWith(`/${to.identity.get()}.md`)) continue;
    void to.fs.write(path, content);
    to.fs.writes.pop(); // deliveries are not writes by the receiving device
  }
}

export function deliverAll(devices: Device[]): void {
  for (const a of devices) for (const b of devices) if (a !== b) deliver(a, b);
}

export async function settle(devices: Device[], rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const d of devices) await d.engine.sync();
    deliverAll(devices);
  }
}

export function stateOf(d: Device): string {
  const snap = d.ws.syncSnapshot();
  const sets = Object.fromEntries(snap.sets.map((s) => [s.id, baselineSetOf(s)]).map(([id, s]: any) => [id, { ...s, created: undefined }]));
  const highlights = Object.fromEntries(snap.highlights.map((h) => [h.id, baselineHighlightOf(h)]));
  return stableStringify({ sets, highlights });
}

let counter = 0;
export function mark(id: string, extra: Partial<Highlight> = {}): Highlight {
  counter++;
  return {
    id,
    page: 2,
    color: "#FBF719",
    text: `quote ${id}`,
    rects: [{ x1: 10, y1: 10 + counter, x2: 20, y2: 20 }],
    created: "2026-08-29T00:00:00.000Z",
    source: "manual",
    ...extra,
  };
}

export function noteOf(d: Device, id: string): string | undefined {
  return d.ws.syncSnapshot().highlights.find((h) => h.id === id)?.note;
}

export function has(d: Device, id: string): boolean {
  return d.ws.syncSnapshot().highlights.some((h) => h.id === id);
}
