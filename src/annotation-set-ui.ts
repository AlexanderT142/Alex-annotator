import { App, Menu, Notice, Setting, setIcon } from "obsidian";
import { AnchoredPanel } from "./anchored-panel";
import { AnnotationSetWorkspace, type AnnotationSetKind } from "./annotation-sets";

export class AnnotationSetManagerModal extends AnchoredPanel {
  constructor(
    app: App,
    private workspace: AnnotationSetWorkspace,
    private changed: () => void,
    anchor?: HTMLElement
  ) {
    super(app, anchor, 520);
  }

  onOpen(): void {
    this.setTitle("Annotation sets");
    this.render();
  }

  private render(): void {
    this.setTitle("Annotation sets");
    const { contentEl } = this;
    contentEl.empty();
    const activeId = this.workspace.activeSet().id;
    const list = contentEl.createDiv({ cls: "lpa-set-list", attr: { role: "list" } });
    for (const set of this.workspace.listSets()) {
      const row = list.createDiv({ cls: "lpa-set-row", attr: { role: "listitem" } });
      row.toggleClass("is-writing", set.id === activeId);

      const eye = row.createEl("button", { cls: "lpa-set-visibility clickable-icon", attr: { type: "button" } });
      const refreshEye = () => {
        const visible = this.workspace.isVisible(set.id);
        setIcon(eye, visible ? "eye" : "eye-off");
        eye.setAttribute("aria-pressed", String(visible));
        eye.setAttribute("aria-label", `${visible ? "Hide" : "Show"} ${set.name}`);
        row.toggleClass("is-hidden", !visible);
      };
      refreshEye();
      eye.onclick = async () => {
        eye.disabled = true;
        try {
          await this.workspace.setVisible(set.id, !this.workspace.isVisible(set.id));
          this.changed();
        } catch (error: any) {
          new Notice(error?.message ?? String(error));
        } finally {
          refreshEye();
          eye.disabled = false;
        }
      };

      const info = row.createDiv({ cls: "lpa-set-info" });
      info.createDiv({ cls: "lpa-set-name", text: set.name });
      const meta = info.createDiv({ cls: "lpa-set-meta" });
      meta.createSpan({ text: noteCount(this.workspace.highlightsForSet(set.id).length) });
      if (set.kind === "ai") meta.createSpan({ cls: "lpa-set-kind-pill", text: "AI" });

      if (set.id === activeId) {
        row.createSpan({ cls: "lpa-set-writing", text: "✓ Writing here", attr: { title: "New notes are saved to this set" } });
      } else {
        const write = row.createEl("button", { cls: "lpa-set-write", text: "Write here", attr: { type: "button" } });
        write.onclick = async () => {
          await this.workspace.setActive(set.id);
          this.changed();
          this.render();
        };
      }

      const more = row.createEl("button", { cls: "lpa-set-more clickable-icon", attr: { type: "button", "aria-label": `More actions for ${set.name}` } });
      setIcon(more, "more-horizontal");
      more.onclick = (event) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle("Rename").setIcon("pencil").onClick(() => {
          this.editName("Rename annotation set", set.name, async (name) => {
            await this.workspace.renameSet(set.id, name);
            this.changed();
            this.render();
          });
        }));
        menu.addItem((item) => item.setTitle("Archive").setIcon("archive").onClick(async () => {
          try {
            await this.workspace.archiveSet(set.id);
            this.changed();
            this.render();
          } catch (error: any) {
            new Notice(error?.message ?? String(error));
          }
        }));
        menu.showAtMouseEvent(event);
      };
    }

    const archived = this.archivedSets();
    const footer = contentEl.createDiv({ cls: "lpa-set-footer" });
    if (archived.length) {
      const details = footer.createEl("details", { cls: "lpa-set-archived" });
      details.createEl("summary", { text: `Archived (${archived.length})` });
      const archivedList = details.createDiv({ cls: "lpa-set-archived-list" });
      for (const entry of archived) {
        const item = archivedList.createDiv({ cls: "lpa-set-archived-item" });
        item.createSpan({ cls: "lpa-set-name", text: entry.name });
        item.createSpan({ cls: "lpa-set-meta", text: noteCount(entry.count) });
      }
    } else {
      footer.createDiv();
    }
    const create = footer.createEl("button", { cls: "mod-cta lpa-set-new", text: "+ New set", attr: { type: "button" } });
    create.onclick = () => this.openCreate("manual");
  }

  /** Archived sets cannot be reopened yet; they are listed read-only. */
  private archivedSets(): Array<{ name: string; count: number }> {
    try {
      const snapshot = this.workspace.syncSnapshot();
      return snapshot.sets
        .filter((set) => set.archived)
        .map((set) => ({ name: set.name, count: snapshot.highlights.filter((h) => h.setId === set.id).length }));
    } catch {
      return [];
    }
  }

  private openCreate(kind: AnnotationSetKind): void {
    this.editName("New annotation set", "", async (name) => {
      await this.workspace.createSet(name, kind);
      this.changed();
      this.render();
    });
  }

  private editName(heading: string, initial: string, submit: (name: string) => Promise<void>): void {
    let value = initial;
    let saving = false;
    this.setTitle(heading);
    this.contentEl.empty();
    const finish = async () => {
      const name = value.replace(/\s+/g, " ").trim();
      if (!name) { new Notice("Give the annotation set a name."); return; }
      if (saving) return;
      saving = true;
      try { await submit(name); }
      catch (error: any) { new Notice(error?.message ?? "Could not save this set."); }
      finally { saving = false; }
    };
    new Setting(this.contentEl).setName("Name").addText((text) => {
      text.setValue(value).setPlaceholder("My notes").onChange((next) => {
        value = next;
      });
      text.inputEl.focus();
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void finish();
        }
      });
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Back").onClick(() => this.render()))
      .addButton((button) => button.setButtonText("Save").setCta().onClick(() => void finish()));
  }
}

function noteCount(count: number): string {
  return count === 0 ? "Empty" : count === 1 ? "1 note" : `${count} notes`;
}
