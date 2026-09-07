import assert from "node:assert/strict";
import { pathsForHash, sha256Hex } from "../src/bundle-identity";

async function main(): Promise<void> {
  const firstBytes = new TextEncoder().encode("same PDF bytes").buffer;
  const sameBytesAtAnotherPath = new TextEncoder().encode("same PDF bytes").buffer;
  const replacementBytes = new TextEncoder().encode("different PDF bytes").buffer;

  const firstHash = await sha256Hex(firstBytes);
  const movedHash = await sha256Hex(sameBytesAtAnotherPath);
  const replacementHash = await sha256Hex(replacementBytes);

  assert.equal(firstHash, movedHash, "moving/renaming the same PDF must keep its identity");
  assert.notEqual(firstHash, replacementHash, "replacing bytes at one path must create a new identity");

  const paths = pathsForHash(firstHash);
  assert.equal(paths.id, firstHash);
  assert.ok(paths.backupPath.endsWith(`/${firstHash}/document.pdf`));
  assert.ok(paths.annotationPath.endsWith(`/${firstHash}/annotations.md`));
  assert.ok(paths.annotationBackupPath.endsWith(`/${firstHash}/annotations.previous.md`));
  assert.ok(paths.annotationSetsIndexPath.endsWith(`/${firstHash}/annotation-sets/index.json`));
  assert.ok(paths.aiJobsRootPath.endsWith(`/${firstHash}/ai-jobs`));
  assert.ok(!paths.rootPath.includes("Downloads"), "bundle identity must not contain the visible path");
  assert.throws(() => pathsForHash("not-a-hash"));

  console.log("bundle identity smoke test passed");
}

void main();
