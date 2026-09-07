/** Pure bundle identity helpers, kept independent of Obsidian for testing. */

export const PDF_BUNDLE_LIBRARY = ".pdf-annotator/bundles/sha256";

export interface PdfBundlePaths {
  id: string;
  rootPath: string;
  backupPath: string;
  annotationPath: string;
  annotationBackupPath: string;
  annotationSetsRootPath: string;
  annotationSetsIndexPath: string;
  aiJobsRootPath: string;
  manifestPath: string;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function pathsForHash(hash: string): PdfBundlePaths {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid PDF bundle SHA-256.");
  const rootPath = `${PDF_BUNDLE_LIBRARY}/${hash}`;
  return {
    id: hash,
    rootPath,
    backupPath: `${rootPath}/document.pdf`,
    annotationPath: `${rootPath}/annotations.md`,
    annotationBackupPath: `${rootPath}/annotations.previous.md`,
    annotationSetsRootPath: `${rootPath}/annotation-sets`,
    annotationSetsIndexPath: `${rootPath}/annotation-sets/index.json`,
    aiJobsRootPath: `${rootPath}/ai-jobs`,
    manifestPath: `${rootPath}/manifest.json`,
  };
}
