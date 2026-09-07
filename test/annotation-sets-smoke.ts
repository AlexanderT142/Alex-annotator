import assert from "node:assert/strict";
import { AnnotationSetWorkspace } from "../src/annotation-sets";
import { serializeAnnotations, type AnnotationDoc, type Highlight } from "../src/annotations";
import { normalizePath } from "./obsidian-stub";

class MemoryAdapter {
  text = new Map<string, string>();
  folders = new Set<string>([""]);

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
    const direct = (candidate: string) =>
      candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/");
    return {
      files: [...this.text.keys()].filter(direct),
      folders: [...this.folders].filter((folder) => folder !== path && direct(folder)),
    };
  }
  async read(path: string): Promise<string> {
    const value = this.text.get(normalizePath(path));
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }
  async write(path: string, value: string): Promise<void> {
    this.text.set(normalizePath(path), value);
  }
  async mkdir(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }
}

function mark(id: string, text: string): Highlight {
  return {
    id,
    page: 4,
    color: "#FBF719",
    text,
    note: `${text} note`,
    rects: [{ x1: 10, y1: 10, x2: 20, y2: 20 }],
    created: "2026-08-29T00:00:00.000Z",
    source: "manual",
  };
}

async function open(adapter: MemoryAdapter): Promise<AnnotationSetWorkspace> {
  return AnnotationSetWorkspace.open({
    adapter: adapter as any,
    setsRootPath: ".pdf-annotator/bundles/sha256/hash/annotation-sets",
    indexPath: ".pdf-annotator/bundles/sha256/hash/annotation-sets/index.json",
    legacyAnnotationPath: ".pdf-annotator/bundles/sha256/hash/annotations.md",
    legacyAnnotationBackupPath: ".pdf-annotator/bundles/sha256/hash/annotations.previous.md",
    pdfBasename: "book",
    pdfVaultPath: "Books/book.pdf",
    fingerprint: "fingerprint",
  });
}

async function main(): Promise<void> {
  const adapter = new MemoryAdapter();
  const legacy: AnnotationDoc = {
    version: 1,
    pdf: "Books/book.pdf",
    fingerprint: "fingerprint",
    highlights: [mark("personal1", "personal quote")],
  };
  await adapter.write(
    ".pdf-annotator/bundles/sha256/hash/annotations.md",
    serializeAnnotations(legacy, "book")
  );

  const workspace = await open(adapter);
  assert.equal(workspace.listSets().length, 1, "legacy document starts with one set");
  assert.equal(workspace.doc.highlights.length, 1, "legacy annotation migrates into My notes");
  assert.ok(
    await adapter.exists(".pdf-annotator/bundles/sha256/hash/annotation-sets/default.md"),
    "migration creates the default set sidecar"
  );
  assert.ok(
    await adapter.exists(".pdf-annotator/bundles/sha256/hash/annotations.md"),
    "migration preserves the legacy sidecar"
  );

  const second = await workspace.createSet("Study partner", "ai");
  workspace.add(mark("study001", "study quote"));
  await workspace.flush();
  assert.equal(workspace.activeSet().id, second.id);
  assert.equal(workspace.doc.highlights.length, 2, "two visible sets compose in one view");
  assert.equal(workspace.get("personal1")?.setId, "default");
  assert.equal(workspace.get("study001")?.setId, second.id);

  await workspace.setVisible("default", false);
  assert.deepEqual(workspace.byPage(4).map((h) => h.id), ["study001"], "visibility filters painting");
  await workspace.setActive("default");
  workspace.add(mark("personal2", "another personal quote"));
  await workspace.setVisible("default", true);
  await workspace.flush();

  await workspace.release();
  const reopened = await open(adapter);
  assert.equal(reopened.listSets().length, 2, "set registry survives reload");
  assert.equal(reopened.highlightsForSet("default").length, 2, "writes route to the active set");
  assert.equal(reopened.highlightsForSet(second.id).length, 1, "parallel set remains isolated");
  assert.equal(reopened.doc.highlights.length, 3, "both visible sets survive reload");
  await reopened.release();

  console.log("annotation set smoke test passed");
}

void main();
