import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import builtins from "builtin-modules";

const require = createRequire(import.meta.url);
const prod = process.argv[2] === "production";

// --- Confirmed install target (Vault A: the currently-open parent vault) -----
const PLUGIN_DIR =
  "/Users/tianchenhao/Library/Mobile Documents/iCloud~md~obsidian/Documents/.obsidian/plugins/local-pdf-annotator";
const OUTFILE = path.join(PLUGIN_DIR, "main.js");
fs.mkdirSync(PLUGIN_DIR, { recursive: true });

// --- Resolve the SINGLE installed pdfjs-dist build ---------------------------
// API and worker are pulled from the SAME installed package => identical version
// by construction. We capture the version at build time and inject it so the
// runtime can assert against pdfjsLib.version.
const PDFJS_PKG = require("pdfjs-dist/package.json");
const PDFJS_VERSION = PDFJS_PKG.version;
const WORKER_FILE = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.js");
console.log(`[build] pdfjs-dist@${PDFJS_VERSION}`);
console.log(`[build] inlining worker: ${WORKER_FILE}`);

// esbuild plugin: inline the pdf.js worker as a STRING (text loader). At runtime
// we turn this string into a Blob URL classic worker. Never a path on disk.
const inlinePdfWorker = {
  name: "inline-pdf-worker",
  setup(build) {
    build.onResolve({ filter: /^pdfjs-worker-inline$/ }, () => ({
      path: WORKER_FILE,
      namespace: "pdf-worker-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "pdf-worker-text" }, (args) => ({
      contents: fs.readFileSync(args.path, "utf8"),
      loader: "text",
    }));
  },
};

// esbuild plugin: copy manifest + styles into the plugin dir after each build.
const copyStatic = {
  name: "copy-static",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      for (const f of ["manifest.json", "styles.css"]) {
        try {
          fs.copyFileSync(path.resolve(f), path.join(PLUGIN_DIR, f));
        } catch (e) {
          console.warn(`[build] could not copy ${f}: ${e.message}`);
        }
      }
      console.log(
        `[build] -> ${OUTFILE} (+ manifest, styles)  @ ${new Date().toLocaleTimeString()}`
      );
    });
  },
};

const buildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: OUTFILE,
  // Provided by Obsidian/Electron at runtime, or never used in the browser path.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "canvas", // pdfjs Node-only optional dep; dead in the browser path
    ...builtins,
  ],
  define: {
    // Build-time pin used by the runtime self-check.
    __PDFJS_BUILD_VERSION__: JSON.stringify(PDFJS_VERSION),
    "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development"),
  },
  plugins: [inlinePdfWorker, copyStatic],
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[watch] esbuild watching src/ … (Ctrl-C to stop)");
}
