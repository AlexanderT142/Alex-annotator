/**
 * bundles.ts — path-independent, recoverable PDF + annotation persistence.
 *
 * A PDF's SHA-256 is its durable identity. Every document gets one bundle at:
 *
 *   .pdf-annotator/bundles/sha256/<hash>/
 *     document.pdf
 *     annotations.md
 *     manifest.json
 *
 * The visible vault path is metadata only. Moving/renaming a PDF therefore
 * cannot orphan its annotations; replacing a file at the same path with
 * different bytes cannot accidentally inherit somebody else's annotations.
 */
import { App, TFile, normalizePath } from "obsidian";
import {
  legacySidecarPathFor,
  parseAnnotations,
  sidecarPathFor,
  type AnnotationPathOptions,
} from "./annotations";
import { PDF_BUNDLE_LIBRARY, pathsForHash, sha256Hex } from "./bundle-identity";
import { AnnotationSetWorkspace } from "./annotation-sets";

export { PDF_BUNDLE_LIBRARY, sha256Hex } from "./bundle-identity";

export const DEFAULT_RECOVERY_FOLDER = "Recovered PDFs";
const BACKUP_VERIFY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PdfBundleManifest {
  version: 1;
  id: string;
  sha256: string;
  byteLength: number;
  originalName: string;
  currentPath: string | null;
  aliases: string[];
  fingerprint?: string;
  created: string;
  updated: string;
  lastSeen: string;
  lastVerified: string;
}

export interface PdfBundleBinding {
  id: string;
  rootPath: string;
  backupPath: string;
  annotationPath: string;
  annotationBackupPath: string;
  annotationSetsRootPath: string;
  annotationSetsIndexPath: string;
  aiJobsRootPath: string;
  manifestPath: string;
  fallbackAnnotationPaths: string[];
  manifest: PdfBundleManifest;
}

export interface BundleVerification {
  manifest: PdfBundleManifest;
  ok: boolean;
  reason?: string;
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(new Set(paths.filter((path): path is string => !!path).map(normalizePath)));
}

function isManifest(value: unknown): value is PdfBundleManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<PdfBundleManifest>;
  return (
    m.version === 1 &&
    typeof m.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(m.sha256) &&
    typeof m.byteLength === "number" &&
    typeof m.originalName === "string" &&
    Array.isArray(m.aliases)
  );
}

function shouldVerify(lastVerified: string | undefined): boolean {
  if (!lastVerified) return true;
  const time = Date.parse(lastVerified);
  return !Number.isFinite(time) || Date.now() - time >= BACKUP_VERIFY_INTERVAL_MS;
}

export class PdfBundleManager {
  private pendingByHash = new Map<string, Promise<PdfBundleBinding>>();
  private pathToHash = new Map<string, string>();
  private legacyFingerprintIndex: Map<string, string[]> | null = null;

  constructor(private app: App) {}

  /** Create or resolve the stable bundle before annotation state is loaded. */
  async prepare(
    file: TFile,
    pdfData: ArrayBuffer,
    fingerprint: string | undefined,
    legacyPathOptions: AnnotationPathOptions
  ): Promise<PdfBundleBinding> {
    const hash = await sha256Hex(pdfData);
    let pending = this.pendingByHash.get(hash);
    if (!pending) {
      pending = this.ensureBundle(hash, file, pdfData, fingerprint, legacyPathOptions);
      this.pendingByHash.set(hash, pending);
    }

    try {
      const binding = await pending;
      this.pathToHash.set(normalizePath(file.path), hash);
      return await this.touchBinding(binding, file.path, file.name, fingerprint);
    } finally {
      if (this.pendingByHash.get(hash) === pending) this.pendingByHash.delete(hash);
    }
  }

  /** Best-effort metadata sync. Identity and recovery do not depend on it. */
  async onPdfRenamed(file: TFile, oldPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const hash = this.pathToHash.get(normalizedOld);
    if (!hash) return;
    this.pathToHash.delete(normalizedOld);
    this.pathToHash.set(normalizePath(file.path), hash);
    const binding = await this.readBinding(hash);
    if (binding) await this.touchBinding(binding, file.path, file.name, undefined, oldPath);
  }

  /** Keep the recovery bundle after the working PDF is deleted. */
  async onPdfDeleted(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const hash = this.pathToHash.get(normalized);
    if (!hash) return;
    this.pathToHash.delete(normalized);
    const binding = await this.readBinding(hash);
    if (!binding) return;
    const now = new Date().toISOString();
    binding.manifest.currentPath = null;
    binding.manifest.aliases = uniquePaths([...binding.manifest.aliases, normalized]);
    binding.manifest.updated = now;
    await this.writeManifest(binding.manifestPath, binding.manifest);
  }

  async listBundles(): Promise<PdfBundleBinding[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(PDF_BUNDLE_LIBRARY))) return [];
    const listing = await adapter.list(PDF_BUNDLE_LIBRARY);
    const bundles: PdfBundleBinding[] = [];
    for (const folder of listing.folders) {
      const hash = folder.split("/").pop() ?? "";
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      const binding = await this.readBinding(hash);
      if (binding) bundles.push(binding);
    }
    return bundles.sort((a, b) => b.manifest.lastSeen.localeCompare(a.manifest.lastSeen));
  }

  async verifyBundle(binding: PdfBundleBinding): Promise<BundleVerification> {
    const adapter = this.app.vault.adapter;
    try {
      const stat = await adapter.stat(binding.backupPath);
      if (!stat || stat.type !== "file") {
        return { manifest: binding.manifest, ok: false, reason: "backup PDF is missing" };
      }
      if (stat.size !== binding.manifest.byteLength) {
        return { manifest: binding.manifest, ok: false, reason: "backup PDF size changed" };
      }
      const actual = await sha256Hex(await adapter.readBinary(binding.backupPath));
      if (actual !== binding.manifest.sha256) {
        return { manifest: binding.manifest, ok: false, reason: "backup PDF checksum failed" };
      }
      binding.manifest.lastVerified = new Date().toISOString();
      binding.manifest.updated = binding.manifest.lastVerified;
      await this.writeManifest(binding.manifestPath, binding.manifest);
      return { manifest: binding.manifest, ok: true };
    } catch (error: any) {
      return { manifest: binding.manifest, ok: false, reason: error?.message ?? String(error) };
    }
  }

  async restoreBundle(
    binding: PdfBundleBinding,
    recoveryFolder = DEFAULT_RECOVERY_FOLDER
  ): Promise<TFile> {
    const verification = await this.verifyBundle(binding);
    if (!verification.ok) throw new Error(verification.reason ?? "Backup verification failed.");

    const folder = normalizePath(recoveryFolder).replace(/^\/+|\/+$/g, "") || DEFAULT_RECOVERY_FOLDER;
    await this.ensureFolder(folder);
    const desiredName = binding.manifest.originalName.toLowerCase().endsWith(".pdf")
      ? binding.manifest.originalName
      : `${binding.manifest.originalName}.pdf`;
    const targetPath = this.availableRecoveryPath(folder, desiredName);
    const data = await this.app.vault.adapter.readBinary(binding.backupPath);
    const restored = await this.app.vault.createBinary(targetPath, data);
    await this.touchBinding(binding, restored.path, restored.name, binding.manifest.fingerprint);
    return restored;
  }

  /** Write a user-visible snapshot without making that path authoritative. */
  async exportAnnotations(file: TFile, exportFolder: string): Promise<string> {
    const data = await this.app.vault.readBinary(file);
    const hash = await sha256Hex(data);
    const binding = await this.readBinding(hash);
    const adapter = this.app.vault.adapter;
    if (!binding || !(await adapter.exists(binding.annotationPath) || await adapter.exists(binding.annotationSetsRootPath))) {
      throw new Error("No managed annotations exist for this PDF.");
    }
    // Reuse the live workspace so a just-written note is not lost to autosave debounce.
    // Opening a closed PDF also uses the normal legacy migration/recovery path.
    const workspace = await AnnotationSetWorkspace.open({
      adapter,
      setsRootPath: binding.annotationSetsRootPath,
      indexPath: binding.annotationSetsIndexPath,
      legacyAnnotationPath: binding.annotationPath,
      legacyAnnotationBackupPath: binding.annotationBackupPath,
      legacyFallbackPaths: binding.fallbackAnnotationPaths,
      pdfBasename: file.basename,
      pdfVaultPath: file.path,
      fingerprint: binding.manifest.fingerprint,
    });
    let snapshot: string;
    try {
      workspace.setPdfPath(file.path, file.basename);
      snapshot = workspace.exportMarkdown();
    } finally {
      await workspace.release();
    }
    const folder = normalizePath(exportFolder).replace(/^\/+|\/+$/g, "");
    await this.ensureFolder(folder);
    const exportPath = normalizePath(
      `${folder}/${file.basename}--${hash.slice(0, 12)}.annotations.md`
    );
    await adapter.write(exportPath, snapshot);
    return exportPath;
  }

  private async ensureBundle(
    hash: string,
    file: TFile,
    pdfData: ArrayBuffer,
    fingerprint: string | undefined,
    legacyPathOptions: AnnotationPathOptions
  ): Promise<PdfBundleBinding> {
    const paths = pathsForHash(hash);
    await this.ensureFolder(paths.rootPath);

    let manifest = await this.readManifest(paths.manifestPath);
    if (manifest?.sha256 !== hash) manifest = null;
    const now = new Date().toISOString();
    const backupStat = await this.app.vault.adapter.stat(paths.backupPath);
    const backupNeedsWrite =
      !backupStat || backupStat.type !== "file" || backupStat.size !== pdfData.byteLength;
    if (backupNeedsWrite) await this.app.vault.adapter.writeBinary(paths.backupPath, pdfData);

    const needsVerification = backupNeedsWrite || !manifest || shouldVerify(manifest.lastVerified);
    let verifiedAt = manifest?.lastVerified ?? "";
    if (needsVerification) {
      let actual = await sha256Hex(await this.app.vault.adapter.readBinary(paths.backupPath));
      if (actual !== hash) {
        // A partial/corrupt backup is repaired from the working PDF while it is
        // still available, then verified again before annotation can proceed.
        await this.app.vault.adapter.writeBinary(paths.backupPath, pdfData);
        actual = await sha256Hex(await this.app.vault.adapter.readBinary(paths.backupPath));
      }
      if (actual !== hash) throw new Error(`Could not create a verified PDF backup for ${file.path}.`);
      verifiedAt = now;
    }

    manifest = manifest ?? {
      version: 1,
      id: hash,
      sha256: hash,
      byteLength: pdfData.byteLength,
      originalName: file.name,
      currentPath: file.path,
      aliases: [file.path],
      fingerprint,
      created: now,
      updated: now,
      lastSeen: now,
      lastVerified: verifiedAt || now,
    };
    manifest.byteLength = pdfData.byteLength;
    manifest.lastVerified = verifiedAt || manifest.lastVerified || now;
    await this.writeManifest(paths.manifestPath, manifest);

    const fallbackAnnotationPaths = await this.legacyAnnotationCandidates(
      file.path,
      fingerprint,
      legacyPathOptions,
      paths.annotationPath
    );
    const annotationRecoveryPaths = (await this.app.vault.adapter.exists(paths.annotationBackupPath))
      ? [paths.annotationBackupPath]
      : [];
    return {
      ...paths,
      manifest,
      fallbackAnnotationPaths: uniquePaths([
        ...annotationRecoveryPaths,
        ...fallbackAnnotationPaths,
      ]),
    };
  }

  private async touchBinding(
    binding: PdfBundleBinding,
    currentPath: string,
    currentName: string,
    fingerprint?: string,
    oldPath?: string
  ): Promise<PdfBundleBinding> {
    const now = new Date().toISOString();
    const manifest = binding.manifest;
    manifest.currentPath = normalizePath(currentPath);
    manifest.aliases = uniquePaths([
      ...manifest.aliases,
      oldPath,
      currentPath,
    ]);
    manifest.originalName ||= currentName;
    if (fingerprint) manifest.fingerprint = fingerprint;
    manifest.lastSeen = now;
    manifest.updated = now;
    await this.writeManifest(binding.manifestPath, manifest);
    return binding;
  }

  private async legacyAnnotationCandidates(
    pdfPath: string,
    fingerprint: string | undefined,
    options: AnnotationPathOptions,
    canonicalPath: string
  ): Promise<string[]> {
    const central = sidecarPathFor(pdfPath, {
      storageMode: "folder",
      storageFolder: options.storageFolder,
    });
    const configured = sidecarPathFor(pdfPath, options);
    const beside = legacySidecarPathFor(pdfPath);
    const direct = uniquePaths([configured, central, beside]).filter((path) => path !== canonicalPath);

    const existing: string[] = [];
    for (const path of direct) {
      if (await this.annotationCandidateMatches(path, fingerprint)) existing.push(path);
    }

    // A unique fingerprint match recovers an old sidecar after the PDF was
    // already renamed or moved before this bundle system was installed.
    if (fingerprint) {
      const index = await this.getLegacyFingerprintIndex();
      const fingerprintMatches = (index.get(fingerprint) ?? []).filter(
        (path) => path !== canonicalPath && !existing.includes(path)
      );
      if (fingerprintMatches.length === 1) existing.push(fingerprintMatches[0]);
    }
    return existing;
  }

  private async annotationCandidateMatches(
    path: string,
    fingerprint: string | undefined
  ): Promise<boolean> {
    try {
      if (!(await this.app.vault.adapter.exists(path))) return false;
      const parsed = parseAnnotations(await this.app.vault.adapter.read(path));
      if (!parsed) return false;
      // A sidecar with a different document fingerprint must never migrate
      // merely because a new PDF was placed at the same visible path.
      return !fingerprint || !parsed.fingerprint || parsed.fingerprint === fingerprint;
    } catch {
      return false;
    }
  }

  private async getLegacyFingerprintIndex(): Promise<Map<string, string[]>> {
    if (this.legacyFingerprintIndex) return this.legacyFingerprintIndex;
    const index = new Map<string, string[]>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.toLowerCase().endsWith(".annotations.md")) continue;
      try {
        const parsed = parseAnnotations(await this.app.vault.cachedRead(file));
        if (!parsed?.fingerprint) continue;
        const paths = index.get(parsed.fingerprint) ?? [];
        paths.push(file.path);
        index.set(parsed.fingerprint, paths);
      } catch {
        /* A malformed legacy file must not block opening unrelated PDFs. */
      }
    }
    this.legacyFingerprintIndex = index;
    return index;
  }

  private async readBinding(hash: string): Promise<PdfBundleBinding | null> {
    const paths = pathsForHash(hash);
    const manifest = await this.readManifest(paths.manifestPath);
    return manifest && manifest.sha256 === hash
      ? { ...paths, manifest, fallbackAnnotationPaths: [] }
      : null;
  }

  private async readManifest(path: string): Promise<PdfBundleManifest | null> {
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      const parsed = JSON.parse(await this.app.vault.adapter.read(path));
      return isManifest(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeManifest(path: string, manifest: PdfBundleManifest): Promise<void> {
    await this.app.vault.adapter.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const stat = await this.app.vault.adapter.stat(current);
      if (stat?.type === "folder") continue;
      if (stat) throw new Error(`Cannot create PDF bundle folder because ${current} is a file.`);
      try {
        await this.app.vault.adapter.mkdir(current);
      } catch (error) {
        if ((await this.app.vault.adapter.stat(current))?.type !== "folder") throw error;
      }
    }
  }

  private availableRecoveryPath(folder: string, filename: string): string {
    const dot = filename.toLowerCase().endsWith(".pdf") ? filename.length - 4 : filename.length;
    const stem = filename.slice(0, dot);
    const ext = filename.slice(dot) || ".pdf";
    let candidate = normalizePath(`${folder}/${stem}${ext}`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}/${stem} ${n}${ext}`);
      n++;
    }
    return candidate;
  }
}
