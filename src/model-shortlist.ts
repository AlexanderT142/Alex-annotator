/** A small, refreshed picker, not a hard-coded list of supported model IDs. */
export const MODEL_PICKER_LIMIT = 4;

export interface ModelListing {
  id?: string;
  name?: string;
  created?: number | string;
  created_at?: string;
  supportedGenerationMethods?: string[];
  deprecated?: boolean;
  status?: string;
}

function family(id: string): string {
  return id.replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6}|\d{4}|00\d)$/, "")
    .replace(/-latest$/, "");
}

function timestamp(model: ModelListing, id: string): number {
  const raw = model.created_at ?? model.created;
  const date = typeof raw === "number" ? raw * (raw < 1e12 ? 1000 : 1) :
    typeof raw === "string" ? (/^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw)) : 0;
  if (Number.isFinite(date) && date > 0) return date;
  const match = id.match(/-(20\d{2})-?(\d{2})-?(\d{2})(?:$|-)/);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3]) : 0;
}

function eligible(provider: string, id: string, model: ModelListing): boolean {
  if (!id || model.deprecated || /deprecated|retired|disabled/i.test(model.status ?? "")) return false;
  if (model.supportedGenerationMethods && !model.supportedGenerationMethods.includes("generateContent")) return false;
  // The annotation pipeline needs ordinary text generation, not media,
  // embeddings, retrieval, agent-only, or specialized coding endpoints.
  if (/(?:^|[-_/])(?:embedding|embeddings|rerank|reranker|audio|tts|asr|whisper|transcribe|realtime|live|image|imagen|video|veo|sora|dall-e|moderation|codex|coder|computer-use|deep-research|search)(?:$|[-_/])/i.test(id)) return false;
  if (provider === "openai") return /^(?:gpt-|chatgpt-|o\d)/.test(id) && !/(?:-pro(?:-|$)|-chat-latest$)/.test(id);
  if (provider === "anthropic") return id.startsWith("claude-");
  if (provider === "gemini") return id.startsWith("gemini-");
  return true;
}

function generation(id: string): number[] {
  const match = family(id).match(/\d+(?:[.-]\d+)*/);
  return match ? match[0].split(/[.-]/).map(Number) : [];
}

export function recentAnnotationModels(provider: string, records: ModelListing[]): string[] {
  const groups = new Map<string, { id: string; date: number; order: number }>();
  records.forEach((record, order) => {
    if (!record || typeof record !== "object") return;
    const id = String(record.id ?? record.name ?? "").replace(/^models\//, "");
    if (!eligible(provider, id, record)) return;
    const key = family(id);
    const date = timestamp(record, id);
    const old = groups.get(key);
    if (!old) { groups.set(key, { id, date, order }); return; }
    // Prefer a moving alias, when supplied, over duplicate dated snapshots.
    const isAlias = id === key || id === `${key}-latest`;
    const oldIsAlias = old.id === key || old.id === `${key}-latest`;
    if ((isAlias && !oldIsAlias) || (isAlias === oldIsAlias && date > old.date)) old.id = id;
    old.date = Math.max(old.date, date);
  });
  const models = [...groups.values()];
  const allHaveDates = models.every((model) => model.date > 0);
  return models.sort((a, b) => {
    if (allHaveDates && a.date !== b.date) return b.date - a.date;
    // Claude documents newest-first ordering, including unknown release dates.
    if (provider === "anthropic") return a.order - b.order;
    // Some compatible APIs omit dates (or use identical placeholder dates).
    // Version-aware ordering is a best-effort fallback, not a release-date claim.
    const av = generation(a.id), bv = generation(b.id);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const difference = (bv[i] ?? 0) - (av[i] ?? 0);
      if (difference) return difference;
    }
    return b.date - a.date || a.id.localeCompare(b.id, "en", { numeric: true });
  }).slice(0, MODEL_PICKER_LIMIT).map((model) => model.id);
}
