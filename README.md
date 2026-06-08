# PDF Annotator

PDF Annotator is a desktop-only Obsidian plugin for reading PDFs, marking
passages, and keeping searchable annotations next to the document.

It stores annotation data in a local Markdown sidecar beside each PDF. The PDF
file itself is not modified, and the annotation source remains readable and
portable.

## Features

- Read PDFs inside Obsidian with a bundled, pinned `pdf.js` worker.
- Select text without creating anything by accident.
- Use the contextual selection popup to create either:
  - a highlight only, or
  - an annotation with a highlight and a margin note card.
- Keep text crisp: highlight color is painted behind selectable PDF text.
- View annotation cards in left and right margins at the level of their source
  passage.
- Search highlights, notes, and page tags in the horizontal Annotations row.
- Add page-level tags for notes that are not tied to a text selection.
- Move margin cards between left and right margins.
- Import legacy `obsidian-annotator` highlights for the current PDF.

## Opening PDFs

PDF Annotator is always available from:

- File explorer: right-click a `.pdf` file and choose **Annotate**.
- Command palette: run **Open current PDF in annotator**.

You can also make it the default PDF viewer from plugin settings. This redirects
ordinary `.pdf` clicks into PDF Annotator. The setting is opt-in for fresh
installs.

## Basic Use

1. Open a PDF in PDF Annotator.
2. Drag-select text. Selection alone creates nothing.
3. Move to the slim handle at the end of the selection until the action popup
   opens.
4. Choose **Highlight** to save only a text mark.
5. Choose **Annotate** to save a text mark plus a margin note card.
6. Use **Tag** in the top-right controls to place a page note at a specific
   location on the PDF.
7. Use **Annotations** to open the searchable horizontal annotation row.

## Data Format

Each PDF gets a companion file named:

```text
<pdf-name>.annotations.md
```

The sidecar lives in the same folder as the PDF. It contains a readable Markdown
summary and a fenced JSON block that is used as the machine-readable source of
truth.

Highlight geometry is stored in PDF user-space coordinates, so highlights and
tags remain anchored across zoom changes.

## Privacy

PDF Annotator does not use telemetry and does not send PDF contents or
annotation contents to any remote service. Data is stored locally in your vault.

## Legacy Import

If you previously used `obsidian-annotator`, open the target PDF in this plugin
and run:

```text
Import legacy obsidian-annotator highlights for this PDF
```

The importer searches notes with `annotation-target:` frontmatter, re-anchors
quoted text in the PDF, and creates PDF Annotator highlights. Legacy notes
are left untouched.

## Development

```bash
npm install
npm run typecheck
npm run build
```

`npm run build` type-checks the plugin, bundles `main.js`, and copies
`main.js`, `manifest.json`, and `styles.css` into the configured local vault
plugin directory used by this checkout.

## Release Files

Obsidian installs community plugin releases from GitHub release assets. A release
must include:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag must match the `version` field in `manifest.json`.
