import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = mkdtempSync(path.join(tmpdir(), "local-pdf-annotator-tests-"));
const tests = [
  { entry: "test/annotation-export-smoke.ts", alias: { obsidian: path.join(root, "test/obsidian-stub.ts") } },
  { entry: "test/anchored-panel-smoke.ts" },
  { entry: "test/model-shortlist-smoke.ts" },
  { entry: "test/ai-modal-smoke.ts", alias: { obsidian: path.join(root, "test/obsidian-stub.ts") } },
  { entry: "test/margin-card-smoke.ts" },
  { entry: "test/pdf-data-smoke.ts" },
  { entry: "test/bundle-identity-smoke.ts" },
  {
    entry: "test/bundle-manager-smoke.ts",
    alias: { obsidian: path.join(root, "test/obsidian-stub.ts") },
  },
  {
    entry: "test/annotation-sets-smoke.ts",
    alias: { obsidian: path.join(root, "test/obsidian-stub.ts") },
  },
  {
    entry: "test/reliability-smoke.ts",
    alias: { obsidian: path.join(root, "test/obsidian-stub.ts") },
  },
];

try {
  for (const test of tests) {
    const outfile = path.join(outputDir, `${path.basename(test.entry, ".ts")}.cjs`);
    await build({
      absWorkingDir: root,
      entryPoints: [test.entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      alias: test.alias,
      logLevel: "silent",
    });
    const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
