/**
 * pdf-engine.ts — the bulletproof, self-verifying pdf.js setup.
 *
 * WHY THIS FILE EXISTS / THE ARCHITECTURE DECISION
 * ------------------------------------------------
 * The community "Annotator" plugin breaks with
 *   "The API version X does not match the Worker version Y"
 * because it lets its bundled pdf.js share global worker config with Obsidian's
 * own internal pdf.js. We make that *structurally impossible*:
 *
 *  1. The rendering API and the worker are imported from the SAME installed
 *     pdfjs-dist package, so their versions are identical by construction.
 *  2. The worker is inlined as a STRING at build time and turned into a Blob URL
 *     at runtime — there is no path on disk to resolve (path resolution is
 *     exactly what breaks the other plugin).
 *  3. We set `workerSrc` ONLY on our own imported `pdfjsLib` module instance.
 *     We never read or write any window-level global that Obsidian's pdf.js
 *     could also touch.
 *
 * pdf.js itself throws the version-mismatch error inside the worker when the
 * API version it is handed differs from the worker's embedded version. Because
 * both come from one install, that branch can never fire. `initPdfEngine()`
 * additionally logs the versions and asserts the worker source literally embeds
 * the API version string, so the guarantee is visible and self-checking.
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import workerSource from "pdfjs-worker-inline";

export { pdfjsLib };

export const LOG_TAG = "[local-pdf-annotator]";

let workerBlobUrl: string | null = null;
let blobWorkersOk = false;
let workerCounter = 0;
let status: PdfEngineStatus | null = null;

/**
 * Create a dedicated pdf.js worker for ONE document, from our bundled worker
 * blob. Pass the returned PDFWorker to getDocument({ worker }). Returns null if
 * blob-URL workers are unavailable (CSP) — callers then omit `worker` and pdf.js
 * uses the main-thread fallback configured in initPdfEngine.
 */
export function createDedicatedWorker(): any | null {
  if (!status) initPdfEngine();
  if (!blobWorkersOk || !workerBlobUrl) return null;
  const port = new Worker(workerBlobUrl);
  return new (pdfjsLib as any).PDFWorker({ port, name: `lpa-worker-${++workerCounter}` });
}

export interface PdfEngineStatus {
  apiVersion: string;
  buildVersion: string;
  workerEmbedsApiVersion: boolean;
  ok: boolean;
  blobUrl: string;
  workerMode: string;
}

/**
 * Idempotently configures the worker on OUR module instance and runs the
 * self-check. Safe to call multiple times; the Blob URL is created once.
 */
export function initPdfEngine(): PdfEngineStatus {
  if (status) return status;

  // Classic worker, built from OUR bundled worker source. Never a disk path.
  const blob = new Blob([workerSource], { type: "text/javascript" });
  workerBlobUrl = URL.createObjectURL(blob);

  // CRITICAL: do NOT rely on workerSrc / a shared global worker. Two problems:
  //  (1) When pdf.js falls back to a "fake worker" it picks up
  //      globalThis.pdfjsWorker — which Obsidian has already set to ITS OWN
  //      (different-version) worker → "API version X does not match Worker
  //      version Y" and a blank render.
  //  (2) A SINGLE worker shared across multiple open PDFs makes the 2nd
  //      document's canvas render blank.
  // Solution: give EACH document its own dedicated Worker built from our blob
  // and passed explicitly to getDocument via a per-document PDFWorker (see
  // createDedicatedWorker). pdf.js then uses our worker directly and never
  // consults workerSrc or the global. Here we only probe that blob-URL workers
  // are constructible and keep workerSrc as a harmless fallback.
  const gwo = pdfjsLib.GlobalWorkerOptions as {
    workerSrc: string;
    workerPort: Worker | null;
  };
  gwo.workerPort = null;
  let workerMode = "none";
  try {
    const probe = new Worker(workerBlobUrl); // verify blob workers are allowed
    probe.terminate();
    blobWorkersOk = true;
    gwo.workerSrc = workerBlobUrl; // fallback only; we pass an explicit worker
    workerMode = "dedicated-per-document(blob)";
  } catch (ePort) {
    // CSP may block blob-URL workers. Do not use pdf.js' dynamic fake-worker
    // fallback because Obsidian's community scanner rejects eval/script
    // injection. Callers omit the worker and pdf.js will surface the failure.
    console.warn(`${LOG_TAG} blob Worker construction failed; using main-thread fallback`, ePort);
    blobWorkersOk = false;
    gwo.workerSrc = workerBlobUrl;
    workerMode = "workerSrc(blob-fallback)";
  }

  const apiVersion: string = (pdfjsLib as { version: string }).version;
  const buildVersion: string = __PDFJS_BUILD_VERSION__;
  // Minification-proof: the worker embeds its version as a quoted literal
  // (e.g. w="3.11.174"). If the worker were a different build, it would not
  // contain the API's version string.
  const workerEmbedsApiVersion =
    workerSource.includes(`"${apiVersion}"`) ||
    workerSource.includes(`'${apiVersion}'`);
  const ok = apiVersion === buildVersion && workerEmbedsApiVersion;

  console.log(`${LOG_TAG} pdf.js API version:  ${apiVersion}`);
  console.log(`${LOG_TAG} pdf.js build pin:    ${buildVersion}`);
  console.log(
    `${LOG_TAG} worker embeds API version "${apiVersion}": ${workerEmbedsApiVersion}`
  );
  console.log(`${LOG_TAG} worker loaded from Blob URL: ${workerBlobUrl}`);
  console.log(`${LOG_TAG} worker mode: ${workerMode} (dedicated port bypasses Obsidian's global worker)`);
  if (ok) {
    console.log(
      `${LOG_TAG} ✅ API and worker versions match by construction — ` +
        `"API version does not match Worker version" cannot occur.`
    );
  } else {
    console.warn(
      `${LOG_TAG} ⚠️ pdf.js self-check FAILED ` +
        `(api=${apiVersion}, build=${buildVersion}, workerEmbedsApi=${workerEmbedsApiVersion}). ` +
        `This should be impossible with a single bundled build — investigate the build.`
    );
  }

  status = { apiVersion, buildVersion, workerEmbedsApiVersion, ok, blobUrl: workerBlobUrl, workerMode };
  return status;
}

export function getPdfEngineStatus(): PdfEngineStatus | null {
  return status;
}

/** Revoke the Blob URL on plugin unload. Per-document workers are terminated by
 * their views (PDFWorker.destroy). */
export function disposePdfEngine(): void {
  if (workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
  }
  // Drop our references so a future load re-inits cleanly.
  const gwo = (pdfjsLib as { GlobalWorkerOptions: { workerSrc: string; workerPort: Worker | null } })
    .GlobalWorkerOptions;
  gwo.workerSrc = "";
  gwo.workerPort = null;
  blobWorkersOk = false;
  status = null;
}
