import { setIcon } from "obsidian";
import { AI_PROVIDER_PRESETS, modelDisplayName, modelVendor, suggestedModels, type AiProviderId } from "./ai-provider";
import { PROVIDER_LOGOS } from "./provider-logos";

/**
 * Provider and model pickers with logos, shared by the settings tab and the
 * Annotate with AI panel. The model field stays a plain text input, so any
 * model ID can still be typed; the list only makes the common choices easy.
 */

/** Put a provider's logo (or a neutral icon for unknown vendors) into `parent`. */
export function renderLogo(parent: HTMLElement, vendor: AiProviderId | null): HTMLElement {
  const el = parent.createSpan({ cls: "lpa-logo" });
  fillLogo(el, vendor);
  return el;
}

function fillLogo(el: HTMLElement, vendor: AiProviderId | null): void {
  el.empty();
  el.removeAttribute("data-vendor");
  const svgText = vendor && vendor !== "custom" ? PROVIDER_LOGOS[vendor] : null;
  if (!svgText) {
    setIcon(el, vendor === "custom" ? "plug" : "bot");
    return;
  }
  el.setAttribute("data-vendor", vendor!);
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
  if (parsed?.nodeName.toLowerCase() === "svg") el.appendChild(el.ownerDocument.importNode(parsed, true));
}

interface PickerItem {
  value: string;
  label: string;
  detail?: string;
  vendor: AiProviderId | null;
  section?: string;
}

interface PickerMenuOptions {
  anchor: HTMLElement;
  items: () => PickerItem[];
  selected: () => string;
  choose: (value: string) => void;
  /** An extra last row, e.g. to load the provider's own model list. */
  footer?: { label: string; run: () => Promise<void> };
  /** Keep focus on this element (the model text box) while the list is open. */
  keyTarget?: HTMLElement;
  onClose?: () => void;
}

/** A small list under its anchor. Lives on the anchor's document so it works in popout windows. */
class PickerMenu {
  readonly el: HTMLElement;
  private active = -1;
  private rows: Array<{ el: HTMLElement; value: string }> = [];
  private readonly doc: Document;
  private readonly cleanup: Array<() => void> = [];

  constructor(private options: PickerMenuOptions) {
    this.doc = options.anchor.ownerDocument;
    this.el = this.doc.body.createDiv({ cls: "lpa-picker-menu", attr: { role: "listbox", tabindex: "-1" } });
    this.render();
    this.position();
    const win = this.doc.defaultView ?? window;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (this.el.contains(target) || options.anchor.contains(target))) return;
      this.close();
    };
    const keys = (event: KeyboardEvent) => this.handleKey(event);
    const reposition = () => this.position();
    this.doc.addEventListener("pointerdown", outside, true);
    (options.keyTarget ?? this.el).addEventListener("keydown", keys);
    win.addEventListener("resize", reposition);
    this.doc.addEventListener("scroll", reposition, true);
    // Close when the control goes away, e.g. its dialog or settings window was closed.
    const watch = win.setInterval(() => { if (!options.anchor.isConnected) this.close(); }, 300);
    this.cleanup.push(
      () => win.clearInterval(watch),
      () => this.doc.removeEventListener("pointerdown", outside, true),
      () => (options.keyTarget ?? this.el).removeEventListener("keydown", keys),
      () => win.removeEventListener("resize", reposition),
      () => this.doc.removeEventListener("scroll", reposition, true),
    );
    if (!options.keyTarget) this.el.focus();
  }

  get isOpen(): boolean { return this.el.isConnected; }

  /** Drop the extra last row once it has done its job. */
  clearFooter(): void { this.options.footer = undefined; }

  render(): void {
    this.el.empty();
    this.rows = [];
    const items = this.options.items();
    const selected = this.options.selected();
    let section: string | undefined;
    for (const item of items) {
      if (item.section && item.section !== section) {
        section = item.section;
        this.el.createDiv({ cls: "lpa-picker-section", text: section });
      }
      const row = this.el.createDiv({ cls: "lpa-picker-item", attr: { role: "option" } });
      if (item.value === selected) { row.addClass("is-selected"); row.setAttribute("aria-selected", "true"); }
      renderLogo(row, item.vendor);
      const text = row.createDiv({ cls: "lpa-picker-text" });
      text.createDiv({ cls: "lpa-picker-label", text: item.label });
      if (item.detail) text.createDiv({ cls: "lpa-picker-detail", text: item.detail });
      if (item.value === selected) setIcon(row.createSpan({ cls: "lpa-picker-check" }), "check");
      row.addEventListener("pointerdown", (event) => event.preventDefault());
      row.addEventListener("click", () => this.pick(item.value));
      row.addEventListener("pointermove", () => this.highlight(this.rows.findIndex((r) => r.el === row)));
      this.rows.push({ el: row, value: item.value });
    }
    if (!items.length) this.el.createDiv({ cls: "lpa-picker-empty", text: "No matching models. Press Enter to use what you typed." });
    const footer = this.options.footer;
    if (footer) {
      const row = this.el.createDiv({ cls: "lpa-picker-item lpa-picker-footer" });
      setIcon(row.createSpan({ cls: "lpa-logo" }), "refresh-cw");
      row.createDiv({ cls: "lpa-picker-label", text: footer.label });
      row.addEventListener("pointerdown", (event) => event.preventDefault());
      row.addEventListener("click", () => void this.runFooter(row));
    }
    this.active = Math.max(-1, Math.min(this.active, this.rows.length - 1));
    if (this.active < 0) this.active = this.rows.findIndex((row) => row.value === selected);
    this.highlight(this.active);
  }

  private async runFooter(row: HTMLElement): Promise<void> {
    const footer = this.options.footer!;
    if (row.hasClass("is-loading")) return;
    row.addClass("is-loading");
    const label = row.querySelector(".lpa-picker-label");
    label?.setText("Loading…");
    try {
      await footer.run();
      if (this.isOpen) this.render();
    } catch (error: any) {
      row.removeClass("is-loading");
      label?.setText(error?.message ?? String(error));
      row.addClass("is-error");
    }
  }

  private highlight(index: number): void {
    this.active = index;
    this.rows.forEach((row, i) => row.el.toggleClass("is-active", i === index));
    this.rows[index]?.el.scrollIntoView({ block: "nearest" });
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!this.rows.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.highlight((this.active + step + this.rows.length) % this.rows.length);
    } else if (event.key === "Enter") {
      const row = this.rows[this.active];
      if (row) { event.preventDefault(); this.pick(row.value); }
      else if (this.options.keyTarget) this.close();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    } else if (event.key === "Tab") {
      this.close();
    }
  }

  private pick(value: string): void {
    this.close();
    this.options.choose(value);
  }

  position(): void {
    const box = this.options.anchor.getBoundingClientRect();
    const view = this.doc.documentElement;
    const width = Math.max(box.width, 280);
    // Controls on the right of a settings row open their list leftwards, so it stays inside the dialog.
    const preferred = box.left + box.width / 2 > view.clientWidth / 2 ? box.right - width : box.left;
    const left = Math.max(8, Math.min(preferred, view.clientWidth - width - 8));
    const below = view.clientHeight - box.bottom - 8;
    const above = box.top - 8;
    const openUp = below < 220 && above > below;
    this.el.style.width = `${width}px`;
    this.el.style.left = `${left}px`;
    this.el.style.maxHeight = `${Math.max(140, Math.min(360, openUp ? above : below))}px`;
    if (openUp) { this.el.style.top = ""; this.el.style.bottom = `${view.clientHeight - box.top + 4}px`; }
    else { this.el.style.bottom = ""; this.el.style.top = `${box.bottom + 4}px`; }
  }

  close(): void {
    if (!this.isOpen) return;
    this.cleanup.splice(0).forEach((undo) => undo());
    this.el.remove();
    this.options.onClose?.();
  }
}

/** A button showing the chosen provider's logo and name; opens a list of providers. */
export function providerPicker(container: HTMLElement, value: AiProviderId, onChange: (provider: AiProviderId) => void | Promise<void>): HTMLButtonElement {
  const button = container.createEl("button", { cls: "lpa-picker-button", attr: { type: "button", "aria-haspopup": "listbox", "aria-label": "AI provider" } });
  const preset = AI_PROVIDER_PRESETS.find((candidate) => candidate.id === value);
  renderLogo(button, value);
  button.createSpan({ cls: "lpa-picker-button-label", text: preset?.name ?? value });
  setIcon(button.createSpan({ cls: "lpa-picker-chevron" }), "chevrons-up-down");
  let menu: PickerMenu | null = null;
  button.onclick = () => {
    if (menu?.isOpen) { menu.close(); return; }
    menu = new PickerMenu({
      anchor: button,
      items: () => AI_PROVIDER_PRESETS.map((option) => ({ value: option.id, label: option.name, vendor: option.id })),
      selected: () => value,
      choose: (picked) => { if (picked !== value) void onChange(picked as AiProviderId); },
      onClose: () => button.focus(),
    });
  };
  return button;
}

export interface ModelPickerOptions {
  provider: AiProviderId;
  value: string;
  /** Called as the user types and when a model is picked from the list. */
  onChange: (model: string) => void | Promise<void>;
  /** Fetch the provider's own current models (needs a saved key). */
  loadProviderModels?: () => Promise<string[]>;
}

/** A model text box with the vendor logo on its left and a list of suggested models below it. */
export function modelPicker(container: HTMLElement, options: ModelPickerOptions): HTMLInputElement {
  const box = container.createDiv({ cls: "lpa-model-combo" });
  const logo = box.createSpan({ cls: "lpa-logo" });
  const input = box.createEl("input", {
    attr: { type: "text", placeholder: "Model ID, e.g. " + (suggestedModels(options.provider)[0]?.id ?? "model-id"), "aria-label": "Model", spellcheck: "false", autocomplete: "off" },
  });
  input.value = options.value;
  const toggle = box.createEl("button", { cls: "lpa-model-combo-toggle clickable-icon", attr: { type: "button", "aria-label": "Show models", tabindex: "-1" } });
  setIcon(toggle, "chevron-down");

  let providerModels: string[] = [];
  let filter = "";
  let menu: PickerMenu | null = null;
  const showLogo = () => fillLogo(logo, modelVendor(input.value, options.provider));
  showLogo();

  const items = (): PickerItem[] => {
    const query = filter.trim().toLowerCase();
    const matches = (id: string, name: string) => !query || id.toLowerCase().includes(query) || name.toLowerCase().includes(query);
    const suggested = suggestedModels(options.provider);
    const list: PickerItem[] = suggested
      .filter((model) => matches(model.id, model.name))
      .map((model) => ({ value: model.id, label: model.name, detail: `${model.id} · ${model.note}`, vendor: modelVendor(model.id, options.provider), section: "Suggested" }));
    for (const id of providerModels) {
      if (suggested.some((model) => model.id === id)) continue;
      const name = modelDisplayName(id) ?? id;
      if (!matches(id, name)) continue;
      list.push({ value: id, label: name, detail: name === id ? undefined : id, vendor: modelVendor(id, options.provider), section: "Newest from provider" });
    }
    return list;
  };

  const open = () => {
    if (menu?.isOpen) { menu.render(); return; }
    menu = new PickerMenu({
      anchor: box,
      keyTarget: input,
      items,
      selected: () => input.value.trim(),
      choose: (picked) => {
        input.value = picked;
        filter = "";
        showLogo();
        void options.onChange(picked);
      },
      footer: options.loadProviderModels && !providerModels.length ? {
        label: "Load more from provider",
        run: async () => {
          providerModels = await options.loadProviderModels!();
          menu?.clearFooter();
          if (!providerModels.length) throw new Error("The provider returned no models. Type a model ID instead.");
        },
      } : undefined,
    });
  };

  input.addEventListener("focus", () => { filter = ""; open(); });
  input.addEventListener("click", () => { if (!menu?.isOpen) { filter = ""; open(); } });
  input.addEventListener("input", () => {
    filter = input.value;
    showLogo();
    open();
    void options.onChange(input.value.trim());
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && !menu?.isOpen) { event.preventDefault(); filter = ""; open(); }
  });
  toggle.addEventListener("pointerdown", (event) => event.preventDefault());
  toggle.onclick = () => {
    if (menu?.isOpen) { menu.close(); return; }
    filter = "";
    input.focus();
    open();
  };
  return input;
}
