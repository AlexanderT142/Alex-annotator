import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import { builtinModules, createRequire } from "module";

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

function replaceRequired(contents, needle, replacement, label, sourcePath) {
  if (!contents.includes(needle)) {
    throw new Error(`[build] could not patch ${label} in ${sourcePath}`);
  }
  return contents.replace(needle, replacement);
}

function sanitizePdfJsApi(contents, sourcePath) {
  if (contents.includes(`function isEvalSupported() {
  try {
    new Function("");
    return true;
  } catch {
    return false;
  }
}`)) {
    contents = replaceRequired(
      contents,
      `function isEvalSupported() {
  try {
    new Function("");
    return true;
  } catch {
    return false;
  }
}`,
      `function isEvalSupported() {
  return false;
}`,
      "eval feature test",
      sourcePath
    );
  } else {
    contents = replaceRequired(
      contents,
      `function isEvalSupported(){try{new Function("");return!0}catch{return!1}}`,
      `function isEvalSupported(){return!1}`,
      "minified eval feature test",
      sourcePath
    );
  }

  contents = contents.replaceAll(`Function("return this")()`, "globalThis");
  contents = contents.replaceAll(`Function('return this')()`, "globalThis");

  contents = contents.replace(
    /function loadScript\(src(?:, removeScriptElement = false)?\) \{[\s\S]*?\n\}/,
    `function loadScript(src, removeScriptElement = false) {
  return Promise.reject(new Error("Local PDF Annotator disables pdf.js dynamic script fallback."));
}`
  );
  contents = contents.replace(
    /function loadScript\(src\) \{\n  let removeScriptElement = arguments\.length > 1 && arguments\[1\] !== undefined \? arguments\[1\] : false;[\s\S]*?\n\}/,
    `function loadScript(src) {
  return Promise.reject(new Error("Local PDF Annotator disables pdf.js dynamic script fallback."));
}`
  );
  contents = contents.replace(
    /e\.loadScript=function loadScript\(t\)\{[\s\S]*?\(document\.head\|\|document\.documentElement\)\.append\(r\)\}\)\)\};/,
    `e.loadScript=function loadScript(t){return Promise.reject(new Error("Local PDF Annotator disables pdf.js dynamic script fallback."))};`
  );
  if (contents.includes(`document.createElement("script")`)) {
    throw new Error(`[build] could not remove pdf.js dynamic script fallback in ${sourcePath}`);
  }

  if (contents.includes(`const worker = eval("require")(this.workerSrc);`)) {
    contents = replaceRequired(
      contents,
      `const worker = eval("require")(this.workerSrc);`,
      `const worker = require(this.workerSrc);`,
      "Node fake-worker eval fallback",
      sourcePath
    );
  } else {
    contents = replaceRequired(
      contents,
      `const worker=eval("require")(this.workerSrc);`,
      `const worker=require(this.workerSrc);`,
      "minified Node fake-worker eval fallback",
      sourcePath
    );
  }

  if (contents.includes(`return this.compiledGlyphs[character] = new Function("c", "size", jsBuf.join(""));`)) {
    contents = replaceRequired(
      contents,
      `return this.compiledGlyphs[character] = new Function("c", "size", jsBuf.join(""));`,
      `return this.compiledGlyphs[character] = function (c, size) {
        for (const current of cmds) {
          if (current.cmd === "scale") {
            current.args = [size, -size];
          }
          c[current.cmd].apply(c, current.args);
        }
      };`,
      "glyph eval fast path",
      sourcePath
    );
  } else {
    contents = replaceRequired(
      contents,
      `return this.compiledGlyphs[e]=new Function("c","size",t.join(""))`,
      `return this.compiledGlyphs[e]=function(t,e){for(const i of n){"scale"===i.cmd&&(i.args=[e,-e]);t[i.cmd].apply(t,i.args)}}`,
      "minified glyph eval fast path",
      sourcePath
    );
  }

  for (const forbidden of ["new Function", `Function("`, `Function('`, "eval(", `createElement("script")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js token still present after patch: ${forbidden}`);
    }
  }

  return contents;
}

function sanitizePdfJsWorker(contents, sourcePath) {
  const replacements = [
    [
      `function isEvalSupported(){try{new Function("");return!0}catch{return!1}}`,
      `function isEvalSupported(){return!1}`,
      "worker eval feature test",
    ],
    [
      `if(a&&n.FeatureTest.isEvalSupported){const e=(new PostScriptCompiler).compile(h,o,c);if(e)return new Function("src","srcOffset","dest","destOffset",e)}`,
      `if(false){}`,
      "worker PostScript eval fast path",
    ],
    [
      `Function("return this")()`,
      `globalThis`,
      "worker core-js global fallback",
    ],
  ];

  for (const [needle, replacement, label] of replacements) {
    contents = replaceRequired(contents, needle, replacement, label, sourcePath);
  }

  for (const forbidden of ["new Function", `Function("`, "eval(", `createElement("script")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js worker token still present after patch: ${forbidden}`);
    }
  }

  return contents;
}

function sanitizePdfJsSandbox(contents, sourcePath) {
  if (contents.includes(`Function("return this")()`)) {
    contents = contents.replaceAll(`Function("return this")()`, "globalThis");
  }
  if (contents.includes(`Function('return this')()`)) {
    contents = contents.replaceAll(`Function('return this')()`, "globalThis");
  }
  if (contents.includes(`Function(\\"return this\\")()`)) {
    contents = contents.replaceAll(`Function(\\"return this\\")()`, "globalThis");
  }

  for (const forbidden of ["new Function", `Function("`, `Function('`, `Function(\\"`, "eval(", `createElement("script")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js sandbox token still present after patch: ${forbidden}`);
    }
  }

  return contents;
}

function sanitizePdfJsImageDecoder(contents, sourcePath) {
  contents = contents.replaceAll(`Function("return this")()`, "globalThis");
  contents = contents.replaceAll(`Function('return this')()`, "globalThis");
  if (contents.includes(`function isEvalSupported(){try{new Function("");return!0}catch{return!1}}`)) {
    contents = contents.replaceAll(
      `function isEvalSupported(){try{new Function("");return!0}catch{return!1}}`,
      `function isEvalSupported(){return!1}`
    );
  }

  for (const forbidden of ["new Function", `Function("`, `Function('`, "eval(", `createElement("script")`]) {
    if (contents.includes(forbidden)) {
      throw new Error(`[build] forbidden pdf.js image-decoder token still present after patch: ${forbidden}`);
    }
  }

  return contents;
}

function sanitizePdfJsLoadedFile(args) {
  const sourcePath = args.path;
  const contents = fs.readFileSync(sourcePath, "utf8");

  if (/pdfjs-dist[/\\](legacy[/\\])?build[/\\]pdf(\.min)?\.js$/.test(sourcePath)) {
    console.log(`[build] sanitizing pdf.js API: ${path.relative(process.cwd(), sourcePath)}`);
    return sanitizePdfJsApi(contents, sourcePath);
  }
  if (/pdfjs-dist[/\\](legacy[/\\])?build[/\\]pdf\.sandbox(\.min)?\.js$/.test(sourcePath)) {
    console.log(`[build] sanitizing pdf.js sandbox: ${path.relative(process.cwd(), sourcePath)}`);
    return sanitizePdfJsSandbox(contents, sourcePath);
  }
  if (/pdfjs-dist[/\\](legacy[/\\])?image_decoders[/\\]pdf\.image_decoders(\.min)?\.js$/.test(sourcePath)) {
    console.log(`[build] sanitizing pdf.js image decoder: ${path.relative(process.cwd(), sourcePath)}`);
    return sanitizePdfJsImageDecoder(contents, sourcePath);
  }

  return null;
}

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
      contents: sanitizePdfJsWorker(fs.readFileSync(args.path, "utf8"), args.path),
      loader: "text",
    }));
  },
};

// pdf.js includes a fake-worker fallback that dynamically injects a <script>.
// This plugin never uses that path: every document gets an explicit Blob Worker
// port from createDedicatedWorker(). Removing the fallback keeps the release
// bundle compatible with Obsidian's community-plugin scanner.
const stripPdfJsDynamicScriptFallback = {
  name: "strip-pdfjs-dynamic-script-fallback",
  setup(build) {
    build.onLoad({ filter: /pdfjs-dist[/\\].*\.js$/ }, (args) => {
      const contents = sanitizePdfJsLoadedFile(args);
      return contents == null ? undefined : { contents, loader: "js" };
    });
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
    ...builtinModules,
  ],
  define: {
    // Build-time pin used by the runtime self-check.
    __PDFJS_BUILD_VERSION__: JSON.stringify(PDFJS_VERSION),
    "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development"),
  },
  plugins: [stripPdfJsDynamicScriptFallback, inlinePdfWorker, copyStatic],
};

if (prod) {
  await esbuild.build(buildOptions);
} else {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[watch] esbuild watching src/ … (Ctrl-C to stop)");
}
