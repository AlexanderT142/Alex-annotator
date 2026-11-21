import { App, Notice, Setting } from "obsidian";
import { AnnotationSetWorkspace } from "./annotation-sets";
import { AiJobService, type AiAnnotationJobState, type AiJobContext } from "./ai-jobs";
import { AI_PROVIDER_PRESETS, listAiModels, modelDisplayName, modelVendor, safeProviderError, type AiProviderId, type AiConnectionSettings, type ConfigureAiConnection } from "./ai-provider";
import { connectionIdentity } from "./ai-credentials";
import { AnchoredPanel } from "./anchored-panel";
import { modelPicker, providerPicker, renderLogo } from "./ai-picker";

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
  /** Show provider, key and model fields even when a key is already saved. */
  private connectionOpen = false;
  /** Update the connection summary without rebuilding the form (keeps focus while typing). */
  private refreshStatus?: () => void;

  constructor(app: App, private options: AiAnnotationModalOptions) {
    super(app, options.anchor, 560);
    this.setId = preferredSetId(options.workspace, options.jobsRootPath);
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
    const pageCount = Number(this.options.pdfDoc?.numPages ?? 1);
    const form = contentEl.createDiv({ cls: "lpa-ai-form" });

    const setField = field(form, "Target set");
    const select = setField.createEl("select", { cls: "dropdown" });
    for (const set of this.options.workspace.listSets()) select.createEl("option", { value: set.id, text: set.name });
    select.value = this.setId;
    select.onchange = () => {
      this.setId = select.value;
      rememberSetId(this.options.jobsRootPath, this.setId);
    };
    form.createDiv({ cls: "lpa-ai-hint", text: "Existing notes are kept. New sets are made in Annotation sets." });

    const pages = field(form, "Pages").createDiv({ cls: "lpa-ai-pages" });
    const pageInput = (value: number, label: string, set: (n: number) => void) => {
      const input = pages.createEl("input", { attr: { type: "number", min: "1", max: String(pageCount), "aria-label": label } });
      input.value = String(value);
      input.oninput = () => set(Number(input.value));
    };
    pageInput(this.fromPage, "First page", (n) => { this.fromPage = n; });
    pages.createSpan({ cls: "lpa-ai-pages-sep", text: "to" });
    pageInput(this.toPage, "Last page", (n) => { this.toPage = n; });
    pages.createSpan({ cls: "lpa-ai-pages-total", text: `of ${pageCount}` });

    const promptField = field(form, "Prompt", true);
    const prompt = promptField.createEl("textarea", { cls: "lpa-ai-prompt", attr: { rows: "4", "aria-label": "Prompt" } });
    prompt.value = this.prompt;
    prompt.oninput = () => { this.prompt = prompt.value; };

    this.renderConnection(form);

    contentEl.createDiv({ cls: "lpa-ai-privacy", text: "Only the text of these pages and your prompt are sent." });

    const jobsHeading = contentEl.createEl("h3", { text: "Jobs for this PDF" });
    jobsHeading.addClass("lpa-ai-jobs-heading");
    const jobsEl = contentEl.createDiv({ cls: "lpa-ai-jobs" });
    this.jobsEl = jobsEl;
    void this.renderJobs(jobsEl);
  }

  private renderConnection(container: HTMLElement): void {
    const connection = this.options.getConnection();
    const configure = this.options.configureConnection;
    const preset = AI_PROVIDER_PRESETS.find((candidate) => candidate.id === connection.provider);
    const ready = !!connection.apiKey.trim() && !!connection.model.trim();
    const open = !!configure && (this.connectionOpen || !ready);

    if (open && configure) {
      const fields = container.createDiv({ cls: "lpa-ai-connection-fields" });
      providerPicker(field(fields, "Provider"), connection.provider, async (provider: AiProviderId) => {
        try {
          this.connectionOpen = true;
          await configure({ provider });
          this.render();
        } catch { new Notice("Could not save the provider selection."); }
      });
      if (connection.provider === "custom") {
        let endpoint = connection.baseUrl;
        const row = field(fields, "Custom endpoint").createDiv({ cls: "lpa-ai-inline" });
        const input = row.createEl("input", { attr: { type: "text", placeholder: "https://…/v1", "aria-label": "Custom endpoint" } });
        input.value = endpoint;
        input.oninput = () => { endpoint = input.value.trim(); };
        const apply = row.createEl("button", { text: "Apply", attr: { type: "button" } });
        apply.onclick = async () => {
          try {
            connectionIdentity({ ...connection, baseUrl: endpoint });
            await configure({ baseUrl: endpoint, model: connection.model });
            this.render();
          } catch { new Notice("Enter a valid HTTPS base URL (HTTP is allowed for localhost)."); }
        };
      }
      const keyField = field(fields, "API key");
      const key = keyField.createEl("input", { attr: { type: "password", autocomplete: "off", "aria-label": "API key" } });
      // Never populate the DOM with the previously saved credential.
      key.placeholder = connection.apiKey ? "Saved key · paste to replace" : "Paste API key";
      const keyHint = fields.createDiv({ cls: "lpa-ai-hint", text: "Stored only on this device, outside your vault (not encrypted)." });
      key.oninput = async () => {
        try {
          if (connectionIdentity(this.options.getConnection()) !== connectionIdentity(connection)) return;
          await configure({ apiKey: key.value });
          keyHint.setText(key.value.trim() ? "Key saved on this device, outside your vault (not encrypted)." : "No key saved. Paste this provider’s key.");
        } catch { new Notice("Could not save the API key."); }
      };
      modelPicker(field(fields, "Model"), {
        provider: connection.provider,
        value: connection.model,
        onChange: async (model) => {
          try {
            if (connectionIdentity(this.options.getConnection()) !== connectionIdentity(connection)) return;
            await configure({ model });
            this.refreshStatus?.();
          } catch { new Notice("Could not save the model."); }
        },
        loadProviderModels: async () => {
          const snapshot = { ...this.options.getConnection() };
          if (!snapshot.apiKey.trim()) throw new Error("Paste an API key above first.");
          try { return await listAiModels(snapshot); }
          catch (error) { throw new Error(`Could not load models: ${safeProviderError(error, snapshot.apiKey).message}`); }
        },
      });
    }

    const bar = container.createDiv({ cls: "lpa-ai-action-bar" });
    const status = bar.createDiv({ cls: "lpa-ai-connection-status" });
    const statusText = status.createSpan();
    this.refreshStatus = () => {
      const current = this.options.getConnection();
      const currentReady = !!current.apiKey.trim() && !!current.model.trim();
      statusText.empty();
      if (currentReady) {
        statusText.className = "lpa-ai-connection-name";
        renderLogo(statusText, modelVendor(current.model, current.provider));
        statusText.createSpan({ text: `${preset?.name ?? current.provider} · ${modelDisplayName(current.model) ?? current.model}` });
        statusText.title = current.model;
      } else {
        statusText.className = "lpa-ai-connection-missing";
        statusText.setText(current.apiKey.trim() ? "Choose a model to start" : "Add an API key to start");
      }
    };
    this.refreshStatus();
    if (configure && ready) {
      const toggle = status.createEl("button", { cls: "lpa-ai-change", text: open ? "Done" : "Change", attr: { type: "button" } });
      toggle.onclick = () => { this.connectionOpen = !open; this.render(); };
    }
    const start = bar.createEl("button", { cls: "mod-cta", text: "Start annotation job", attr: { type: "button" } });
    start.onclick = async () => {
      start.disabled = true;
      try { await this.start(); } finally { start.disabled = false; }
    };
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
    rememberSetId(this.options.jobsRootPath, set.id);
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

/** A labelled block inside the AI panel. */
function field(container: HTMLElement, label: string, stacked = false): HTMLElement {
  const row = container.createDiv({ cls: `lpa-ai-field${stacked ? " is-stacked" : ""}` });
  row.createEl("label", { cls: "lpa-ai-label", text: label });
  return row.createDiv({ cls: "lpa-ai-control" });
}

const LAST_SET_KEY = "pdf-annotator:ai-last-set";

/** The set chosen last for this PDF, else the newest AI set, else the active set. */
function preferredSetId(workspace: AnnotationSetWorkspace, jobsRootPath: string): string {
  const sets = workspace.listSets();
  let remembered: string | undefined;
  try { remembered = JSON.parse(window.localStorage.getItem(LAST_SET_KEY) ?? "{}")[jobsRootPath]; } catch { remembered = undefined; }
  if (remembered && sets.some((set) => set.id === remembered)) return remembered;
  const ai = sets.filter((set) => set.kind === "ai");
  if (ai.length) return ai[ai.length - 1].id;
  return workspace.activeSet().id;
}

function rememberSetId(jobsRootPath: string, setId: string): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(LAST_SET_KEY) ?? "{}");
    all[jobsRootPath] = setId;
    window.localStorage.setItem(LAST_SET_KEY, JSON.stringify(all));
  } catch {
    // Remembering is a convenience only.
  }
}
