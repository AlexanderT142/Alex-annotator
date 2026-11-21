# PDF Annotator

Read a PDF, mark the parts that matter, and keep your own thoughts beside the
words — all inside Obsidian.

Open any PDF and click **Annotate**. You can highlight a sentence, write a note,
and carry on reading without changing apps or opening a second document.

![A PDF page with several short and long notes on both sides](docs/screenshots/annotation-cards-overview-light-retina.png)

*Your notes stay close to the words they belong to.*

## See every note beside the page

Notes appear on the left or right of the page. A short note stays small. A long
note is taller, so you can tell how much you wrote before opening it.

When one page has many long notes, the cards fold just enough to share the
space. A soft fade and **…** show that more words are waiting. Point to a card or
click it to see the whole note.

![Short, medium, and long cards with a gentle folded ending](docs/screenshots/annotation-card-folding-detail-light-retina.png)

*Different note lengths are easy to spot, and folded notes clearly show that
there is more to read.*

You do not need to guess how to make room for the cards. After you make a note,
or choose one from the note list, the PDF moves back just enough to show its
card. It stops as soon as the card has enough space.

## Mark what matters

Select some words and choose what you want to do:

- **Highlight** marks the words.
- **Annotate** marks the words and opens a place to write.
- **Copy** copies the selected words.

![Simple buttons for highlighting, annotating, or copying selected words](docs/screenshots/selection-popover-light-retina.png)

You can use a plain highlight, underline, dotted underline, dashed underline,
box, or strike-through. Four colours help different kinds of thought stand
apart. Open **Settings → PDF Annotator → Annotation colors** to customize each
slot with a full-spectrum color picker. Reset a slot to restore its default.
Existing annotations retain their saved colors.

## Open one note fully

Point to a note or click it and the card opens to show everything you wrote. A
long note is not cut off. Click the pin when you want a card to stay open.

![A long selected note opened to its full height beside the PDF](docs/screenshots/annotation-card-expanded-light-retina.png)

*The selected note opens fully while the other cards stay out of the way.*

## Find a note again

Click the list button beside **Annotate** to see every mark and note in the PDF.
Search for a word, a page, or something you wrote. Click any result to go back
to its page and show its card.

![The searchable list of notes beside the PDF](docs/screenshots/annotation-list-light-retina.png)

## Put notes where you want them

Page-note tags can be moved after you finish writing: drag the tag to another
spot on its page. Drag its bottom-right corner to resize width and height
independently into any rectangle. Larger tags show more of your note. Click to
edit as usual, or press Escape during a move or resize to cancel. Position and
size are saved when you release and stay proportional when you zoom or reopen
the PDF. This works in both the native PDF viewer and the separate reader.

Use **Region** (the outlined rectangle button in the native toolbar) to annotate
a diagram: click a location on the page, then drag the outline to move it or its
bottom-right corner to resize it. The transparent rectangle links to its own
annotation card, with the same notes, pins, sets, and navigation as a page tag.
The area inside the outline remains available for selecting PDF text and links.
In the native editor, switch between **Tag** and **Region**; in the separate
reader, right-click the annotation and choose the corresponding conversion.

## Render Markdown, code, and math

Enable **Settings → PDF Annotator → Render annotations as Markdown** for formatted
notes, fenced code blocks, and inline or display LaTeX through Obsidian's native
renderer. It is off by default. Click a preview to edit its original Markdown;
leave the editor to see the rendered result. Links remain clickable, and both
the main note and side note are supported. Turning this off restores plain text
editors without changing your saved notes.

Right-click any card to keep it open, move it to the left, move it to the right,
let PDF Annotator choose a side, or delete it.

![The right-click menu for pinning, moving, or deleting a note](docs/screenshots/annotation-card-menu-light-retina.png)

*Moving a card never moves or changes the words you marked.*

## A simple reading routine

1. Open a PDF and click **Annotate**.
2. Select a useful sentence.
3. Choose **Highlight** or **Annotate**.
4. Write your thought.
5. Keep reading; your note stays beside the page.
6. Use the list when you want to find it again.

## Take your quotes and notes with you

Run **Export annotations for current PDF** from Obsidian's command palette.
The exported Markdown keeps the full highlighted passage, its colour, and your
note underneath it. Each non-archived set gets its own heading—even sets you
have hidden while reading. No extra export options to configure.

## Keep different kinds of notes separate

Think of annotation sets as separate notebooks laid over the same PDF. Keep
your own thoughts in **My notes**, translations in another set, and explanations
in a **Reading partner** set. Show them together, or hide the ones you do not
need right now. Nothing is erased when you hide a set.

Click the set name at the top right to open the dropdown:

- The **eye** at the left of each set shows whether it is visible. Click it to
  hide the set (the eye is crossed out); click again to show it.
- **Write here** chooses where your next manual notes will go. That set then
  shows **✓ Writing here**. Other sets can still be visible at the same time.
- Each set shows how many notes it holds. The **⋯** menu renames or archives it.
- **+ New set** gives you another space for a different purpose. Archived sets
  are listed under **Archived** at the bottom.

![Annotation-set dropdown showing personal notes, translations, and a reading partner with independent visibility](docs/screenshots/annotation-sets-dropdown-retina.png)

*Choose what you see independently from where you write.*

## Invite AI to read alongside you

You can do your own thinking and still ask for a little help. For example, keep
your notes untouched while AI adds a translation or explains an unfamiliar
idea in a separate set.

1. Create a set in the set dropdown, such as **Translation** or **Reading partner**.
2. Click **AI** at the top right and choose that existing set.
3. The first time, choose your provider, paste its API key, and choose a model.
   After that the panel shows them on one line; click **Change** to edit them.
4. Pick a few pages and describe the help you want. For example: “Translate key
   passages into Chinese” or “Explain unfamiliar ideas and useful connections.”
5. Start the job and keep reading. Progress appears on the toolbar, and closing
   the dropdown does not stop the work.

![AI annotation dropdown with an existing destination set, provider, hidden API-key field, model, page range, and reading-partner prompt](docs/screenshots/ai-annotation-dropdown-retina.png)

*Tell AI what kind of help you want and where its notes should go.*

AI adds notes to the set you choose; it does not replace your existing notes or
change where your manual notes are saved. Page numbers are positions in the PDF,
including any cover or introduction. Start with two pages to see whether the
result suits you. AI explanations can be wrong, so treat them as suggestions.

Pick the provider and model from lists that show each provider's logo. The
model list offers that provider's current models (for example Claude Fable 5.2,
Opus 5.5, Sonnet 5.5 and Haiku 5.5); **Load more from provider** adds its newest
models, and you can always type any model ID yourself.
There is no request format or code to configure.

AI is optional and uses your own provider account, which may charge for requests.
Only text from your chosen pages and your prompt are sent—not the whole PDF or
your existing annotations. The API key stays outside your vault on this device;
that storage is not encrypted. See [Privacy](#privacy) for the details.

## Use the same notes on several computers (Beta)

Keep your highlights, notes, tags, and annotation sets in sync across desktop
computers using the sync tool you already have — Obsidian Sync, iCloud,
Syncthing, Git, Dropbox, and similar file sync tools.

Sync is **off by default**. With it turned off, PDF Annotator behaves exactly
as before.

### Set it up

1. Open **Settings → PDF Annotator → Multi-device sync (Beta)** on **each
   computer** and turn on **Sync annotations between devices**.
2. Click **Exclude sync folder** to keep sync files out of Search and Graph
   (this also ranks them lower in Quick Switcher).
3. Reopen any PDF that was already open, or toggle **Annotate** off and back
   on, so sync attaches to it.

> **Obsidian Sync users:** **Exclude sync folder** uses **Settings → Files and
> links → Excluded files**, which is safe. Do **not** add `_pdf-annotator-sync`
> to **Obsidian Sync's own Excluded folders** — that will stop it from syncing.

### How it works day to day

- **Same PDF, same notes:** Both computers need the exact same PDF file
  (byte-for-byte). A re-saved, re-exported, or OCR'd copy counts as a
  different document.
- **Syncs while you read:** Changes sync automatically while a PDF is open in
  annotation mode (usually within a couple of seconds). Edits made while a PDF
  is closed — or right before quitting Obsidian — are published the next time
  you open that PDF in annotation mode.
- **No silent overwrites:** Each computer writes only its own file inside
  `_pdf-annotator-sync`, so sync tools never overwrite one computer's work
  with another's.
- **Conflicts keep all your writing:** If you edit the same note offline on
  two computers, both versions are kept in the note, and its card shows a
  **Sync conflict** label. Edit the note once to resolve it.
- **Personal view stays personal:** Which sets are visible (the eye toggles)
  and which set you are writing to stay separate on each computer.
- **Desktop only:** PDF Annotator does not run on phones or tablets yet.

### Built-in safety nets

Sync is in beta, so it is built to fail safely without touching your ability
to read and annotate:

- **Auto-pause on trouble:** If sync hits an error, slows Obsidian down, or
  detects a write loop, it pauses itself while your annotations keep working
  normally. Run **Resume sync for current PDF** from the command palette to
  try again.
- **Large deletion guard:** If another computer deleted many annotations at
  once, they are kept locally until you confirm with **Apply pending sync
  deletions for current PDF**.
- **Step back anytime:** Run **Undo last sync for current PDF** to revert the
  last remote change applied to the open PDF (up to 15 steps back).
- **Emergency reset:** Run **Restore pre-sync backup for current PDF** to
  return to your pre-sync snapshot. On a second
  computer that had no annotations before sync, this clears the PDF (with a
  confirmation prompt).

Both **Undo** and **Restore** pause sync for that PDF so your restored version
isn't overwritten. To keep a restored version **only** on the current
computer, turn sync off in settings before restarting Obsidian — otherwise
restarting or resuming will share it to your other devices.

While sync is on, `_pdf-annotator-sync` is automatically hidden from the file
explorer. If you use plugins that scan all Markdown files (such as Dataview or
Linter), you may want to exclude `_pdf-annotator-sync` inside those plugins'
settings as well.

---

## Technical Notes

PDF Annotator is a desktop-only Obsidian community plugin. It adds annotation
layers, controls, margin rails, and an annotation list to Obsidian's native PDF
viewer. Obsidian's existing toolbar, outline/sidebar, zoom controls, and page
navigation remain in place.

Selection alone does not create an annotation. The selection popover commits a
highlight or annotated mark only after the user chooses an action. Highlight
geometry is stored in PDF user-space coordinates, so marks stay anchored across
zoom and resize changes.

### Automatic rail space

Creating an annotation or selecting one from the annotation list activates its
card. If the native PDF page leaves too little readable margin, the plugin uses
the native zoom-out control until that card's rail is wide enough. It stops as
soon as the target rail is readable and has a bounded retry limit.

Resting card height is weighted mainly by user-written content. On a dense page,
the available rail height is shared proportionally: longer cards remain visibly
longer, while all resting cards fold enough to fit. Hovered, active, and pinned
cards expand to their full content height, with an internal scrollbar only when
the entire card is taller than the available viewport.

### Native PDF workflow

1. Open a PDF normally in Obsidian.
2. Click **Annotate** in the native PDF toolbar.
3. Select text and choose **Highlight**, **Annotate**, or **Copy**.
4. Click an existing mark to edit its style, colour, note, or side note.
5. Use a side card for in-place editing, or the annotation list for search and
   navigation.

The card context menu supports pin/unpin, left placement, right placement,
automatic placement, and deletion. Drag-and-drop between rails is not currently
implemented.

## Fallback Annotator View

The original bundled `pdf.js` annotator view remains available as a stable
fallback. Use the command palette action:

```text
Open current PDF in annotator
```

You can also make the fallback annotator the default PDF viewer from plugin
settings. This redirects ordinary `.pdf` clicks into PDF Annotator. The setting
is opt-in for fresh installs.

## Storage and Recovery

The visible PDF path is not the document identity. Identity comes from a SHA-256
hash of the PDF bytes, and the canonical vault-local bundle is stored at:

```text
.pdf-annotator/bundles/sha256/<hash>/
  document.pdf
  annotations.md
  annotations.previous.md
  annotation-sets/
    index.json
    index.previous.json
    default.md
    <set-id>.md
    <set-id>.previous.md
  ai-jobs/
    <job-id>.json
    <job-id>.previous.json
  manifest.json
```

`document.pdf` is a verified byte-for-byte recovery copy. Existing
`annotations.md` data is preserved and migrated into the default annotation
set. Each set then has its own readable Markdown sidecar and rolling
last-known-good copy. `annotation-sets/index.json` records set names, kinds,
visibility, and the active write target. AI job checkpoints record progress and
provider/model provenance, but never the API key.
Open tabs share the same workspace, and saves are serialized. A damaged set
registry is preserved for inspection, recovered from its backup, and reconciled
with surviving annotation sidecars so newer sets remain accessible.
`manifest.json` records the current working path, previous path aliases,
checksum, original filename, timestamps, and PDF fingerprint. The working PDF
is never modified.

The bundle is created the first time annotation mode opens for that PDF. This
uses roughly one additional PDF's worth of vault storage in exchange for
deletion recovery.

Moving or renaming a working PDF does not move the bundle and cannot disconnect
its annotations. Replacing a PDF with different bytes at the same path creates a
different bundle, so annotations cannot silently attach to the wrong document.
Deleting the working copy leaves the bundle intact. Use **Restore a PDF from
annotation backup** in the command palette to verify the checksum and restore a
copy into `Recovered PDFs/`.

Existing central or same-folder `<pdf-name>.annotations.md` sidecars are
imported on first open. A unique PDF-fingerprint match can also recover a
sidecar that was already orphaned by a rename. Legacy files are retained as
recovery snapshots.

The canonical sidecar contains a readable Markdown summary and a fenced JSON
block that is used as the machine-readable source of truth. Use **Export
annotations for current PDF** to create a user-visible snapshot under
`PDF annotations/Exports/` (or the configured legacy annotation folder).
Exports include every non-archived annotation set under its own heading, even
when its eye is off while reading. Full quoted passages and notes appear
separately, with highlight colours and spacing preserved. Archived sets remain
in the managed library but are excluded from the export.

Use **Verify all PDF annotation backups** to checksum every managed recovery
copy. Backups are also verified when created and periodically when their PDFs
are opened. The managed library protects against moving, renaming, replacing,
or deleting a working copy; it is still part of the same vault, so the vault
itself should remain covered by iCloud, Obsidian Sync, or another backup system.
`.pdf-annotator/` is a hidden folder. Obsidian Sync never syncs hidden folders
and has no option to include them, and other tools may skip them too. To share
annotations between computers, use the optional multi-device sync below rather
than syncing `.pdf-annotator/` itself.

## Multi-Device Sync (Beta)

Off by default. When disabled, no sync listeners are registered and no sync
files are read or written. When enabled, a sidecar module bridges the
unchanged vault-local bundle and a visible, synced folder:

```text
_pdf-annotator-sync/<sha256>/<device-id>.md      # synced; written only by that device
.pdf-annotator/sync/<device-id>/<sha256>/        # device-local only (never synced)
  baseline.json   own.json   pre-sync-backup.json   snapshots/*.json
```

### Architecture and merge rules

- **Local bundle stays canonical:** Sync reads from and writes back through
  the annotation workspace, preserving existing `.previous` backups.
- **Device identity:** Each device's ID and per-shard write nonces are stored
  in Obsidian's device-local storage (`saveLocalStorage`, falling back to
  `window.localStorage`), never in `data.json`. If a cloned machine reuses an
  ID, the nonce mismatch is detected and a fresh ID is issued automatically.
- **Markdown shards:** Sync files use `.md` so Obsidian Sync includes them
  without requiring "Sync all other types". The JSON payload sits between
  sentinel comments (`<!-- pdf-annotator-sync:start -->` / `end`); partial or
  damaged files are retried (300 / 800 / 2000 ms), then skipped without ever
  being treated as empty. Sync-tool conflict copies are read as additional
  read-only shards.
- **Deterministic merge:** Merging is a pure function over all shards in the
  PDF's hash folder. Deletions (tombstones) and style/geometry fields use
  last-writer-wins with per-record monotonic clocks (`max(now, previous + 1)`),
  so a skewed clock cannot lock an annotation. Note text uses per-annotation
  version vectors so truly concurrent edits are stitched rather than dropped,
  and a note edited after a deletion keeps the annotation alive.
- **Sets:** Set names, colours, kinds, and archived states sync; visibility
  and the active writing set remain device-local. Sets are archived rather
  than deleted and annotations do not move between sets.

### Safety rails

- **Pre-sync backup:** Saved once per PDF (all sets, archived included) before
  sync first touches it, and never rotated.
- **Rolling undo snapshots:** Up to 15 per PDF, taken only immediately before
  remote changes are applied (never on local edits).
- **Validate-before-apply:** Incoming changes are validated as a whole before
  mutating workspace state; mid-apply failures roll back in-memory state.
- **Governors and breakers:** Any sync error pauses that PDF (3 session errors
  pause all PDFs). Cycles exceeding 300 ms of main-thread work back off up to
  60 s, then pause. More than 10 shard writes in 10 minutes without user or AI
  edits pause as a write loop. **Sync current PDF now** reports the exact
  pause reason, **Resume sync for current PDF** resets any pause (including
  errors), and Undo/Restore bypass the error breaker.
- **Deletion threshold:** Remote batches deleting more than 5 annotations — or
  at least 3 annotations removing over 20% of a PDF's annotations — are held
  until confirmed via **Apply pending sync deletions for current PDF**.
- **Focus & render isolation:** Remote changes wait while any plugin text
  input has focus. Independently of sync, each annotation renders inside its
  own `try/catch` guard so one unexpected record cannot break a page or list.

### Known limitations (Beta)

- **Active PDFs only & quit flush:** Sync runs only while a PDF is open in
  annotation mode, and intentionally skips async writes during Obsidian quit.
  Any unpublished local edits stay safely saved in `.pdf-annotator/` and
  publish the next time that PDF is opened in annotation mode.
- **Detection-time timestamps:** Style/position timestamps reflect when sync
  detects a change, so a long-offline style edit can override a newer style
  edit on another device. Note text is protected by version vectors and is
  never lost this way.
- **Online-only cloud files:** Cloud features such as iCloud "Optimize Mac
  Storage" can evict shards to placeholders; evicted shards are skipped until
  downloaded (nothing is deleted, but that device's updates wait).
- **Other Markdown plugins:** Shards are standard `.md` files. Frontmatter or
  summary edits by formatting plugins are ignored by the parser, but any
  plugin that modifies the JSON block can damage a shard.

The design notes and test plan are in `docs/sync-design.md`. `npm test`
includes unit tests, multi-device scenarios, and a randomized three-device
simulation (`LPA_SYNC_SEEDS` sets the run count).

## Privacy

PDF Annotator does not use telemetry. Manual annotations, annotation sets, job
checkpoints, and recovery copies are stored locally in your vault.

AI annotation is opt-in. When you start an AI job, the plugin extracts text
from only the selected page range and sends that text plus your prompt to the
provider shown in the job dialog. It does not upload the PDF file or send other
annotation sets. Returned quotes are matched back to the named page locally;
unmatched quotes are rejected instead of being placed approximately.
AI grounding normalizes whitespace only, requires the complete source quote,
and rejects repeated passages unless the supplied context identifies one match.

The API key is saved in Obsidian's device-local application storage, outside
the vault, and is used only in request authentication. It is not copied into
plugin `data.json`, annotation files, or job checkpoints. This avoids syncing
the key with the vault, but the local application storage is not an encrypted
credential vault, so access to the local Obsidian profile should be protected
like access to the API key itself.
Keys are kept separately for each provider and endpoint. Running jobs use a
private snapshot of their original connection. Resuming a job with a different
provider selected is blocked before any request is sent.

## Parallel Annotation Sets and AI

Use the set button beside **Annotate** to create, rename, show, hide,
archive, or change the active annotation set. An eye means visible; a crossed-out
eye means hidden. Archived sets are listed read-only at the bottom. Both the set manager and AI controls open as non-modal
dropdown panels beneath their toolbar buttons. Click outside, press Escape,
or click the same button again to close them; dismissing AI controls does not
stop a running job. The AI panel selects an existing set and adds annotations
from a page range and prompt without replacing notes or changing your active
writing set. Create sets in the set manager, not in the AI dialog; the AI panel
remembers the set you last chose for each PDF. Provider, device-local API key,
and model controls are also available directly in the AI dialog, collapsed to
one line once a key and model are saved. Long jobs are checkpointed in small page batches
and can be paused, resumed, or cancelled.
Interrupted jobs reopen as paused and can continue from their last saved page
batch. Progress updates inside the job dialog as well as on the toolbar;
cancelling keeps annotations from completed batches.

Provider settings include OpenAI, Anthropic, Gemini, xAI, DeepSeek, GLM, Qwen,
Kimi, and custom OpenAI-compatible endpoints. Known key formats are detected
automatically. The model list shows suggested current models for each provider;
**Load more from provider** asks the provider for its live model list and adds
at most four distinct recent text models.
Dated snapshots and aliases share a slot; reasoning effort does not create a
separate model. Media and other specialized models are omitted from this picker.
Recency uses provider timestamps, Claude's documented newest-first order, or
version-number ordering when release dates are unavailable. The model field
remains editable for newly released IDs. Refreshing never changes the selected
model automatically. Protocol and authentication behavior remain provider presets so
ordinary users do not need to configure request JSON or headers.
Requests omit optional sampling parameters that newer reasoning models may
reject. Live model discovery supplies model names; a breaking provider API
change can still require a plugin update.

## Legacy Import

If you previously used `obsidian-annotator`, open the target PDF in this plugin
and run:

```text
Import legacy obsidian-annotator highlights for this PDF
```

The importer searches notes with `annotation-target:` frontmatter, re-anchors
quoted text in the PDF, and creates PDF Annotator highlights. Legacy notes are
left untouched.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` type-checks the plugin and produces `main.js`, `manifest.json`,
and `styles.css` in `dist/`.

Set `LOCAL_PDF_ANNOTATOR_PLUGIN_DIR` explicitly to install a build into a local
vault's `.obsidian/plugins/local-pdf-annotator` directory. The default build does
not modify an installed plugin.

For the optional ten-page book test, set `LPA_BOOK_FIXTURE` to a non-vault copy
of *Economic and Philosophic Manuscripts of 1844*, then run
`npm run test:book-two-sets`. The test uses temporary annotation files, not your
vault. `npm run test:live-book-ai` additionally requires `LPA_LIVE_API_KEY` for
its GLM integration test and makes paid provider calls; ordinary tests do not.

## Release Files

Obsidian installs community plugin releases from GitHub release assets. A
release must include:

- `main.js`
- `manifest.json`
- `styles.css`

The release tag must match the `version` field in `manifest.json`.

## Credits

Provider logos in the model picker come from
[LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT License,
Copyright (c) 2023 LobeHub). The logos are trademarks of their owners and are
used only to identify each provider.
