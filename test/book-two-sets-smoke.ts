import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.js";
import { AnnotationSetWorkspace } from "../src/annotation-sets";
import { parseAnnotations, type Highlight } from "../src/annotations";
import { anchorQuoteOnPage, buildDocIndexRange, plainTextForPage } from "../src/anchor";

const fixture = process.env.LPA_BOOK_FIXTURE;

class FsAdapter {
  constructor(private root: string) {}
  private full(p: string): string {
    return path.join(this.root, p);
  }
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
  async read(p: string): Promise<string> {
    return readFile(this.full(p), "utf8");
  }
  async write(p: string, value: string): Promise<void> {
    await mkdir(path.dirname(this.full(p)), { recursive: true });
    await writeFile(this.full(p), value, "utf8");
  }
  async mkdir(p: string): Promise<void> {
    await mkdir(this.full(p));
  }
}

function markFor(item: any, page: number, id: string, note: string, color: string): Highlight {
  const transform = item.transform as number[];
  const height = Number(item.height || Math.abs(transform[3]) || 10);
  const x = Number(transform[4]);
  const y = Number(transform[5]);
  return {
    id,
    page,
    color,
    style: "comment",
    text: String(item.str).replace(/\s+/g, " ").trim(),
    note,
    rects: [{ x1: x, y1: y - height * 0.18, x2: x + Number(item.width || 10), y2: y + height * 0.9 }],
    created: new Date().toISOString(),
    source: "manual",
  };
}

async function main(): Promise<void> {
  assert.ok(fixture, "Set LPA_BOOK_FIXTURE to a non-vault PDF copy for the book test");
  const temp = await mkdtemp(path.join(os.tmpdir(), "lpa-two-sets-"));
  try {
    GlobalWorkerOptions.workerSrc = path.join(
      process.cwd(),
      "node_modules/pdfjs-dist/legacy/build/pdf.worker.js"
    );
    const bytes = new Uint8Array(await readFile(fixture));
    const pdf = await getDocument({ data: bytes }).promise;
    const selected: Array<{ page: number; item: any }> = [];
    for (let pageNumber = 20; pageNumber <= 29; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const item = content.items.find((candidate: any) =>
        typeof candidate.str === "string" && candidate.str.replace(/\s+/g, " ").trim().length >= 12
      );
      assert.ok(item, `fixture page ${pageNumber} must contain selectable text`);
      selected.push({ page: pageNumber - 1, item });
    }
    assert.equal(selected.length, 10, "fixture must provide ten text pages");
    const index = await buildDocIndexRange(pdf, 19, 28);
    for (let page = 19; page <= 28; page++) {
      const text = plainTextForPage(index, page);
      const quote = text.slice(60, 420);
      assert.equal(anchorQuoteOnPage(index, page, quote).length, 1, `page ${page + 1} real text anchors exactly`);
      const invented = quote.slice(0, 90) + "A COMPLETELY INVENTED CLAIM THAT IS NOT IN THIS BOOK" + quote.slice(-90);
      assert.equal(anchorQuoteOnPage(index, page, invented).length, 0, `page ${page + 1} rejects fabricated middle text`);
    }

    const adapter = new FsAdapter(temp);
    const options = {
      adapter: adapter as any,
      setsRootPath: "bundle/annotation-sets",
      indexPath: "bundle/annotation-sets/index.json",
      legacyAnnotationPath: "bundle/annotations.md",
      pdfBasename: "Economic and Philosophic Manuscripts of 1844",
      pdfVaultPath: "Books/economic-and-philosophic-manuscripts-of-1844.pdf",
      fingerprint: "book-fixture",
    };
    const workspace = await AnnotationSetWorkspace.open(options);
    for (let i = 0; i < selected.length; i++) {
      const { page, item } = selected[i];
      workspace.add(markFor(item, page, `mine${i}`, `Personal note ${i + 1}`, "#FBF719"));
    }
    const second = await workspace.createSet("Parallel reading", "manual");
    for (let i = 0; i < selected.length; i++) {
      const { page, item } = selected[i];
      workspace.add(markFor(item, page, `peer${i}`, `Parallel note ${i + 1}`, "rgba(72, 158, 255, 0.42)"));
    }
    await workspace.flush();
    await workspace.release();

    const reopened = await AnnotationSetWorkspace.open(options);
    assert.equal(reopened.highlightsForSet("default").length, 10);
    assert.equal(reopened.highlightsForSet(second.id).length, 10);
    for (const { page } of selected) {
      assert.equal(reopened.byPage(page).length, 2, `page ${page + 1} should show both sets`);
    }
    await reopened.setVisible(second.id, false);
    const exported = reopened.exportMarkdown();
    assert.ok(exported.includes("## My notes") && exported.includes("## Parallel reading"));
    assert.equal(parseAnnotations(exported)?.highlights.length, 20, "real-book export includes both sets across the same ten pages");
    assert.ok(exported.includes("Personal note 10") && exported.includes("Parallel note 10"));
    await reopened.release();
    console.log(`book two-set smoke test passed on pages ${selected.map(({ page }) => page + 1).join(", ")}`);
    await pdf.destroy();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

void main();
