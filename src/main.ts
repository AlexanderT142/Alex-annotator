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
import { AnchoredPanel } from "./anchored-panel";
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
import {
  AI_PROVIDER_PRESETS,
  DEFAULT_AI_SETTINGS,
  detectProviderFromKey,
  listAiModels,
  normalizeAiSettings,
  presetFor,
  requestAiAnnotations,
  type AiConnectionSettings,
  type AiProviderId,
} from "./ai-provider";
import { AiJobService } from "./ai-jobs";
import { AiCredentialStore } from "./ai-credentials";

interface LpaSettings {
  /** Override Obsidian's core PDF viewer so clicking a PDF opens this view. */
  registerAsDefaultPdfHandler: boolean;
  /** Inject annotation mode into the native PDF view (experimental). */
  enableNativeOverlay: boolean;
  /** Legacy sidecar mode retained only for migration compatibility. */
  annotationStorageMode: AnnotationStorageMode;
  /** Vault-relative folder searched for legacy sidecars and used for exports. */
  annotationStorageFolder: string;
  /** Device-local AI connection. The key is never stored in the vault bundle. */
  ai: AiConnectionSettings;
}

const DEFAULT_SETTINGS: LpaSettings = {
  registerAsDefaultPdfHandler: false,
  enableNativeOverlay: true,
  annotationStorageMode: "folder",
  annotationStorageFolder: DEFAULT_ANNOTATION_FOLDER,
  ai: DEFAULT_AI_SETTINGS,
};

function coerceAnnotationStorageMode(value: string): AnnotationStorageMode {
  return value === "beside-pdf" ? "beside-pdf" : "folder";
}

export default class LocalPdfAnnotatorPlugin extends Plugin {
  settings!: LpaSettings;
  nativeOverlays!: NativeOverlayManager;
  bundleManager!: PdfBundleManager;
  aiJobs = new AiJobService();
  private credentials(): AiCredentialStore { return new AiCredentialStore(window.localStorage); }
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
          () => this.settings.ai,
          this.aiJobs,
          (patch) => this.configureAiConnection(patch)
        )
    );

    this.nativeOverlays = new NativeOverlayManager(
      this,
      () => this.settings.enableNativeOverlay,
      () => this.annotationPathOptions(),
      this.bundleManager,
      () => this.settings.ai,
      this.aiJobs,
      (patch) => this.configureAiConnection(patch)
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
            .exportAnnotations(file, `${this.settings.annotationStorageFolder}/Exports`)
            .then((path) => new Notice(`PDF Annotator: exported ${path}`))
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
        void this.bundleManager.onPdfRenamed(file, oldPath).catch((e) =>
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
        void this.bundleManager.onPdfDeleted(file.path).catch((e) =>
          console.error(`${LOG_TAG} failed to update deleted PDF bundle metadata`, e)
        );
      })
    );
    this.app.workspace.onLayoutReady(() => this.scheduleNativePdfRefresh());

    this.addSettingTab(new LpaSettingTab(this));

    console.log(`${LOG_TAG} loaded.`);
  }

  onunload(): void {
    AnchoredPanel.closeAll();
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
    const saved = (await this.loadData()) ?? {};
    const legacyApiKey = typeof saved?.ai?.apiKey === "string" ? saved.ai.apiKey.trim() : "";
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.annotationStorageMode = coerceAnnotationStorageMode(
      this.settings.annotationStorageMode
    );
    this.settings.annotationStorageFolder = normalizeAnnotationStorageFolder(
      this.settings.annotationStorageFolder
    );
    this.settings.ai = normalizeAiSettings(this.settings.ai);
    try {
      this.settings.ai.apiKey = this.credentials().migrate(this.settings.ai, legacyApiKey);
      if (legacyApiKey) await this.saveSettings();
    } catch {
      this.settings.ai.apiKey = legacyApiKey;
      new Notice("PDF Annotator: device-local key storage is unavailable. Key migration was not completed; the existing copy was preserved.");
    }
  }

  async saveSettings(): Promise<void> {
    const persisted: any = {
      ...this.settings,
      ai: { ...this.settings.ai },
    };
    delete persisted.ai.apiKey;
    await this.saveData(persisted);
  }

  async setAiApiKey(value: string): Promise<void> {
    const key = value.trim();
    this.settings.ai.apiKey = key;
    try { this.credentials().write(this.settings.ai, key); }
    catch { new Notice("The key works for this session, but could not be saved on this device."); }
    await this.saveSettings();
  }

  private readDeviceApiKey(): string {
    try {
      return this.credentials().read(this.settings.ai);
    } catch {
      return "";
    }
  }

  async selectAiConnection(provider: AiProviderId, baseUrl?: string): Promise<void> {
    const preset = presetFor(provider);
    this.settings.ai = { ...preset, provider, baseUrl: baseUrl ?? preset.baseUrl, model: preset.defaultModel, apiKey: "" };
    this.settings.ai.apiKey = this.readDeviceApiKey();
    await this.saveSettings();
  }

  async configureAiConnection(patch: Partial<AiConnectionSettings>): Promise<void> {
    if (patch.provider !== undefined || patch.baseUrl !== undefined) {
      await this.selectAiConnection(patch.provider ?? this.settings.ai.provider, patch.baseUrl);
    }
    if (patch.model !== undefined) this.settings.ai.model = patch.model.trim();
    if (patch.apiKey !== undefined) await this.setAiApiKey(patch.apiKey);
    else await this.saveSettings();
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

    new Setting(containerEl)
      .setName("Legacy annotation folder")
      .setDesc(
        `Existing path-based sidecars are imported from this folder. New annotations and a verified PDF backup are kept together in ${PDF_BUNDLE_LIBRARY}.`
      )
      .addText((t) => {
        t
          .setPlaceholder(DEFAULT_ANNOTATION_FOLDER)
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

    containerEl.createEl("h2", { text: "AI annotation" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Paste a provider key, choose its provider when the key prefix is ambiguous, and choose a model. PDF Annotator owns the request format and endpoint. Keys stay in Obsidian's device-local app storage outside the vault, but that storage is not encrypted.",
    });

    new Setting(containerEl)
      .setName("AI provider")
      .setDesc("The plugin maintains the protocol and endpoint for this provider.")
      .addDropdown((dropdown) => {
        for (const preset of AI_PROVIDER_PRESETS) dropdown.addOption(preset.id, preset.name);
        dropdown.setValue(this.plugin.settings.ai.provider).onChange(async (value) => {
          await this.plugin.selectAiConnection(value as AiProviderId);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Saved in Obsidian's device-local app storage, outside the vault. It is never written to plugin data, a PDF bundle, annotation, job checkpoint, or log.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.setPlaceholder("Paste provider key").setValue(this.plugin.settings.ai.apiKey).onChange(async (value) => {
          // An explicitly chosen compatible endpoint must never be replaced
          // just because its key resembles a first-party provider's key.
          const detected = this.plugin.settings.ai.provider === "custom" ? null : detectProviderFromKey(value);
          const providerChanged = !!detected && detected !== this.plugin.settings.ai.provider;
          if (detected && detected !== this.plugin.settings.ai.provider) {
            const preset = presetFor(detected);
            this.plugin.settings.ai.provider = detected;
            this.plugin.settings.ai.protocol = preset.protocol;
            this.plugin.settings.ai.baseUrl = preset.baseUrl;
            this.plugin.settings.ai.model = preset.defaultModel;
          }
          await this.plugin.setAiApiKey(value);
          if (providerChanged) this.display();
        });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Choose from up to four recent text models, or enter a model ID. Refreshing the list discovers new releases without a plugin update.")
      .addText((text) =>
        text.setPlaceholder("model-id").setValue(this.plugin.settings.ai.model).onChange(async (value) => {
          this.plugin.settings.ai.model = value.trim();
          await this.plugin.saveSettings();
        })
      )
      .addButton((button) =>
        button.setButtonText("Choose current model").onClick(async () => {
          button.setDisabled(true).setButtonText("Loading…");
          try {
            const models = await listAiModels(this.plugin.settings.ai);
            if (!models.length) {
              new Notice("The provider did not return any selectable models.");
            } else {
              new AiModelModal(this.plugin, models, () => this.display()).open();
            }
          } catch (error: any) {
            new Notice(`Could not load models — ${error?.message ?? error}`);
          } finally {
            button.setDisabled(false).setButtonText("Choose current model");
          }
        })
      );

    if (this.plugin.settings.ai.provider === "custom") {
      new Setting(containerEl)
        .setName("Custom base URL")
        .setDesc("Advanced: only needed for a custom OpenAI-compatible service.")
        .addText((text) =>
          text.setValue(this.plugin.settings.ai.baseUrl).onChange(async (value) => {
            const model = this.plugin.settings.ai.model;
            await this.plugin.selectAiConnection("custom", value.trim().replace(/\/+$/, ""));
            this.plugin.settings.ai.model = model;
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName("Connection check")
      .setDesc("Makes one small real request to the selected provider and validates structured annotation JSON.")
      .addButton((button) =>
        button.setButtonText("Test key and model").onClick(async () => {
          button.setDisabled(true).setButtonText("Testing…");
          try {
            await requestAiAnnotations(
              this.plugin.settings.ai,
              "Create one short explanatory annotation for the test sentence.",
              [{ pageNumber: 1, text: "This is a connection test sentence." }]
            );
            new Notice("PDF Annotator: AI key, endpoint, model, and JSON response are working.");
          } catch (error: any) {
            console.error(`${LOG_TAG} AI connection check failed (key redacted)`, error?.message ?? error);
            new Notice(`PDF Annotator: AI connection failed — ${error?.message ?? error}`);
          } finally {
            button.setDisabled(false).setButtonText("Test key and model");
          }
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
}

class AiModelModal extends FuzzySuggestModal<string> {
  constructor(private plugin: LocalPdfAnnotatorPlugin, private models: string[], private changed: () => void) {
    super(plugin.app);
    this.setPlaceholder("Choose from up to four recent models");
  }

  getItems(): string[] {
    return this.models;
  }

  getItemText(model: string): string {
    return model;
  }

  onChooseItem(model: string): void {
    this.plugin.settings.ai.model = model;
    void this.plugin.saveSettings().then(() => {
      this.changed();
      new Notice(`PDF Annotator: using ${model}`);
    });
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
