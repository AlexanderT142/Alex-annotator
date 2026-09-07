import { App, Notice, Setting } from "obsidian";
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
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Purple eyes show visible sets; grey eyes show hidden sets. Click an eye to show or hide that set. Active is where new notes are saved.",
    });

    const activeId = this.workspace.activeSet().id;
    for (const set of this.workspace.listSets()) {
      const row = new Setting(contentEl)
        .setName(set.name)
        .setDesc(`${set.kind === "ai" ? "AI" : set.kind === "import" ? "Imported" : "Manual"} set`);
      row.addButton((button) => {
        button.setButtonText(set.id === activeId ? "Active" : "Write here");
        if (set.id === activeId) button.setCta();
        button.onClick(async () => {
            await this.workspace.setActive(set.id);
            this.changed();
            this.render();
          });
      });
      row.addExtraButton((button) =>
        button.setIcon("pencil").setTooltip("Rename").onClick(() => {
          this.editName("Rename annotation set", set.name, async (name) => {
            await this.workspace.renameSet(set.id, name);
            this.changed();
            this.render();
          });
        })
      );
      row.addButton((button) => {
        button.setIcon("eye");
        button.buttonEl.addClass("lpa-set-visibility");
        // Keep the same focusable button in place when toggling visibility.
        const refresh = () => {
          const visible = this.workspace.isVisible(set.id);
          button.buttonEl.setAttribute("aria-pressed", String(visible));
          button.setTooltip(`${visible ? "Hide" : "Show"} ${set.name}`);
        };
        refresh();
        button.onClick(async () => {
          button.setDisabled(true);
          try {
            await this.workspace.setVisible(set.id, !this.workspace.isVisible(set.id));
            this.changed();
          } catch (error: any) {
            new Notice(error?.message ?? String(error));
          } finally {
            refresh();
            button.setDisabled(false);
          }
        });
      });
      row.addExtraButton((button) =>
        button.setIcon("archive").setTooltip("Archive set").onClick(async () => {
          try {
            await this.workspace.archiveSet(set.id);
            this.changed();
            this.render();
          } catch (error: any) {
            new Notice(error?.message ?? String(error));
          }
        })
      );
    }

    new Setting(contentEl)
      .setName("Create another set")
      .setDesc("A new set becomes active and visible without changing other sets.")
      .addButton((button) =>
        button.setButtonText("New set").setCta().onClick(() => {
          this.openCreate("manual");
        })
      );
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
