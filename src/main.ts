/**
 * main.ts — PDF Annotator plugin entry point.
 *
 * Triggers (all public, documented API):
 *   - command "Open current PDF in annotator" (stable custom-view fallback)
 *   - file-open bridge: ordinary .pdf clicks are redirected into this view
 *   - native overlay (experimental): an "Annotate" toggle injected into the
 *     native PDF view's toolbar layers annotation tools onto Obsidian's own
 *     viewer without replacing it (see native-overlay.ts)
 */
import {
  FuzzySuggestModal,
  Plugin,
  TFile,
  WorkspaceLeaf,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { PdfAnnotatorView, VIEW_TYPE_PDF_ANNOTATOR } from "./view";
import { initPdfEngine, disposePdfEngine, LOG_TAG } from "./pdf-engine";
import { NativeOverlayManager } from "./native-overlay";
import {
  DEFAULT_ANNOTATION_FOLDER,
  normalizeAnnotationStorageFolder,
  type AnnotationPathOptions,
  type AnnotationStorageMode,
} from "./annotations";
import {
  DEFAULT_RECOVERY_FOLDER,
  PDF_BUNDLE_LIBRARY,
  PdfBundleManager,
  type PdfBundleBinding,
} from "./bundles";

interface LpaSettings {
  /** Override Obsidian's core PDF viewer so clicking a PDF opens this view. */
  registerAsDefaultPdfHandler: boolean;
  /** Inject annotation mode into the native PDF view (experimental). */
  enableNativeOverlay: boolean;
  /** Legacy sidecar mode retained only for migration compatibility. */
  annotationStorageMode: AnnotationStorageMode;
  /** Vault-relative folder searched for legacy sidecars and used for exports. */
  annotationStorageFolder: string;
  /** Custom palette colors for annotation tools (up to 5 colors). */
  paletteColors: string[];
  /** Wrap extracted notes in a <mark style="background: COLOR;"> tag. */
  wrapExtractedNotesWithMark: boolean;
  /** Custom template for note exports using {{annotation_note}} placeholder. */
  exportTemplate: string;
}

const DEFAULT_SETTINGS: LpaSettings = {
  registerAsDefaultPdfHandler: false,
  enableNativeOverlay: true,
  annotationStorageMode: "folder",
  annotationStorageFolder: DEFAULT_ANNOTATION_FOLDER,
  paletteColors: ["#ff0000a6", "#00ff00a6", "#0000ffa6", "#ffff00a6"],
  wrapExtractedNotesWithMark: false,
  exportTemplate: "{{annotation_note}}",
};

function coerceAnnotationStorageMode(value: string): AnnotationStorageMode {
  return value === "beside-pdf" ? "beside-pdf" : "folder";
}

export default class LocalPdfAnnotatorPlugin extends Plugin {
  settings!: LpaSettings;
  nativeOverlays!: NativeOverlayManager;
  bundleManager!: PdfBundleManager;
  private replacingCorePdfView = false;
  private nativePdfRefreshRaf: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.bundleManager = new PdfBundleManager(this.app);

    // Configure + self-verify our bundled pdf.js worker up front so the console
    // shows the version match before any PDF is opened.
    const status = initPdfEngine();
    if (!status.ok) {
      new Notice("PDF Annotator: pdf.js version self-check failed — see console.");
    }

    this.registerView(
      VIEW_TYPE_PDF_ANNOTATOR,
      (leaf: WorkspaceLeaf) =>
        new PdfAnnotatorView(
          leaf,
          () => this.annotationPathOptions(),
          this.bundleManager,
          () => this.settings.paletteColors
        )
    );

    this.nativeOverlays = new NativeOverlayManager(
      this,
      () => this.settings.enableNativeOverlay,
      () => this.annotationPathOptions(),
      this.bundleManager,
      () => this.settings.paletteColors
    );

    // Trigger 1: command palette.
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

    // Toggle the experimental annotation overlay on the native PDF view.
    this.addCommand({
      id: "toggle-native-annotation-mode",
      name: "Toggle annotation mode on the native PDF view",
      checkCallback: (checking: boolean) => {
        if (!this.settings.enableNativeOverlay) return false;
        const leaf = this.app.workspace.activeLeaf;
        const ready = !!leaf && leaf.view.getViewType() === "pdf";
        if (ready && !checking) void this.nativeOverlays.toggle(leaf!);
        return ready;
      },
    });

    // Migrate highlights from the old obsidian-annotator notes for the open PDF.
    // Works in the custom annotator view AND in native overlay mode.
    this.addCommand({
      id: "import-legacy-annotations",
      name: "Import legacy obsidian-annotator highlights for this PDF",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PdfAnnotatorView);
        if (view && view.file) {
          if (!checking) void view.importLegacyAnnotations();
          return true;
        }
        const overlay = this.nativeOverlays.activeOverlay();
        if (overlay) {
          if (!checking) void overlay.importLegacyAnnotations();
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "restore-backed-up-pdf",
      name: "Restore a PDF from annotation backup",
      callback: async () => {
        const bundles = await this.bundleManager.listBundles();
        if (!bundles.length) {
          new Notice("PDF Annotator: no managed PDF backups found.");
          return;
        }
        new PdfBackupRestoreModal(this, bundles).open();
      },
    });

    this.addCommand({
      id: "export-current-pdf-annotations",
      name: "Export annotations for current PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "pdf") return false;
        if (!checking) {
          void this.bundleManager
            .exportAnnotations(file, `${this.settings.annotationStorageFolder}`, this.settings.exportTemplate)
            .then((path: string) => new Notice(`PDF Annotator: exported ${path}`))
            .catch((e: any) => {
              console.error(`${LOG_TAG} failed to export PDF annotations`, e);
              new Notice(`PDF Annotator: export failed — ${e?.message ?? e}`);
            });
        }
        return true;
      },
    });

    this.addCommand({
      id: "verify-pdf-annotation-backups",
      name: "Verify all PDF annotation backups",
      callback: async () => {
        const bundles = await this.bundleManager.listBundles();
        if (!bundles.length) {
          new Notice("PDF Annotator: no managed PDF backups found.");
          return;
        }
        let failed = 0;
        for (const bundle of bundles) {
          const result = await this.bundleManager.verifyBundle(bundle);
          if (!result.ok) {
            failed++;
            console.error(
              `${LOG_TAG} backup verification failed for ${bundle.manifest.originalName}: ${result.reason}`
            );
          }
        }
        new Notice(
          failed
            ? `PDF Annotator: ${failed} of ${bundles.length} backups failed verification — see console.`
            : `PDF Annotator: verified ${bundles.length} PDF backup${bundles.length === 1 ? "" : "s"}.`
        );
      },
    });

    // Trigger 2: ordinary file clicks. Obsidian's core PDF view owns the "pdf"
    // extension, so registerExtensions cannot override it safely. Instead, use
    // the public file-open event and replace the active core PDF leaf.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.scheduleNativePdfRefresh();
        if (file instanceof TFile && file.extension === "pdf") {
          void this.openPdfClickInAnnotator(file);
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.scheduleNativePdfRefresh())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.scheduleNativePdfRefresh())
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || file.extension !== "pdf") return;
        void this.bundleManager.onPdfRenamed(file, oldPath).catch((e: any) =>
          console.error(`${LOG_TAG} failed to update PDF bundle path metadata`, e)
        );
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR)) {
          const view = leaf.view;
          if (view instanceof PdfAnnotatorView) view.syncPdfPath(file);
        }
        this.nativeOverlays.syncPdfPath(file);
        this.scheduleNativePdfRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile) || file.extension !== "pdf") return;
        void this.bundleManager.onPdfDeleted(file.path).catch((e: any) =>
          console.error(`${LOG_TAG} failed to update deleted PDF bundle metadata`, e)
        );
      })
    );
    this.app.workspace.onLayoutReady(() => this.scheduleNativePdfRefresh());

    this.addSettingTab(new LpaSettingTab(this));

    console.log(`${LOG_TAG} loaded.`);
  }

  onunload(): void {
    if (this.nativePdfRefreshRaf !== null) {
      window.cancelAnimationFrame(this.nativePdfRefreshRaf);
      this.nativePdfRefreshRaf = null;
    }
    // Detach native overlays (removes injected DOM, observers, listeners) …
    this.nativeOverlays.disable();
    // … tear down our views (cancels pdf.js tasks, destroys docs) …
    this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR).forEach((leaf) => leaf.detach());
    // … then revoke the worker Blob URL.
    disposePdfEngine();
    console.log(`${LOG_TAG} unloaded.`);
  }

  async openInAnnotator(file: TFile, paneType: "tab" | "split" | false = "tab"): Promise<void> {
    const leaf = this.findExistingLeafForFile(file) ?? this.app.workspace.getLeaf(paneType);
    await this.setLeafToAnnotator(leaf, file);
  }

  private async setLeafToAnnotator(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    await leaf.setViewState({
      type: VIEW_TYPE_PDF_ANNOTATOR,
      state: { file: file.path },
      active: true,
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private findExistingLeafForFile(file: TFile): WorkspaceLeaf | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf && this.leafContainsFile(activeLeaf, file)) {
      return activeLeaf;
    }

    for (const viewType of ["pdf", VIEW_TYPE_PDF_ANNOTATOR]) {
      for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
        if (this.leafContainsFile(leaf, file)) return leaf;
      }
    }

    return null;
  }

  private leafContainsFile(leaf: WorkspaceLeaf, file: TFile): boolean {
    const leafFile = (leaf.view as { file?: unknown }).file;
    return leafFile instanceof TFile && leafFile.path === file.path;
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
        await this.setLeafToAnnotator(leaf, file);
      } finally {
        this.replacingCorePdfView = false;
      }
      return;
    }
  }

  /** Debounced sync of the native-PDF-view integration (toolbar controls +
   * overlay lifecycle). The overlay itself never calls setViewState. */
  private scheduleNativePdfRefresh(): void {
    if (this.nativePdfRefreshRaf !== null) return;
    this.nativePdfRefreshRaf = window.requestAnimationFrame(() => {
      this.nativePdfRefreshRaf = null;
      this.nativeOverlays.refresh();
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.paletteColors)) {
      this.settings.paletteColors = [...DEFAULT_SETTINGS.paletteColors];
    }
    this.settings.annotationStorageMode = coerceAnnotationStorageMode(
      this.settings.annotationStorageMode
    );
    this.settings.annotationStorageFolder = normalizeAnnotationStorageFolder(
      this.settings.annotationStorageFolder
    );
    if (typeof this.settings.exportTemplate !== "string") {
      this.settings.exportTemplate = DEFAULT_SETTINGS.exportTemplate;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  annotationPathOptions(): AnnotationPathOptions {
    return {
      storageMode: this.settings.annotationStorageMode,
      storageFolder: this.settings.annotationStorageFolder,
    };
  }
}

class LpaSettingTab extends PluginSettingTab {
  constructor(private plugin: LocalPdfAnnotatorPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Color Palette Settings ---
    containerEl.createEl("h3", { text: "Color Palette" });
    const paletteContainer = containerEl.createDiv({ cls: "palette-settings-container" });
    this.renderPaletteSettings(paletteContainer);

    // --- General Settings ---
    containerEl.createEl("h3", { text: "General Settings" });

    new Setting(containerEl)
      .setName("Export Template")
      .setDesc("Define the template for exported notes. Use {{annotation_note}} as a placeholder for the extracted annotations.")
      .addTextArea((text) =>
        text
          .setPlaceholder("{{annotation_note}}")
          .setValue(this.plugin.settings.exportTemplate)
          .onChange(async (value) => {
            this.plugin.settings.exportTemplate = value.trim() ? value : "{{annotation_note}}";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Wrap extracted notes with mark tag")
      .setDesc("When enabled, extracted notes will be wrapped in a <mark style=\"background: COLOR;\"> tag using the annotation's color.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.wrapExtractedNotesWithMark)
          .onChange(async (value) => {
            this.plugin.settings.wrapExtractedNotesWithMark = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Legacy annotation folder")
      .setDesc(
        `Existing path-based sidecars are imported from this folder. New annotations and a verified PDF backup are kept together in ${PDF_BUNDLE_LIBRARY}.`
      )
      .addText((t) => {
        t.setPlaceholder(DEFAULT_ANNOTATION_FOLDER)
          .setValue(this.plugin.settings.annotationStorageFolder)
          .onChange(async (v) => {
            this.plugin.settings.annotationStorageFolder = normalizeAnnotationStorageFolder(v);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Annotate inside the native PDF view (experimental)")
      .setDesc(
        "Adds an “Annotate” toggle to Obsidian's own PDF toolbar. Annotation tools are layered " +
          "onto the native viewer — its toolbar, sidebar, zoom, and navigation stay untouched. " +
          "Uses the same sidecar files as the annotator view."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableNativeOverlay).onChange(async (v) => {
          this.plugin.settings.enableNativeOverlay = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.nativeOverlays.refresh();
          else this.plugin.nativeOverlays.disable();
        })
      );

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
          new Notice(v ? "PDF clicks will open in PDF Annotator." : "PDF clicks will use Obsidian's core PDF viewer.");
        })
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The command “Open current PDF in annotator” remains available as a stable custom-view fallback.",
    });
  }

  private renderPaletteSettings(containerEl: HTMLElement): void {
    containerEl.empty();

    this.plugin.settings.paletteColors.forEach((color, index) => {
      const setting = new Setting(containerEl).setName(`Color ${index + 1}`);

      // Visual color picker (standard 6-digit) synchronized with the full value
      setting.addColorPicker((picker) => {
        const baseHex = color.startsWith("#") ? color.slice(0, 7) : "#ff0000";
        picker
          .setValue(baseHex.length === 7 ? baseHex : "#ff0000")
          .onChange(async (newBaseColor) => {
            const alphaSuffix = color.length === 9 ? color.slice(7, 9) : "a6";
            const updatedColor = `${newBaseColor}${alphaSuffix}`;
            this.plugin.settings.paletteColors[index] = updatedColor;
            await this.plugin.saveSettings();
            this.renderPaletteSettings(containerEl);
          });
      });

      // Text box that freely supports HEX strings up to 8 digits (plus hash)
      setting.addText((text) => {
        text
          .setPlaceholder("#ff5582a6")
          .setValue(color)
          .onChange(async (newColor) => {
            this.plugin.settings.paletteColors[index] = newColor.trim();
            await this.plugin.saveSettings();
          });
      });

      setting.addButton((button) => {
        button
          .setButtonText("Remove")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.paletteColors.splice(index, 1);
            await this.plugin.saveSettings();
            this.renderPaletteSettings(containerEl);
          });
      });
    });

    if (this.plugin.settings.paletteColors.length < 5) {
      new Setting(containerEl).addButton((button) => {
        button
          .setButtonText("Add Color")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.paletteColors.push("#ff5582a6");
            await this.plugin.saveSettings();
            this.renderPaletteSettings(containerEl);
          });
      });
    }
  }
}

class PdfBackupRestoreModal extends FuzzySuggestModal<PdfBundleBinding> {
  constructor(
    private plugin: LocalPdfAnnotatorPlugin,
    private bundles: PdfBundleBinding[]
  ) {
    super(plugin.app);
    this.setPlaceholder("Choose a backed-up PDF to restore");
  }

  getItems(): PdfBundleBinding[] {
    return this.bundles;
  }

  getItemText(binding: PdfBundleBinding): string {
    const path = binding.manifest.currentPath ?? "working copy deleted";
    return `${binding.manifest.originalName} — ${path}`;
  }

  onChooseItem(binding: PdfBundleBinding): void {
    void this.restore(binding);
  }

  private async restore(binding: PdfBundleBinding): Promise<void> {
    try {
      const file = await this.plugin.bundleManager.restoreBundle(
        binding,
        DEFAULT_RECOVERY_FOLDER
      );
      new Notice(`PDF Annotator: restored ${file.path}`);
      await this.plugin.openInAnnotator(file, "tab");
    } catch (e: any) {
      console.error(`${LOG_TAG} failed to restore PDF backup`, e);
      new Notice(`PDF Annotator: restore failed — ${e?.message ?? e}`);
    }
  }
}