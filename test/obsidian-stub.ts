export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function debounce<T extends (...args: any[]) => any>(fn: T): T {
  // Smoke tests call flush explicitly. Avoid overlapping immediate writes that
  // do not model Obsidian's real trailing debounce.
  return (() => {}) as T;
}

export class TFile {
  path: string;

  constructor(path: string) {
    this.path = normalizePath(path);
  }

  setPath(path: string): void {
    this.path = normalizePath(path);
  }

  get name(): string {
    return this.path.split("/").pop() ?? "";
  }

  get extension(): string {
    const dot = this.name.lastIndexOf(".");
    return dot >= 0 ? this.name.slice(dot + 1) : "";
  }

  get basename(): string {
    const suffix = this.extension ? `.${this.extension}` : "";
    return suffix ? this.name.slice(0, -suffix.length) : this.name;
  }
}

export class App {}

export class Modal {
  constructor(public app: any) {}
}
export class FuzzySuggestModal<T> extends Modal {}
export class Setting {}
export class Notice {
  static messages: string[] = [];
  constructor(message: string) { Notice.messages.push(message); }
}

export class Component {
  children = new Set<Component>();
  private cleanups: Array<() => void> = [];
  private loaded = false;
  addChild<T extends Component>(child: T): T {
    this.children.add(child);
    if (this.loaded) child.load();
    return child;
  }
  removeChild<T extends Component>(child: T): T {
    child.unload();
    this.children.delete(child);
    return child;
  }
  register(fn: () => void): void { this.cleanups.push(fn); }
  registerDomEvent(el: EventTarget, type: string, fn: EventListener): void {
    el.addEventListener(type, fn);
    this.register(() => el.removeEventListener(type, fn));
  }
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
    for (const child of this.children) child.load();
  }
  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    this.onunload();
    for (const child of this.children) child.unload();
    this.children.clear();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
  onload(): void {}
  onunload(): void {}
}

export class MarkdownRenderer {
  static render: (...args: any[]) => Promise<void> = async () => {};
}

export async function requestUrl(args: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}): Promise<{ status: number; text: string; json: any }> {
  const response = await fetch(args.url, {
    method: args.method ?? "GET",
    headers: args.headers,
    body: args.body,
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  if (args.throw !== false && !response.ok) throw new Error(`HTTP ${response.status}`);
  return { status: response.status, text, json };
}

export class FileView extends Component {
  app: any;
  constructor(public leaf: any) { super(); this.app = leaf.app; }
}
export class Menu {}
export function setIcon(): void {}
