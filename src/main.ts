/**
 * main.ts — Local PDF Annotator plugin entry point.
 *
 * Triggers (all public, documented API):
 *   - file-menu "Annotate" item on .pdf files
 *   - command "Open current PDF in annotator"
 *   - file-open bridge: ordinary .pdf clicks are redirected into this view
 */
import { Plugin, TFile, WorkspaceLeaf, Notice, PluginSettingTab, Setting } from "obsidian";
import { PdfAnnotatorView, VIEW_TYPE_PDF_ANNOTATOR } from "./view";
import { initPdfEngine, disposePdfEngine, LOG_TAG } from "./pdf-engine";

interface LpaSettings {
  /** Override Obsidian's core PDF viewer so clicking a PDF opens this view. */
  registerAsDefaultPdfHandler: boolean;
}

const DEFAULT_SETTINGS: LpaSettings = {
  registerAsDefaultPdfHandler: false,
};

export default class LocalPdfAnnotatorPlugin extends Plugin {
  settings!: LpaSettings;
  private replacingCorePdfView = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Configure + self-verify our bundled pdf.js worker up front so the console
    // shows the version match before any PDF is opened.
    const status = initPdfEngine();
    if (!status.ok) {
      new Notice("Local PDF Annotator: pdf.js version self-check failed — see console.");
    }

    this.registerView(
      VIEW_TYPE_PDF_ANNOTATOR,
      (leaf: WorkspaceLeaf) => new PdfAnnotatorView(leaf)
    );

    // Trigger 1: file-menu "Annotate" on .pdf files.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "pdf") {
          menu.addItem((item) =>
            item
              .setTitle("Annotate")
              .setIcon("highlighter")
              .onClick(() => this.openInAnnotator(file, "tab"))
          );
        }
      })
    );

    // Trigger 2: command palette.
    this.addCommand({
      id: "open-current-pdf-in-annotator",
      name: "Open current PDF in annotator",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const isPdf = !!file && file.extension === "pdf";
        if (isPdf && !checking) this.openInAnnotator(file as TFile, "tab");
        return isPdf;
      },
    });

    // Migrate highlights from the old obsidian-annotator notes for the open PDF.
    this.addCommand({
      id: "import-legacy-annotations",
      name: "Import legacy obsidian-annotator highlights for this PDF",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PdfAnnotatorView);
        const ready = !!view && !!view.file;
        if (ready && !checking) void view!.importLegacyAnnotations();
        return ready;
      },
    });

    // Trigger 3: ordinary file clicks. Obsidian's core PDF view owns the "pdf"
    // extension, so registerExtensions cannot override it safely. Instead, use
    // the public file-open event and replace the active core PDF leaf.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile && file.extension === "pdf") {
          void this.openPdfClickInAnnotator(file);
        }
      })
    );

    this.addSettingTab(new LpaSettingTab(this));

    console.log(`${LOG_TAG} loaded.`);
  }

  onunload(): void {
    // Tear down our views first (cancels pdf.js tasks, destroys docs) …
    this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR).forEach((leaf) => leaf.detach());
    // … then revoke the worker Blob URL.
    disposePdfEngine();
    console.log(`${LOG_TAG} unloaded.`);
  }

  async openInAnnotator(file: TFile, paneType: "tab" | "split" | false = "tab"): Promise<void> {
    const leaf = this.app.workspace.getLeaf(paneType);
    await leaf.setViewState({
      type: VIEW_TYPE_PDF_ANNOTATOR,
      state: { file: file.path },
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  private async openPdfClickInAnnotator(file: TFile): Promise<void> {
    if (!this.settings.registerAsDefaultPdfHandler || this.replacingCorePdfView) return;
    for (const delayMs of [-1, 0, 16, 64]) {
      if (delayMs < 0) {
        await Promise.resolve();
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }

      const leaf = this.app.workspace.activeLeaf;
      if (!leaf) continue;
      if (leaf.view.getViewType() === VIEW_TYPE_PDF_ANNOTATOR) return;
      if (this.app.workspace.getActiveFile()?.path !== file.path) continue;

      this.replacingCorePdfView = true;
      try {
        await leaf.setViewState({
          type: VIEW_TYPE_PDF_ANNOTATOR,
          state: { file: file.path },
          active: true,
        });
        this.app.workspace.revealLeaf(leaf);
      } finally {
        this.replacingCorePdfView = false;
      }
      return;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class LpaSettingTab extends PluginSettingTab {
  constructor(private plugin: LocalPdfAnnotatorPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Local PDF Annotator" });

    new Setting(containerEl)
      .setName("Make this the default PDF viewer")
      .setDesc(
        "When enabled, ordinary .pdf clicks are redirected into this annotator. " +
          "This uses Obsidian's public file-open event and does not patch internal PDF-viewer state."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.registerAsDefaultPdfHandler).onChange(async (v) => {
          this.plugin.settings.registerAsDefaultPdfHandler = v;
          await this.plugin.saveSettings();
          new Notice(v ? "PDF clicks will open in Local PDF Annotator." : "PDF clicks will use Obsidian's core PDF viewer.");
        })
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Always available: right-click a PDF → “Annotate”, or use the command “Open current PDF in annotator”.",
    });
  }
}
