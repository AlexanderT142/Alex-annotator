import { App, FuzzySuggestModal, Modal, Notice, Setting } from "obsidian";
import { AnnotationSetWorkspace } from "./annotation-sets";
import { AiJobService, type AiAnnotationJobState, type AiJobContext } from "./ai-jobs";
import { AI_PROVIDER_PRESETS, listAiModels, safeProviderError, type AiProviderId, type AiConnectionSettings, type ConfigureAiConnection } from "./ai-provider";
import { connectionIdentity } from "./ai-credentials";
import { AnchoredPanel } from "./anchored-panel";

export interface AiAnnotationModalOptions {
  anchor?: HTMLElement;
  workspace: AnnotationSetWorkspace;
  pdfDoc: any;
  jobsRootPath: string;
  getConnection: () => AiConnectionSettings;
  configureConnection?: ConfigureAiConnection;
  jobService: AiJobService;
  changed: () => void;
}

export class AiAnnotationModal extends AnchoredPanel {
  private setId: string;
  private fromPage = 1;
  private toPage: number;
  private prompt = "Explain important ideas and useful connections as a thoughtful reading partner.";
  private starting = false;
  private unsubscribe?: () => void;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private jobsEl?: HTMLElement;
  private jobRows = new Map<string, { row: Setting; phase: string }>();

  constructor(app: App, private options: AiAnnotationModalOptions) {
    super(app, options.anchor, 620);
    this.setId = options.workspace.activeSet().id;
    this.toPage = Math.min(10, Number(options.pdfDoc?.numPages ?? 1));
  }

  onOpen(): void {
    this.setTitle("Annotate with AI");
    this.modalEl.addClass("lpa-ai-modal");
    this.render();
    this.unsubscribe = this.options.jobService.subscribe((job) => {
      if (job.jobsRootPath !== this.options.jobsRootPath) return;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        if (this.jobsEl && this.contentEl.isConnected) void this.renderJobs(this.jobsEl);
      }, 150);
    });
  }

  onClose(): void {
    this.unsubscribe?.();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.jobRows.clear();
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Only extracted text from the chosen pages and your prompt are sent to the selected provider. " +
        "The PDF file itself and existing annotations are not sent.",
    });

    new Setting(contentEl).setName("Annotation set")
      .setDesc("Choose an existing set. AI notes are added without replacing its notes or changing your active writing set. Create sets in Annotation sets.")
      .addDropdown((dropdown) => {
        for (const set of this.options.workspace.listSets()) dropdown.addOption(set.id, set.name);
        dropdown.setValue(this.setId).onChange((value) => { this.setId = value; });
      });
    this.renderConnection(contentEl);
    new Setting(contentEl)
      .setName("Page range")
      .setDesc(`PDF page positions 1–${this.options.pdfDoc.numPages}, including front matter`)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = String(this.options.pdfDoc.numPages);
        text.setValue(String(this.fromPage)).onChange((value) => {
          this.fromPage = Number(value);
        });
      })
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = String(this.options.pdfDoc.numPages);
        text.setValue(String(this.toPage)).onChange((value) => {
          this.toPage = Number(value);
        });
      });
    new Setting(contentEl).setClass("lpa-ai-prompt-setting").setName("Prompt").setDesc("What should the AI add to this set?").addTextArea((area) => {
      area.setValue(this.prompt).onChange((value) => {
        this.prompt = value;
      });
      area.inputEl.rows = 5;
      area.inputEl.addClass("lpa-ai-prompt");
    });

    new Setting(contentEl)
      .setName("Run AI annotation")
      .setDesc("Adds annotations to the selected set; existing notes are kept.")
      .addButton((button) =>
        button.setButtonText("Start annotation job").setCta().onClick(async () => {
          button.setDisabled(true);
          try { await this.start(); } finally { button.setDisabled(false); }
        })
      );

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Every returned quote is matched back to the named PDF page locally. Unmatched quotes are rejected rather than placed approximately.",
    });

    const jobsHeading = contentEl.createEl("h3", { text: "Jobs for this PDF" });
    jobsHeading.addClass("lpa-ai-jobs-heading");
    const jobsEl = contentEl.createDiv({ cls: "lpa-ai-jobs" });
    this.jobsEl = jobsEl;
    void this.renderJobs(jobsEl);
  }

  private renderConnection(container: HTMLElement): void {
    const connection = this.options.getConnection();
    const configure = this.options.configureConnection;
    if (!configure) return;
    new Setting(container).setName("Provider").addDropdown((dropdown) => {
      for (const preset of AI_PROVIDER_PRESETS) dropdown.addOption(preset.id, preset.name);
      dropdown.setValue(connection.provider).onChange(async (provider) => {
        dropdown.setDisabled(true);
        try {
          await configure({ provider: provider as AiProviderId });
          this.render();
        } catch { new Notice("Could not save the provider selection."); dropdown.setDisabled(false); }
      });
    });
    if (connection.provider === "custom") {
      let endpoint = connection.baseUrl;
      new Setting(container).setName("Custom endpoint")
        .setDesc("OpenAI-compatible base URL. Applying a different endpoint loads its own saved key.")
        .addText((text) => text.setValue(endpoint).onChange((value) => { endpoint = value.trim(); }))
        .addButton((button) => button.setButtonText("Apply").onClick(async () => {
          try {
            connectionIdentity({ ...connection, baseUrl: endpoint });
            await configure({ baseUrl: endpoint, model: connection.model });
            this.render();
          } catch { new Notice("Enter a valid HTTPS base URL (HTTP is allowed for localhost)."); }
        }));
    }
    const keySetting = new Setting(container).setName("API key")
      .setDesc(connection.apiKey ? "A key is saved for this provider on this device. Paste to replace it." : "Paste this provider’s key. Saved on this device, outside your vault; storage is not encrypted.");
    keySetting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      // Never populate the DOM with the previously saved credential.
      text.setPlaceholder(connection.apiKey ? "Saved key · paste to replace" : "Paste API key")
        .onChange(async (apiKey) => {
          try {
            if (connectionIdentity(this.options.getConnection()) !== connectionIdentity(connection)) return;
            await configure({ apiKey });
            keySetting.setDesc(apiKey.trim() ? "Key saved on this device, outside your vault; storage is not encrypted." : "No key saved. Paste this provider’s key.");
          } catch { new Notice("Could not save the API key."); }
        });
    });
    new Setting(container).setName("Model")
      .setDesc("Up to four recent text models, refreshed from the provider. You can also enter a model ID.")
      .addText((text) => text.setPlaceholder("Model ID").setValue(connection.model).onChange(async (model) => {
        try {
          if (connectionIdentity(this.options.getConnection()) !== connectionIdentity(connection)) return;
          await configure({ model });
        } catch { new Notice("Could not save the model."); }
      }))
      .addButton((button) => button.setButtonText("Choose model").onClick(async () => {
        const snapshot = { ...this.options.getConnection() };
        if (!snapshot.apiKey.trim()) { new Notice("Paste an API key above first."); return; }
        button.setDisabled(true).setButtonText("Loading…");
        try {
          const models = await listAiModels(snapshot);
          const stillCurrent = () => {
            const current = this.options.getConnection();
            return this.contentEl.isConnected && connectionIdentity(current) === connectionIdentity(snapshot) && current.apiKey === snapshot.apiKey;
          };
          if (!stillCurrent()) return;
          if (!models.length) { new Notice("No models returned. You can enter a model ID instead."); return; }
          new AnnotationModelPicker(this.app, models, async (model) => {
            if (!stillCurrent()) return;
            await configure({ model });
            this.render();
          }).open();
        } catch (error) { new Notice(`Could not load models: ${safeProviderError(error, snapshot.apiKey).message}`); }
        finally { button.setDisabled(false).setButtonText("Choose model"); }
      }));
  }

  private context(): AiJobContext {
    return {
      adapter: this.app.vault.adapter,
      jobsRootPath: this.options.jobsRootPath,
      pdfDoc: this.options.pdfDoc,
      workspace: this.options.workspace,
      getConnection: this.options.getConnection,
    };
  }

  private async start(): Promise<void> {
    const connection = this.options.getConnection();
    const pageCount = Number(this.options.pdfDoc?.numPages ?? 0);
    const from = this.fromPage;
    const to = this.toPage;
    if (!connection.apiKey.trim()) {
      new Notice("Paste an API key above first.");
      return;
    }
    if (!connection.model.trim()) {
      new Notice("Choose a model above first.");
      return;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > pageCount) {
      new Notice(`Choose a valid page range between 1 and ${pageCount}.`);
      return;
    }
    if (!this.prompt.trim()) {
      new Notice("Write a prompt for the AI annotation set.");
      return;
    }
    if (this.starting) return;
    const set = this.options.workspace.listSets().find((candidate) => candidate.id === this.setId);
    if (!set) { new Notice("Choose an existing, non-archived annotation set."); return; }
    this.starting = true;
    try {
      await this.options.jobService.start(this.context(), {
      setId: set.id,
      setName: set.name,
      fromPage: from,
      toPage: to,
      prompt: this.prompt,
    });
    this.options.changed();
    new Notice(`AI annotation started for pages ${from}–${to}.`);
      this.render();
    } catch (error: any) {
      new Notice(`Could not start AI annotation: ${error?.message ?? error}`);
    } finally { this.starting = false; }
  }

  private async renderJobs(container: HTMLElement): Promise<void> {
    let jobs: AiAnnotationJobState[];
    try { jobs = await this.options.jobService.list(this.context()); }
    catch (error: any) {
      container.setText(error?.message ?? "Could not load AI jobs.");
      return;
    }
    if (!this.contentEl.isConnected) return;
    if (!jobs.length) {
      container.empty();
      this.jobRows.clear();
      container.createEl("p", { cls: "setting-item-description", text: "No AI jobs for this PDF yet." });
      return;
    }
    if (!this.jobRows.size) container.empty();
    for (const [id, entry] of this.jobRows) {
      if (!jobs.some((job) => job.id === id)) { entry.row.settingEl.remove(); this.jobRows.delete(id); }
    }
    for (const job of jobs) this.renderJob(container, job);
  }

  private renderJob(container: HTMLElement, job: AiAnnotationJobState): void {
    const total = job.toPage - job.fromPage + 1;
    const percent = total > 0 ? Math.round((job.completedPages / total) * 100) : 0;
    const description = `${job.status}: ${job.message}${job.rejectedAnnotations ? ` · ${job.rejectedAnnotations} unmatched quotes skipped` : ""}`;
    const phase = job.status === "paused" || job.status === "failed" ? "resumable" : job.status === "completed" || job.status === "cancelled" ? "done" : "running";
    const existing = this.jobRows.get(job.id);
    if (existing?.phase === phase) {
      existing.row.setName(`${job.setName} · ${percent}%`).setDesc(description);
      return;
    }
    existing?.row.settingEl.remove();
    const row = new Setting(container).setName(`${job.setName} · ${percent}%`).setDesc(description);
    this.jobRows.set(job.id, { row, phase });
    if (job.status === "paused" || job.status === "failed") {
      row.addButton((button) =>
        button.setButtonText("Resume").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.options.jobService.resume(this.context(), job.id);
          } catch (error: any) { new Notice(error?.message ?? "Could not resume the job."); }
          finally { button.setDisabled(false); }
        })
      );
    } else if (job.status !== "completed" && job.status !== "cancelled") {
      row.addButton((button) =>
        button.setButtonText("Pause").onClick(() => this.options.jobService.pause(job.id))
      );
    }
    if (job.status !== "completed" && job.status !== "cancelled") row.addExtraButton((button) =>
      button.setIcon("x").setTooltip("Cancel; keep completed annotations").onClick(async () => {
        try { await this.options.jobService.cancel(job.id, this.context()); }
        catch (error: any) { new Notice(error?.message ?? "Could not cancel the job."); }
      })
    );
  }
}

class AnnotationModelPicker extends FuzzySuggestModal<string> {
  constructor(app: App, private models: string[], private choose: (model: string) => Promise<void>) {
    super(app);
    this.setPlaceholder("Choose from up to four recent models");
  }
  getItems(): string[] { return this.models; }
  getItemText(model: string): string { return model; }
  onChooseItem(model: string): void {
    void this.choose(model).catch(() => new Notice("Could not save the selected model."));
  }
}
