import assert from "node:assert/strict";
import { AnnotationStore, parseAnnotations, serializeAnnotations, type AnnotationDoc } from "../src/annotations";
import { AnnotationSetWorkspace } from "../src/annotation-sets";
import { PdfBundleManager } from "../src/bundles";
import { TFile, normalizePath } from "./obsidian-stub";

class MemoryAdapter {
  text = new Map<string, string>();
  binary = new Map<string, ArrayBuffer>();
  folders = new Set<string>([""]);

  async exists(path: string): Promise<boolean> {
    path = normalizePath(path);
    return this.text.has(path) || this.binary.has(path) || this.folders.has(path);
  }

  async stat(path: string): Promise<any> {
    path = normalizePath(path);
    if (this.folders.has(path)) return { type: "folder", size: 0, ctime: 0, mtime: 0 };
    if (this.text.has(path)) {
      return { type: "file", size: new TextEncoder().encode(this.text.get(path)).byteLength, ctime: 0, mtime: 0 };
    }
    if (this.binary.has(path)) {
      return { type: "file", size: this.binary.get(path)!.byteLength, ctime: 0, mtime: 0 };
    }
    return null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    path = normalizePath(path);
    const prefix = path ? `${path}/` : "";
    const direct = (candidate: string) => {
      if (!candidate.startsWith(prefix)) return false;
      return !candidate.slice(prefix.length).includes("/");
    };
    return {
      files: [...this.text.keys(), ...this.binary.keys()].filter(direct),
      folders: [...this.folders].filter((folder) => folder !== path && direct(folder)),
    };
  }

  async read(path: string): Promise<string> {
    const value = this.text.get(normalizePath(path));
    if (value === undefined) throw new Error(`Missing text file: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.text.set(normalizePath(path), data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binary.get(normalizePath(path));
    if (!value) throw new Error(`Missing binary file: ${path}`);
    return value.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binary.set(normalizePath(path), data.slice(0));
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }
}

class MemoryVault {
  adapter = new MemoryAdapter();

  getMarkdownFiles(): TFile[] {
    return [...this.adapter.text.keys()]
      .filter((path) => path.endsWith(".md") && !path.startsWith(".pdf-annotator/"))
      .map((path) => new TFile(path));
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.adapter.binary.has(normalizePath(path)) ? new TFile(path) : null;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (await this.adapter.exists(path)) throw new Error(`Already exists: ${path}`);
    await this.adapter.writeBinary(path, data);
    return new TFile(path);
  }
}

async function main(): Promise<void> {
  const vault = new MemoryVault();
  const app = { vault } as any;
  const manager = new PdfBundleManager(app);
  const file = new TFile("Downloads/paper.pdf") as any;
  const originalBytes = new TextEncoder().encode("original PDF").buffer;
  const replacementBytes = new TextEncoder().encode("replacement PDF").buffer;
  await vault.adapter.writeBinary(file.path, originalBytes);

  const legacyPath = "PDF annotations/Downloads/paper.annotations.md";
  const legacyDoc: AnnotationDoc = {
    version: 1,
    pdf: file.path,
    fingerprint: "fingerprint-a",
    highlights: [
      {
        id: "legacy01",
        page: 0,
        color: "#FBF719",
        text: "survives migration",
        rects: [],
        created: "2026-07-17T00:00:00.000Z",
      },
    ],
  };
  await vault.adapter.write(legacyPath, serializeAnnotations(legacyDoc, file.basename));

  const first = await manager.prepare(
    file,
    originalBytes,
    "fingerprint-a",
    { storageMode: "folder", storageFolder: "PDF annotations" }
  );
  assert.ok(await vault.adapter.exists(first.backupPath), "first annotation open creates a PDF backup");
  assert.deepEqual(first.fallbackAnnotationPaths, [legacyPath]);

  const store = new AnnotationStore(
    vault.adapter as any,
    first.annotationPath,
    file.basename,
    file.path,
    "fingerprint-a",
    first.fallbackAnnotationPaths,
    true,
    first.annotationBackupPath
  );
  await store.load();
  assert.equal(store.doc.highlights.length, 1);
  assert.ok(await vault.adapter.exists(first.annotationPath), "legacy annotations migrate immediately");
  assert.ok(await vault.adapter.exists(legacyPath), "migration retains the legacy recovery snapshot");

  store.update("legacy01", { note: "newer state" });
  await store.flush();
  assert.ok(
    await vault.adapter.exists(first.annotationBackupPath),
    "successful updates retain a last-known-good annotation copy"
  );
  await vault.adapter.write(first.annotationPath, "partially written");
  const recoveryStore = new AnnotationStore(
    vault.adapter as any,
    first.annotationPath,
    file.basename,
    file.path,
    "fingerprint-a",
    [first.annotationBackupPath],
    true,
    first.annotationBackupPath
  );
  await recoveryStore.load();
  assert.equal(recoveryStore.doc.highlights.length, 1, "corrupt canonical state recovers from previous");
  assert.ok(
    (await vault.adapter.read(first.annotationPath)).includes('"highlights"'),
    "recovery repairs the canonical sidecar"
  );

  const oldPath = file.path;
  file.setPath("Library/Philosophy/paper-renamed.pdf");
  await manager.onPdfRenamed(file, oldPath);
  const renamedManifest = JSON.parse(await vault.adapter.read(first.manifestPath));
  assert.equal(renamedManifest.currentPath, file.path);
  assert.ok(renamedManifest.aliases.includes(oldPath));
  assert.ok(renamedManifest.aliases.includes(file.path));

  await manager.onPdfDeleted(file.path);
  const deletedManifest = JSON.parse(await vault.adapter.read(first.manifestPath));
  assert.equal(deletedManifest.currentPath, null);
  assert.ok(await vault.adapter.exists(first.backupPath), "deleting the working copy keeps the backup");

  const restored = await manager.restoreBundle(first);
  assert.equal(restored.path, "Recovered PDFs/paper.pdf");
  assert.deepEqual(
    new Uint8Array(await vault.adapter.readBinary(restored.path)),
    new Uint8Array(originalBytes)
  );

  const legacySnapshot = await manager.exportAnnotations(restored as any, "Exports");
  assert.equal(parseAnnotations(await vault.adapter.read(legacySnapshot))?.highlights.length, 1,
    "export migrates a legacy-only bundle without losing its annotations");
  const setOptions = {
    adapter: vault.adapter as any,
    setsRootPath: first.annotationSetsRootPath,
    indexPath: first.annotationSetsIndexPath,
    legacyAnnotationPath: first.annotationPath,
    pdfBasename: restored.basename,
    pdfVaultPath: restored.path,
  };
  const workspace = await AnnotationSetWorkspace.open(setOptions);
  const second = await workspace.createSet("Study partner", "ai");
  workspace.add({ ...legacyDoc.highlights[0], id: "study01", text: "parallel quote", note: "AI commentary", source: "ai" });
  const archived = await workspace.createSet("Old draft");
  workspace.add({ ...legacyDoc.highlights[0], id: "archived01", text: "Archived quote" });
  await workspace.archiveSet(archived.id);
  await workspace.setVisible(second.id, false);
  const activeBefore = workspace.activeSet().id;
  workspace.update("legacy01", { note: "Just edited before autosave" });
  const legacyBefore = await vault.adapter.read(first.annotationPath);
  const exportPath = await manager.exportAnnotations(restored as any, "Exports");
  const exported = await vault.adapter.read(exportPath);
  assert.equal(exportPath, legacySnapshot, "export retains the existing stable destination");
  assert.ok(exported.includes("## My notes") && exported.includes("## Study partner"));
  assert.ok(exported.includes("Just edited before autosave"), "export includes pending live edits");
  assert.ok(exported.includes("parallel quote"), "hidden sets are still exported");
  assert.ok(!exported.includes("Archived quote"), "archived sets are excluded");
  const exportDoc = parseAnnotations(exported)!;
  assert.equal(exportDoc.highlights.length, 2);
  assert.deepEqual((exportDoc as any).annotationSets, [{ id: "default", name: "My notes" }, { id: second.id, name: "Study partner" }]);
  assert.equal(workspace.activeSet().id, activeBefore);
  assert.equal(workspace.isVisible(second.id), false, "export does not alter visibility");
  assert.equal(await vault.adapter.read(first.annotationPath), legacyBefore, "legacy recovery snapshot is untouched");
  await workspace.release();
  vault.adapter.text.delete(first.annotationPath);
  await manager.exportAnnotations(restored as any, "Exports");
  assert.equal(parseAnnotations(await vault.adapter.read(exportPath))?.highlights.length, 2,
    "closed multi-set PDFs export without a legacy single-set file");

  const missingFile = new TFile("unmanaged.pdf");
  await vault.adapter.writeBinary(missingFile.path, new TextEncoder().encode("unmanaged").buffer);
  await assert.rejects(manager.exportAnnotations(missingFile as any, "Exports"), /No managed annotations/);

  const replacementFile = new TFile("Downloads/paper.pdf") as any;
  await vault.adapter.writeBinary(replacementFile.path, replacementBytes);
  const replacement = await manager.prepare(
    replacementFile,
    replacementBytes,
    "fingerprint-b",
    { storageMode: "folder", storageFolder: "PDF annotations" }
  );
  assert.notEqual(first.id, replacement.id, "same path with different bytes creates a new bundle");
  assert.deepEqual(
    replacement.fallbackAnnotationPaths,
    [],
    "a replacement PDF cannot inherit a mismatched legacy sidecar"
  );

  console.log("bundle manager smoke test passed");
}

void main();
