// The bundled pdf.js worker source, inlined as a string by esbuild's text loader
// (see the inline-pdf-worker plugin in esbuild.config.mjs). At runtime we turn
// this into a Blob URL classic worker — never a path on disk.
declare module "pdfjs-worker-inline" {
  const workerSource: string;
  export default workerSource;
}

// Injected by esbuild `define` at build time: the exact installed pdfjs-dist
// package version. Used by the runtime self-check in pdf-engine.ts.
declare const __PDFJS_BUILD_VERSION__: string;
