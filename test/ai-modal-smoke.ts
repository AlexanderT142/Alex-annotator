import assert from "node:assert/strict";
import { AiAnnotationModal } from "../src/ai-ui";
import { AnnotationSetWorkspace } from "../src/annotation-sets";
import { MemoryAdapter } from "./memory-adapter";
import { DEFAULT_AI_SETTINGS } from "../src/ai-provider";
import { Notice } from "./obsidian-stub";

async function main(): Promise<void> {
  const adapter = new MemoryAdapter();
  const workspace = await AnnotationSetWorkspace.open({
    adapter: adapter as any, setsRootPath: "book/sets", indexPath: "book/sets/index.json",
    legacyAnnotationPath: "book/annotations.md", pdfBasename: "book", pdfVaultPath: "book.pdf",
  });
  const target = await workspace.createSet("Translation", "manual");
  await workspace.setActive("default");
  await workspace.setVisible(target.id, false);
  const before = workspace.listSets();
  let started: any;
  let released!: () => void;
  const gate = new Promise<void>((resolve) => { released = resolve; });
  let starts = 0;
  const modal: any = new AiAnnotationModal({ vault: { adapter } } as any, {
    workspace, pdfDoc: { numPages: 171 }, jobsRootPath: "book/jobs",
    getConnection: () => ({ ...DEFAULT_AI_SETTINGS, apiKey: "unit-test-only" }),
    // This spy checks UI dispatch only: no transport or fabricated AI response.
    jobService: { start: async (_context: any, options: any) => { starts++; started = options; await gate; } } as any,
    changed: () => {},
  });
  modal.render = () => {};
  modal.setId = target.id;
  modal.fromPage = 20;
  modal.toPage = 29;
  modal.prompt = "Translate one passage.";
  workspace.createSet = async () => { throw new Error("AI dialog must never create a set"); };
  const pending = modal.start();
  await modal.start();
  assert.equal(starts, 1, "double-click does not dispatch a second job");
  released();
  await pending;
  assert.deepEqual(started, { setId: target.id, setName: "Translation", fromPage: 20, toPage: 29, prompt: "Translate one passage." });
  assert.deepEqual(workspace.listSets(), before, "AI dispatch leaves registry unchanged");
  assert.equal(workspace.activeSet().id, "default");
  assert.equal(workspace.isVisible(target.id), false, "AI dispatch does not change visibility");
  await workspace.archiveSet(target.id);
  await modal.start();
  assert.equal(starts, 1, "archived destination cannot start a job");
  assert.match(Notice.messages.at(-1)!, /existing, non-archived/);
  await workspace.release();
  console.log("AI dialog smoke: existing-set dispatch, no set creation, active/visible preservation, duplicate click and archived target passed");
}
void main();
