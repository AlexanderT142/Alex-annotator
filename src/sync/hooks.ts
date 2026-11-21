/**
 * The only link from the core views to the sync add-on. With sync off no hook
 * is registered and these calls do nothing. A failing hook is logged and
 * swallowed: it can never stop a PDF from opening or closing.
 */
import type { AnnotationSetWorkspace } from "../annotation-sets";

export interface WorkspaceSyncHook {
  attach(workspace: AnnotationSetWorkspace, docHash: string): void;
  detach(workspace: AnnotationSetWorkspace, docHash: string): void;
}

let hook: WorkspaceSyncHook | null = null;

export function setWorkspaceSyncHook(next: WorkspaceSyncHook | null): void {
  hook = next;
}

export function notifyWorkspaceOpened(workspace: AnnotationSetWorkspace, docHash: string | null | undefined): void {
  if (!hook || !docHash) return;
  try {
    hook.attach(workspace, docHash);
  } catch (error) {
    console.error("[PDF Annotator] sync could not attach; annotations work normally without it", error);
  }
}

export function notifyWorkspaceClosed(workspace: AnnotationSetWorkspace, docHash: string | null | undefined): void {
  if (!hook || !docHash) return;
  try {
    hook.detach(workspace, docHash);
  } catch (error) {
    console.error("[PDF Annotator] sync could not detach", error);
  }
}
