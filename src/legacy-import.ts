/**
 * legacy-import.ts — parse obsidian-annotator notes (pure, no Obsidian deps so
 * it can be unit-tested headlessly).
 *
 * An obsidian-annotator note carries `annotation-target:` frontmatter and, for
 * each highlight, a callout containing a fenced ```annotation-json block (lines
 * prefixed with ">"). Each block is a hypothes.is-style annotation: the quoted
 * text lives in a TextQuoteSelector (exact/prefix/suffix); the user's comment is
 * the top-level `text`. No coordinates are stored — re-anchoring is by text.
 */

export interface LegacyAnnotation {
  exact: string;
  prefix?: string;
  suffix?: string;
  note?: string; // user comment (top-level "text")
  created?: string;
  tags?: string[];
}

export interface ParsedLegacyNote {
  target?: string; // raw annotation-target value
  annotations: LegacyAnnotation[];
}

function frontmatterTarget(content: string): string | undefined {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return undefined;
  const m = fm[1].match(/^annotation-target:\s*(.+?)\s*$/m);
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function extractAnnotation(obj: any): LegacyAnnotation | null {
  if (!obj || typeof obj !== "object") return null;
  const targets: any[] = Array.isArray(obj.target) ? obj.target : [];
  let exact: string | undefined;
  let prefix: string | undefined;
  let suffix: string | undefined;
  for (const t of targets) {
    const sels: any[] = Array.isArray(t?.selector) ? t.selector : [];
    for (const s of sels) {
      if (s?.type === "TextQuoteSelector" && typeof s.exact === "string") {
        exact = s.exact;
        if (typeof s.prefix === "string") prefix = s.prefix;
        if (typeof s.suffix === "string") suffix = s.suffix;
      }
    }
  }
  if (!exact) return null;
  return {
    exact,
    prefix,
    suffix,
    note: typeof obj.text === "string" && obj.text.trim() ? obj.text.trim() : undefined,
    created: typeof obj.created === "string" ? obj.created : undefined,
    tags: Array.isArray(obj.tags) ? obj.tags.filter((x: any) => typeof x === "string") : undefined,
  };
}

/** Parse one note's content into target + annotations. */
export function parseLegacyNote(content: string): ParsedLegacyNote {
  const target = frontmatterTarget(content);
  const annotations: LegacyAnnotation[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^>?\s*```annotation-json\s*$/.test(lines[i])) continue;
    const buf: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^>?\s*```\s*$/.test(lines[j])) break;
      buf.push(lines[j].replace(/^>\s?/, ""));
    }
    i = j;
    try {
      const obj = JSON.parse(buf.join("\n"));
      const a = extractAnnotation(obj);
      if (a) annotations.push(a);
    } catch {
      /* skip malformed block */
    }
  }
  return { target, annotations };
}

/** Normalize a target/path down to a comparable lowercase basename. */
export function targetBasename(target: string | undefined): string | undefined {
  if (!target) return undefined;
  let t = target.trim();
  try {
    // vault:/... or urn:... or percent-encoded paths
    if (/%[0-9a-f]{2}/i.test(t)) t = decodeURIComponent(t);
  } catch {
    /* leave as-is */
  }
  t = t.replace(/^vault:\/?/i, "");
  const slash = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  if (slash >= 0) t = t.slice(slash + 1);
  // Normalize Unicode (macOS filenames are NFD, decoded targets are often NFC).
  return t.normalize("NFC").toLowerCase();
}
