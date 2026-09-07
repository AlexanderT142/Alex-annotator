/** Multi-set persistence layered over the existing AnnotationStore format. */
import type { DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";
import {
  AnnotationStore,
  newId,
  serializeAnnotations,
  parseAnnotations,
  type AnnotationDoc,
  type Highlight,
} from "./annotations";

export type AnnotationSetKind = "manual" | "import" | "ai";

export interface AnnotationSetMeta {
  id: string;
  name: string;
  kind: AnnotationSetKind;
  accent: string;
  created: string;
  updated: string;
  archived?: boolean;
}

export interface AnnotationSetIndex {
  version: 1;
  activeSetId: string;
  visibleSetIds: string[];
  sets: AnnotationSetMeta[];
}

export interface AnnotationSetOpenOptions {
  adapter: DataAdapter;
  setsRootPath: string;
  indexPath: string;
  legacyAnnotationPath: string;
  legacyAnnotationBackupPath?: string;
  legacyFallbackPaths?: string[];
  pdfBasename: string;
  pdfVaultPath: string;
  fingerprint?: string;
}

const SET_ACCENTS = ["#7c5cff", "#2383e2", "#d97706", "#c026d3", "#059669", "#dc2626"];

function validIndex(value: unknown): value is AnnotationSetIndex {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<AnnotationSetIndex>;
  return (
    v.version === 1 &&
    typeof v.activeSetId === "string" &&
    Array.isArray(v.visibleSetIds) &&
    Array.isArray(v.sets) &&
    v.sets.length > 0 &&
    v.sets.every((set) =>
      !!set &&
      typeof set.id === "string" && /^[a-zA-Z0-9_-]+$/.test(set.id) &&
      typeof set.name === "string" &&
      (set.kind === "manual" || set.kind === "import" || set.kind === "ai")
    ) && new Set(v.sets.map((set) => set.id)).size === v.sets.length &&
    v.sets.some((set) => !set.archived)
  );
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled set";
}

export class AnnotationSetWorkspace {
  private static pool = new WeakMap<DataAdapter, Map<string, Promise<AnnotationSetWorkspace>>>();
  private references = 0;
  private pooled = true;
  private indexWrites: Promise<void> = Promise.resolve();
  readonly recoveryMessages: string[] = [];
  private stores = new Map<string, AnnotationStore>();
  private index!: AnnotationSetIndex;
  private pdfBasename: string;
  private pdfVaultPath: string;
  private fingerprint?: string;
  private listeners = new Set<() => void>();

  private constructor(private options: AnnotationSetOpenOptions) {
    this.pdfBasename = options.pdfBasename;
    this.pdfVaultPath = options.pdfVaultPath;
    this.fingerprint = options.fingerprint;
  }

  static async open(options: AnnotationSetOpenOptions): Promise<AnnotationSetWorkspace> {
    let entries = this.pool.get(options.adapter);
    if (!entries) this.pool.set(options.adapter, entries = new Map());
    const key = normalizePath(options.indexPath);
    let pending = entries.get(key);
    if (!pending) {
      pending = (async () => {
        const workspace = new AnnotationSetWorkspace(options);
        await workspace.load();
        return workspace;
      })();
      entries.set(key, pending);
      void pending.catch(() => { if (entries!.get(key) === pending) entries!.delete(key); });
    }
    const workspace = await pending;
    workspace.retain();
    return workspace;
  }

  retain(): void { this.references++; }

  async release(): Promise<void> {
    this.references = Math.max(0, this.references - 1);
    await this.flush();
    await this.indexWrites;
    if (this.references === 0 && this.pooled) {
      this.pooled = false;
      AnnotationSetWorkspace.pool.get(this.options.adapter)?.delete(normalizePath(this.options.indexPath));
    }
  }

  /** Compatibility surface consumed by both existing PDF views. */
  get doc(): AnnotationDoc {
    const visible = new Set(this.index.visibleSetIds);
    const highlights: Highlight[] = [];
    for (const meta of this.index.sets) {
      if (meta.archived || !visible.has(meta.id)) continue;
      const store = this.stores.get(meta.id);
      if (!store) continue;
      for (const h of store.doc.highlights) {
        h.setId = meta.id;
        highlights.push(h);
      }
    }
    return {
      version: 1,
      pdf: this.pdfVaultPath,
      fingerprint: this.fingerprint,
      highlights,
    };
  }

  listSets(): AnnotationSetMeta[] {
    return this.index.sets.filter((set) => !set.archived).map((set) => ({ ...set }));
  }

  activeSet(): AnnotationSetMeta {
    return (
      this.index.sets.find((set) => set.id === this.index.activeSetId && !set.archived) ??
      this.index.sets.find((set) => !set.archived)!
    );
  }

  isVisible(setId: string): boolean {
    return this.index.visibleSetIds.includes(setId);
  }

  setMeta(setId: string | undefined): AnnotationSetMeta | null {
    if (!setId) return null;
    const meta = this.index.sets.find((set) => set.id === setId);
    return meta ? { ...meta } : null;
  }

  byPage(page: number): Highlight[] {
    return this.doc.highlights.filter((h) => h.page === page);
  }

  highlightsForSet(setId: string): Highlight[] {
    return [...this.requireStore(setId).doc.highlights];
  }

  /** Visibility controls reading, not whether a current set belongs in an export. */
  exportMarkdown(): string {
    const sets = this.listSets().map(({ id, name }) => ({ id, name }));
    const doc: AnnotationDoc = {
      version: 1,
      pdf: this.pdfVaultPath,
      fingerprint: this.fingerprint,
      highlights: sets.flatMap((set) => this.highlightsForSet(set.id).map((h) => ({ ...h, setId: set.id }))),
    };
    return serializeAnnotations(doc, this.pdfBasename, sets);
  }

  get(id: string): Highlight | undefined {
    for (const [setId, store] of this.stores) {
      const found = store.get(id);
      if (found) {
        found.setId = setId;
        return found;
      }
    }
    return undefined;
  }

  add(h: Highlight): void {
    this.addToSet(this.activeSet().id, [h]);
  }

  addMany(highlights: Highlight[]): void {
    this.addToSet(this.activeSet().id, highlights);
  }

  addToSet(setId: string, highlights: Highlight[]): void {
    const store = this.requireStore(setId);
    for (const h of highlights) h.setId = setId;
    store.addMany(highlights);
    this.emit();
  }

  remove(id: string): void {
    const owner = this.ownerOf(id);
    if (!owner) return;
    owner.remove(id);
    this.emit();
  }

  update(id: string, patch: Partial<Highlight>): void {
    const owner = this.ownerOf(id);
    if (!owner) return;
    owner.update(id, patch);
    this.emit();
  }

  async createSet(name: string, kind: AnnotationSetKind = "manual"): Promise<AnnotationSetMeta> {
    const now = new Date().toISOString();
    let id = newId();
    while (this.stores.has(id)) id = newId();
    const meta: AnnotationSetMeta = {
      id,
      name: cleanName(name),
      kind,
      accent: SET_ACCENTS[this.index.sets.length % SET_ACCENTS.length],
      created: now,
      updated: now,
    };
    this.index.sets.push(meta);
    this.index.activeSetId = id;
    this.index.visibleSetIds = Array.from(new Set([...this.index.visibleSetIds, id]));
    const store = this.makeStore(meta);
    this.stores.set(id, store);
    await this.writeEmptySet(meta);
    await this.saveIndex();
    this.emit();
    return { ...meta };
  }

  async renameSet(setId: string, name: string): Promise<void> {
    const meta = this.requireMeta(setId);
    meta.name = cleanName(name);
    meta.updated = new Date().toISOString();
    this.requireStore(setId).setPdfPath(this.pdfVaultPath, `${this.pdfBasename} — ${meta.name}`);
    await this.flush();
    await this.saveIndex();
    this.emit();
  }

  async archiveSet(setId: string): Promise<void> {
    const activeSets = this.index.sets.filter((set) => !set.archived);
    if (activeSets.length <= 1) throw new Error("The last annotation set cannot be archived.");
    const meta = this.requireMeta(setId);
    meta.archived = true;
    meta.updated = new Date().toISOString();
    this.index.visibleSetIds = this.index.visibleSetIds.filter((id) => id !== setId);
    if (this.index.activeSetId === setId) {
      const next = this.index.sets.find((set) => !set.archived && set.id !== setId)!;
      this.index.activeSetId = next.id;
      if (!this.index.visibleSetIds.includes(next.id)) this.index.visibleSetIds.push(next.id);
    }
    await this.saveIndex();
    this.emit();
  }

  async setActive(setId: string): Promise<void> {
    this.requireMeta(setId);
    this.index.activeSetId = setId;
    if (!this.index.visibleSetIds.includes(setId)) this.index.visibleSetIds.push(setId);
    await this.saveIndex();
    this.emit();
  }

  async setVisible(setId: string, visible: boolean): Promise<void> {
    this.requireMeta(setId);
    const ids = new Set(this.index.visibleSetIds);
    if (visible) ids.add(setId);
    else ids.delete(setId);
    this.index.visibleSetIds = [...ids];
    await this.saveIndex();
    this.emit();
  }

  async showOnly(setId: string): Promise<void> {
    this.requireMeta(setId);
    this.index.visibleSetIds = [setId];
    await this.saveIndex();
    this.emit();
  }

  setPdfPath(pdfVaultPath: string, pdfBasename: string): void {
    this.pdfVaultPath = pdfVaultPath;
    this.pdfBasename = pdfBasename;
    for (const store of this.stores.values()) store.setPdfPath(pdfVaultPath, pdfBasename);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async load(): Promise<void> {
    const { adapter, indexPath } = this.options;
    let loaded: AnnotationSetIndex | null = null;
    for (const path of [indexPath, this.indexBackupPath()]) {
      if (!(await adapter.exists(path))) continue;
      try {
        const raw = await adapter.read(path);
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { /* Invalid JSON is preserved below. */ }
        if (validIndex(parsed)) {
          loaded = parsed;
          if (path !== indexPath) this.recoveryMessages.push("Recovered annotation sets from the registry backup.");
          break;
        }
        await adapter.write(`${path}.damaged-${Date.now()}-${newId()}`, raw);
        this.recoveryMessages.push("Preserved a damaged annotation registry and recovered available sets.");
      } catch {
        throw new Error("Could not read or preserve the annotation registry. Existing files were left untouched; reopen the PDF to retry.");
      }
    }

    if (!loaded) {
      const now = new Date().toISOString();
      loaded = {
        version: 1,
        activeSetId: "default",
        visibleSetIds: ["default"],
        sets: [
          {
            id: "default",
            name: "My notes",
            kind: "manual",
            accent: SET_ACCENTS[0],
            created: now,
            updated: now,
          },
        ],
      };
    }
    this.index = loaded;

    // A backup may predate the newest set. Reconcile every surviving sidecar
    // instead of silently orphaning files which are absent from the registry.
    if (await adapter.exists(this.options.setsRootPath)) {
      const listing = await adapter.list(this.options.setsRootPath);
      for (const path of listing.files) {
        const id = path.split("/").pop()?.match(/^([a-zA-Z0-9_-]+)(?:\.previous)?\.md$/)?.[1];
        if (!id || loaded.sets.some((set) => set.id === id)) continue;
        const raw = await adapter.read(path);
        const doc = parseAnnotations(raw);
        if (!doc) continue;
        const heading = raw.match(/^# Annotations — (.+)$/m)?.[1];
        const prefix = `${this.pdfBasename} — `;
        const name = heading?.startsWith(prefix) ? heading.slice(prefix.length) : `Recovered set ${id}`;
        const now = new Date().toISOString();
        loaded.sets.push({ id, name: cleanName(name), kind: doc.highlights.some((h) => h.source === "ai") ? "ai" : "manual", accent: SET_ACCENTS[loaded.sets.length % SET_ACCENTS.length], created: now, updated: now });
        loaded.visibleSetIds.push(id);
        this.recoveryMessages.push(`Recovered annotation set “${name}” from its saved notes.`);
      }
    }

    for (const meta of this.index.sets) {
      const migrateLegacy = meta.id === "default" && !(await adapter.exists(this.setPath(meta.id)));
      const store = this.makeStore(meta, migrateLegacy);
      this.stores.set(meta.id, store);
      await store.load();
      for (const h of store.doc.highlights) h.setId = meta.id;
      if (migrateLegacy && !(await adapter.exists(this.setPath(meta.id)))) {
        await this.writeEmptySet(meta);
      }
    }
    if (!this.index.sets.some((set) => set.id === this.index.activeSetId && !set.archived)) {
      this.index.activeSetId = this.index.sets.find((set) => !set.archived)!.id;
    }
    this.index.visibleSetIds = this.index.visibleSetIds.filter((id) => this.stores.has(id));
    await this.saveIndex();
  }

  private makeStore(meta: AnnotationSetMeta, migrateLegacy = false): AnnotationStore {
    const fallbackPaths = [
      this.setBackupPath(meta.id),
      ...(migrateLegacy
        ? [this.options.legacyAnnotationPath, ...(this.options.legacyAnnotationBackupPath ? [this.options.legacyAnnotationBackupPath] : []), ...(this.options.legacyFallbackPaths ?? [])]
        : []),
    ];
    return new AnnotationStore(
      this.options.adapter,
      this.setPath(meta.id),
      `${this.pdfBasename} — ${meta.name}`,
      this.pdfVaultPath,
      this.fingerprint,
      fallbackPaths,
      true,
      this.setBackupPath(meta.id)
    );
  }

  private async writeEmptySet(meta: AnnotationSetMeta): Promise<void> {
    const path = this.setPath(meta.id);
    if (await this.options.adapter.exists(path)) return;
    await this.ensureFolder(this.options.setsRootPath);
    const doc: AnnotationDoc = {
      version: 1,
      pdf: this.pdfVaultPath,
      fingerprint: this.fingerprint,
      highlights: [],
    };
    await this.options.adapter.write(path, serializeAnnotations(doc, `${this.pdfBasename} — ${meta.name}`));
  }

  private async saveIndex(): Promise<void> {
    const snapshot = JSON.stringify(this.index, null, 2);
    const write = this.indexWrites.catch(() => {}).then(async () => {
      await this.ensureFolder(this.options.setsRootPath);
      const { adapter, indexPath } = this.options;
      if (await adapter.exists(indexPath)) {
        const current = await adapter.read(indexPath);
        let valid = false;
        try { valid = validIndex(JSON.parse(current)); } catch { /* Keep the last good backup. */ }
        if (valid) await adapter.write(this.indexBackupPath(), current);
      }
      await adapter.write(indexPath, snapshot);
    });
    this.indexWrites = write;
    await write;
  }

  private indexBackupPath(): string { return this.options.indexPath.replace(/\.json$/, "") + ".previous.json"; }

  private setPath(setId: string): string {
    return normalizePath(`${this.options.setsRootPath}/${setId}.md`);
  }

  private setBackupPath(setId: string): string {
    return normalizePath(`${this.options.setsRootPath}/${setId}.previous.md`);
  }

  private requireMeta(setId: string): AnnotationSetMeta {
    const meta = this.index.sets.find((set) => set.id === setId && !set.archived);
    if (!meta) throw new Error(`Unknown annotation set: ${setId}`);
    return meta;
  }

  private requireStore(setId: string): AnnotationStore {
    this.requireMeta(setId);
    const store = this.stores.get(setId);
    if (!store) throw new Error(`Annotation set is not loaded: ${setId}`);
    return store;
  }

  private ownerOf(highlightId: string): AnnotationStore | null {
    for (const store of this.stores.values()) if (store.get(highlightId)) return store;
    return null;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async ensureFolder(folder: string): Promise<void> {
    const parts = normalizePath(folder).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const stat = await this.options.adapter.stat(current);
      if (stat?.type === "folder") continue;
      if (stat) throw new Error(`Cannot create ${current}; a file already exists there.`);
      try {
        await this.options.adapter.mkdir(current);
      } catch (error) {
        if ((await this.options.adapter.stat(current))?.type !== "folder") throw error;
      }
    }
  }
}
