export class MemoryAdapter {
  text = new Map<string, string>();
  folders = new Set<string>([""]);
  beforeWrite?: (path: string, value: string) => Promise<void>;
  async exists(path: string): Promise<boolean> { return this.text.has(path) || this.folders.has(path); }
  async stat(path: string): Promise<any> {
    if (this.folders.has(path)) return { type: "folder", size: 0 };
    if (this.text.has(path)) return { type: "file", size: this.text.get(path)!.length };
    return null;
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "";
    const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
    return { files: [...this.text.keys()].filter(direct), folders: [...this.folders].filter(p => p !== path && direct(p)) };
  }
  async read(path: string): Promise<string> {
    if (!this.text.has(path)) throw new Error(`Missing ${path}`);
    return this.text.get(path)!;
  }
  async write(path: string, value: string): Promise<void> {
    await this.beforeWrite?.(path, value);
    this.text.set(path, value);
  }
  async mkdir(path: string): Promise<void> { this.folders.add(path); }
}
