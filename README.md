# Local PDF Annotator (Obsidian, personal/unpublished)

A PDF reader for Obsidian with persistent text-highlight annotations stored in a
local, human-readable sidecar file. Built to **structurally avoid** the
`"API version X does not match Worker version Y"` failure that breaks the
community *Annotator* plugin.

- **id:** `local-pdf-annotator`
- **Desktop only** (uses Blob-URL web workers + the filesystem adapter).
- Bundles its **own pinned pdf.js (`pdfjs-dist@3.11.174`)** and worker.

---

## Install / enable

The build outputs straight into the vault, so there's nothing to copy by hand.

1. Source lives at `~/dev/local-pdf-annotator/` (kept out of iCloud so
   `node_modules` doesn't thrash sync). Build artifacts land in
   `…/Documents/.obsidian/plugins/local-pdf-annotator/` (Vault A).
2. Build:
   ```bash
   cd ~/dev/local-pdf-annotator
   npm install        # first time only
   npm run dev        # esbuild --watch: rebuilds main.js into the vault on save
   # or: npm run build # one-shot, type-checked, minified
   ```
3. In Obsidian: **Settings → Community plugins → enable "Local PDF Annotator"**.
   (If you change the source, Obsidian needs to reload the plugin — toggle it
   off/on, or use the *Hot Reload* plugin.)

## How to open a PDF

- **Right-click any `.pdf` in the file explorer → "Annotate"**, or
- Command palette → **"Open current PDF in annotator"**.
- *Optional:* Settings → *Local PDF Annotator* → **"Make this the default PDF
  viewer"** to open `.pdf` clicks here instead of Obsidian's core viewer. This is
  **off by default** — see *Default-handler caveat* below.

## Using it

- **Highlight:** pick a color swatch in the toolbar, then drag-select text. The
  highlight is created and saved immediately.
- **Recolor / copy / delete:** click an existing highlight → context menu.
- **Zoom:** `−` / `+` / `Reset`. Highlights re-anchor exactly across zoom,
  re-render, and window resize (geometry is stored in scale-independent PDF
  units, not screen pixels).
- **Big books:** pages render lazily as you scroll (handles 400–900-page PDFs).
- The toolbar shows a `pdf.js 3.11.174 ✓` chip confirming the API/worker match.

## Migrating old *obsidian-annotator* highlights

Your legacy highlights live inside notes with `annotation-target:` frontmatter
and store **no coordinates** — only the quoted text (hypothes.is-style
selectors). This plugin re-anchors them by **finding that text in the PDF**.

1. Open the PDF in this annotator.
2. Command palette → **"Import legacy obsidian-annotator highlights for this
   PDF"**.

It finds every note targeting this PDF, locates each quote (handling ligature /
curly-quote / hyphenation drift between pdf.js versions, and **cross-page**
selections), and creates highlights with your original comment text attached.
Re-running is idempotent (it skips ones already present); anything that can't be
located is reported in the console. Validated at **65/65** on your current notes
(Žižek 61, Cambridge-Formalism 2, After-Finitude 1, Freud 1).

The legacy notes are left untouched — delete or keep them as you like.

---

## Data format — the sidecar

Each PDF gets a companion `"<pdfname>.annotations.md"` in the **same folder**.
It is a normal, readable Markdown note with a prose list **and** a fenced
` ```json ` block that is the machine source of truth (round-trips losslessly):

```markdown
---
lpa-annotations: 1
pdf: "Obsidian/读书批注B/After Finitude有限性之后-梅亚苏.pdf"
---
# Annotations — After Finitude…

- **p.72** 🟨 ^abc12345 — "虽然思考确实可以依据各式各样法则…"
  - 📝 充足理由律

```json
{
  "version": 1,
  "pdf": "Obsidian/读书批注B/After Finitude有限性之后-梅亚苏.pdf",
  "highlights": [
    {
      "id": "abc12345",
      "page": 71,                 // 0-based page index
      "color": "rgba(255,214,0,0.40)",
      "text": "…selected text…",
      "note": "…optional comment…",
      "rects": [                  // one per visual line, PDF USER SPACE (y-up)
        { "x1": 61, "y1": 263, "x2": 241, "y2": 272 }
      ],
      "context": { "prefix": "…", "suffix": "…" },
      "created": "2026-04-15T10:46:38.126Z",
      "source": "manual"          // or "import"
    }
  ]
}
```
```

`rects` are in **PDF user-space units** (origin bottom-left, y-up) — the same
space as `viewport.convertToPdfPoint`. On render they're projected to the current
viewport via `convertToViewportPoint`, so they stay correct at any zoom. A
selection spanning two pages produces one highlight per page.

Autosave is debounced (~600 ms) and forced on view close / file switch.

---

## Worker architecture (why this can't hit the version-mismatch bug)

The *Annotator* plugin breaks because its bundled pdf.js shares **global** worker
configuration with Obsidian's internal pdf.js; the API and worker end up at
different versions and rendering dies with
`"API version … does not match the Worker version …"`.

This plugin makes that impossible by construction:

1. **One source of truth.** The rendering API and the worker are imported from
   the **same installed `pdfjs-dist` package**, so their versions are identical
   by definition (`pdf-engine.ts`).
2. **No disk path, no global.** The worker is inlined into `main.js` as a string
   at build time (esbuild text loader) and turned into a **Blob URL classic
   worker** at runtime. We set `workerSrc` **only** on our own imported
   `pdfjsLib.GlobalWorkerOptions` — never on any `window`-level global that
   Obsidian's pdf.js could read. There is no worker file path to mis-resolve
   (path resolution is exactly what breaks the other plugin).
3. **Self-verifying.** On load the console logs the API version, the build pin,
   and asserts the worker source literally embeds the API version string:
   ```
   [local-pdf-annotator] pdf.js API version:  3.11.174
   [local-pdf-annotator] worker embeds API version "3.11.174": true
   [local-pdf-annotator] ✅ API and worker versions match by construction …
   ```

Everything (pdf.js + worker) compiles into a single `main.js`.

### Default-handler caveat

Overriding the `.pdf` extension (`registerExtensions(["pdf"], …)`) works while
enabled, but using **only** public API there's no way to *restore* Obsidian's
core PDF viewer when this plugin is disabled (that would require an undocumented
internal, which this plugin deliberately never touches). So after turning the
override **off** or disabling the plugin, **restart Obsidian** to get the core
viewer back. The menu/command triggers have no such caveat and are the default.

---

## Project layout

```
src/
  main.ts          plugin: view registration, triggers, settings, import command
  view.ts          PdfAnnotatorView: render, lazy pages, zoom, selection, highlights
  pdf-engine.ts    bundled pdf.js + Blob-URL worker + self-check
  annotations.ts   data model + sidecar serialize/parse + autosave store
  anchor.ts        text-quote → page + PDF-space rects (legacy migration)
  legacy-import.ts parse obsidian-annotator notes (pure, unit-testable)
  types.d.ts       ambient decls (worker-inline module, build-version define)
test/anchor-smoke.ts   headless validation harness (hardcodes local vault paths)
esbuild.config.mjs     bundles + inlines the worker + copies manifest/styles into the vault
```

## Status / roadmap

**MVP done:** render, selectable text, zoom, create/recolor/delete highlights,
sidecar persistence, legacy import, clean teardown (revokes Blob URL, cancels
render tasks, removes listeners, restores the core handler on restart).

**Phase 2 (stubbed):** selection popup, per-highlight notes editor (notes already
import + display), and Markdown back-links — `revealHighlight(id)` exists to
scroll-and-flash a highlight from a note link.
