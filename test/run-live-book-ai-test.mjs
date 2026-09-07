import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = mkdtempSync(path.join(tmpdir(), "local-pdf-annotator-live-ai-test-"));
try {
  const outfile = path.join(outputDir, "live-book-ai-smoke.cjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["test/live-book-ai-smoke.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { obsidian: path.join(root, "test/obsidian-stub.ts") },
    external: ["canvas", "pdfjs-dist/legacy/build/pdf.js"],
    logLevel: "silent",
  });
  const result = spawnSync(process.execPath, [outfile], {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
