/**
 * The only link from the core views to the sync add-on. With sync off no hook
 * is registered and these calls do nothing. A failing hook is logged and
 * swallowed: it can never stop a PDF from opening or closing.
 */
import type { AnnotationSetWorkspace } from "../annotation-sets";

export interface WorkspaceSyncHook {
  attach(workspace: AnnotationSetWorkspace, docHash: string): void;
  detach(workspace: AnnotationSetWorkspace, docHash: string): void;
  /** This computer's sync id, used only to label kept conflict versions. */
  deviceId?(): string;
}

let hook: WorkspaceSyncHook | null = null;

export function setWorkspaceSyncHook(next: WorkspaceSyncHook | null): void {
  hook = next;
}

/** This computer's sync id while sync is running, otherwise null. */
export function currentSyncDeviceId(): string | null {
  try {
    return hook?.deviceId?.() ?? null;
  } catch {
    return null;
  }
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
