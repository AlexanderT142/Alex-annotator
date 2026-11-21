import { requestUrl } from "obsidian";
import { connectionIdentity } from "./ai-credentials";
import { recentAnnotationModels, type ModelListing } from "./model-shortlist";

export type AiProtocol = "openai-compatible" | "anthropic-messages" | "gemini-generate-content";

export type AiProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "xai"
  | "deepseek"
  | "glm"
  | "qwen"
  | "kimi"
  | "custom";

export interface AiProviderPreset {
  id: AiProviderId;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  defaultModel: string;
}

export interface AiConnectionSettings {
  provider: AiProviderId;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Claude API version. Nothing this plugin sends changed between 2023-06-01 and this one. */
const ANTHROPIC_VERSION = "2026-10-21";

export type ConfigureAiConnection = (patch: Partial<AiConnectionSettings>) => Promise<void>;

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  // Defaults checked against each provider's model and deprecation pages, Nov 2026.
  { id: "openai", name: "OpenAI", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-6-luna" },
  { id: "anthropic", name: "Claude (Anthropic)", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-opus-5-5" },
  { id: "gemini", name: "Gemini", protocol: "gemini-generate-content", baseUrl: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-4-hydrogen" },
  { id: "xai", name: "Grok (xAI)", protocol: "openai-compatible", baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4.7" },
  { id: "deepseek", name: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-flash" },
  { id: "glm", name: "GLM (Zhipu)", protocol: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-5.3" },
  { id: "qwen", name: "Qwen (DashScope international)", protocol: "openai-compatible", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3.7-plus" },
  { id: "kimi", name: "Kimi (Moonshot)", protocol: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k3.1-pro" },
  { id: "custom", name: "Custom OpenAI-compatible", protocol: "openai-compatible", baseUrl: "", defaultModel: "" },
];

export const DEFAULT_AI_SETTINGS: AiConnectionSettings = {
  provider: "openai",
  protocol: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-6-luna",
  apiKey: "",
};

/**
 * Models their providers have shut down or scheduled for shutdown, mapped to
 * the replacement each provider recommends (or the nearest current model of
 * the same tier). A saved setting naming one of these is moved on load so a
 * job never fails on a retired model. Dated snapshots of these IDs match too.
 */
const RETIRED_MODELS: Partial<Record<AiProviderId, Record<string, string>>> = {
  openai: {
    "gpt-5": "gpt-6.1-sol", "gpt-5-mini": "gpt-6.1-terra", "gpt-5-nano": "gpt-6-luna",
    "gpt-5-chat-latest": "gpt-6.1-sol", "gpt-5.1": "gpt-6-sol", "gpt-5.1-chat-latest": "gpt-6.1-sol",
    "gpt-5.2-chat-latest": "gpt-6.1-sol", "gpt-5.3-chat-latest": "gpt-6.1-sol", "gpt-5.4-nano": "gpt-6-luna",
    "o1": "gpt-6.1-sol", "o3": "gpt-6.1-sol", "o3-mini": "gpt-6.1-sol", "o4-mini": "gpt-6.1-terra",
    "gpt-4o": "gpt-6-luna", "gpt-4o-mini": "gpt-6-luna", "gpt-4.1": "gpt-6-luna",
    "gpt-4.1-mini": "gpt-6-luna", "gpt-4.1-nano": "gpt-6-luna",
  },
  anthropic: {
    "claude-sonnet-4-5": "claude-sonnet-5-5", "claude-sonnet-4-0": "claude-sonnet-5-5", "claude-sonnet-4": "claude-sonnet-5-5",
    "claude-3-7-sonnet": "claude-sonnet-5-5", "claude-3-7-sonnet-latest": "claude-sonnet-5-5",
    "claude-3-5-sonnet": "claude-sonnet-5-5", "claude-3-5-sonnet-latest": "claude-sonnet-5-5",
    "claude-opus-4-1": "claude-opus-5-5", "claude-opus-4-0": "claude-opus-5-5", "claude-opus-4": "claude-opus-5-5",
    "claude-3-opus": "claude-opus-5-5", "claude-3-opus-latest": "claude-opus-5-5",
    "claude-3-5-haiku": "claude-haiku-5-5", "claude-3-5-haiku-latest": "claude-haiku-5-5", "claude-3-haiku": "claude-haiku-5-5",
  },
  gemini: {
    "gemini-3.7-flash": "gemini-3.8-flash", "gemini-3.5-flash": "gemini-3.6-flash",
    "gemini-2.5-pro": "gemini-3.8-flash", "gemini-2.5-flash": "gemini-3.5-flash-lite",
    "gemini-2.0-flash": "gemini-3.5-flash-lite", "gemini-2.0-flash-lite": "gemini-3.5-flash-lite",
    "gemini-3-pro-preview": "gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
  },
  xai: {
    "grok-3": "grok-4.3", "grok-3-mini": "grok-4.3", "grok-4-0709": "grok-4.3", "grok-code-fast-1": "grok-4.3",
    "grok-4-fast-reasoning": "grok-4.3", "grok-4-fast-non-reasoning": "grok-4.3",
    "grok-4-1-fast-reasoning": "grok-4.3", "grok-4-1-fast-non-reasoning": "grok-4.3",
  },
  deepseek: { "deepseek-chat": "deepseek-flash", "deepseek-reasoner": "deepseek-flash", "deepseek-v4-flash": "deepseek-flash" },
  qwen: { "qwen-max": "qwen4-max", "qwen-turbo": "qwen3.8-flash" },
  kimi: { "kimi-k2": "kimi-k3.1-pro", "kimi-k2.5": "kimi-k3.1-pro", "kimi-k2-turbo-preview": "kimi-k3.1-pro", "kimi-k2-thinking": "kimi-k3.1-pro" },
};

/** The current model to use instead of a retired one, or null when the model is not known to be retired. */
export function replacementForRetiredModel(provider: AiProviderId, model: string): string | null {
  const table = RETIRED_MODELS[provider];
  if (!table) return null;
  const id = model.trim().replace(/^models\//, "");
  const base = id.replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6})$/, "").replace(/@\d{8}$/, "");
  return table[id] ?? table[base] ?? null;
}

export interface AiAnnotationCandidate {
  pageNumber: number;
  exactQuote: string;
  prefix?: string;
  suffix?: string;
  note: string;
  style?: string;
  color?: string;
}

export interface AiAnnotationResponse {
  annotations: AiAnnotationCandidate[];
}

export class AiProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AiProviderError";
  }
}

export function presetFor(id: AiProviderId): AiProviderPreset {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? AI_PROVIDER_PRESETS[0];
}

/** Return a provider only when its key prefix is distinctive. Generic `sk-`
 * keys are intentionally ambiguous and must never be probed across vendors. */
export function detectProviderFromKey(key: string): AiProviderId | null {
  const value = key.trim();
  if (value.startsWith("sk-ant-")) return "anthropic";
  if (value.startsWith("AIza")) return "gemini";
  if (value.startsWith("xai-")) return "xai";
  if (value.startsWith("sk-proj-") || value.startsWith("sk-svcacct-")) return "openai";
  if (/^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,}$/.test(value)) return "glm";
  return null;
}

export function normalizeAiSettings(value: Partial<AiConnectionSettings> | null | undefined): AiConnectionSettings {
  const provider = AI_PROVIDER_PRESETS.some((preset) => preset.id === value?.provider)
    ? value!.provider!
    : DEFAULT_AI_SETTINGS.provider;
  const preset = presetFor(provider);
  const protocol =
    value?.protocol === "anthropic-messages" ||
    value?.protocol === "gemini-generate-content" ||
    value?.protocol === "openai-compatible"
      ? value.protocol
      : preset.protocol;
  const model = (value?.model ?? preset.defaultModel).trim();
  return {
    provider,
    protocol,
    baseUrl: (value?.baseUrl ?? preset.baseUrl).trim().replace(/\/+$/, ""),
    model: replacementForRetiredModel(provider, model) ?? model,
    apiKey: value?.apiKey ?? "",
  };
}

export async function requestAiAnnotations(
  settings: AiConnectionSettings,
  userInstruction: string,
  pageText: Array<{ pageNumber: number; text: string }>
): Promise<AiAnnotationResponse> {
  const config = normalizeAiSettings(settings);
  if (!config.apiKey.trim()) throw new AiProviderError("No API key is configured.");
  if (!config.model) throw new AiProviderError("No model is configured.");
  if (!config.baseUrl) throw new AiProviderError("No provider base URL is configured.");
  connectionIdentity(config);

  const prompt = buildPrompt(userInstruction, pageText);
  let responseText = "";
  try {
    if (config.protocol === "anthropic-messages") {
      responseText = await callAnthropic(config, prompt);
    } else if (config.protocol === "gemini-generate-content") {
      responseText = await callGemini(config, prompt);
    } else {
      responseText = await callOpenAiCompatible(config, prompt);
    }
  } catch (error) {
    throw safeProviderError(error, config.apiKey);
  }
  return parseAnnotationResponse(responseText);
}

/** Ask the provider for its current models so new model IDs do not require a
 * plugin release. The user still chooses which returned model to use. */
export async function listAiModels(settings: AiConnectionSettings): Promise<string[]> {
  const config = normalizeAiSettings(settings);
  if (!config.apiKey.trim()) throw new AiProviderError("No API key is configured.");
  connectionIdentity(config);
  let response: any;
  const records: ModelListing[] = [];
  if (config.protocol === "gemini-generate-content") {
    let cursor = "";
    const seen = new Set<string>();
    do {
      const url = new URL(endpoint(config.baseUrl, "models"));
      url.searchParams.set("pageSize", "1000");
      if (cursor) url.searchParams.set("pageToken", cursor);
      response = await getJson(url.toString(), { "x-goog-api-key": config.apiKey.trim() });
      records.push(...(Array.isArray(response?.models) ? response.models : []));
      cursor = typeof response?.nextPageToken === "string" ? response.nextPageToken : "";
      if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new AiProviderError("The provider model list could not be fully refreshed. Enter a model ID directly.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return recentAnnotationModels(config.provider, withoutRetired(config.provider, records));
  }
  const headers: Record<string, string> =
    config.protocol === "anthropic-messages"
      ? { "x-api-key": config.apiKey.trim(), "anthropic-version": ANTHROPIC_VERSION }
      : { Authorization: `Bearer ${config.apiKey.trim()}` };
  let cursor = "";
  const seen = new Set<string>();
  do {
    const url = new URL(endpoint(config.baseUrl, "models"));
    if (config.protocol === "anthropic-messages") {
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("after_id", cursor);
    }
    response = await getJson(url.toString(), headers);
    records.push(...(Array.isArray(response?.data) ? response.data : []));
    cursor = config.protocol === "anthropic-messages" && response?.has_more ? response.last_id : "";
    if (response?.has_more && config.protocol === "anthropic-messages" && !cursor) throw new AiProviderError("The provider returned an incomplete model list. Enter a model ID directly.");
    if (cursor && (typeof cursor !== "string" || seen.has(cursor) || seen.size >= 20)) throw new AiProviderError("The provider model list could not be fully refreshed. Enter a model ID directly.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return recentAnnotationModels(config.provider, withoutRetired(config.provider, records));
}

/** Providers keep listing some shut-down models for a while; never offer them. */
function withoutRetired(provider: AiProviderId, records: ModelListing[]): ModelListing[] {
  return records.filter((record) => !replacementForRetiredModel(provider, String(record?.id ?? record?.name ?? "")));
}

function buildPrompt(
  instruction: string,
  pages: Array<{ pageNumber: number; text: string }>
): string {
  const pageBlock = pages
    .map(({ pageNumber, text }) => `\n--- PAGE ${pageNumber} ---\n${text}`)
    .join("\n");
  return `Create PDF annotations for the supplied pages according to this reader instruction:\n\n${instruction.trim()}\n\nReturn JSON only in this exact shape:\n{"annotations":[{"pageNumber":1,"exactQuote":"verbatim source text","prefix":"optional source text immediately before","suffix":"optional source text immediately after","note":"annotation text","style":"highlight|underline|dashed|dotted|strike|box|comment","color":"yellow|blue|pink|red"}]}\n\nRules:\n- exactQuote must be copied verbatim from one supplied page. Never paraphrase it.\n- pageNumber must match the PAGE label.\n- Use prefix and suffix when the quote occurs more than once.\n- Put the translation, explanation, connection, or scaffold in note.\n- Return no more than 8 useful annotations per page.\n- Return an empty annotations array when the instruction does not justify a mark.\n- Do not include Markdown fences or commentary outside JSON.\n${pageBlock}`;
}

async function callOpenAiCompatible(settings: AiConnectionSettings, prompt: string): Promise<string> {
  const url = endpoint(settings.baseUrl, "chat/completions");
  const response = await postJson(
    url,
    { Authorization: `Bearer ${settings.apiKey.trim()}` },
    {
      model: settings.model,
      messages: [
        {
          role: "system",
          content: "You create grounded PDF annotations. Respond with valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      stream: false,
    }
  );
  const text = response?.choices?.[0]?.message?.content;
  if (response?.choices?.[0]?.finish_reason === "length") {
    throw new AiProviderError("The provider stopped before finishing its answer. Try fewer pages per job.");
  }
  if (typeof text !== "string" || !text.trim()) {
    throw new AiProviderError("The provider returned no annotation text.");
  }
  return text;
}

async function callAnthropic(settings: AiConnectionSettings, prompt: string): Promise<string> {
  const url = endpoint(settings.baseUrl, "messages");
  const response = await postJson(
    url,
    {
      "x-api-key": settings.apiKey.trim(),
      "anthropic-version": ANTHROPIC_VERSION,
    },
    {
      model: settings.model,
      // Current Claude models think before answering, and that thinking
      // counts toward this limit, so leave room for both.
      max_tokens: 16000,
      system: "You create grounded PDF annotations. Respond with valid JSON only.",
      messages: [{ role: "user", content: prompt }],
    }
  );
  if (response?.stop_reason === "refusal") {
    throw new AiProviderError("Claude declined to annotate these pages. Try a different prompt or pages.");
  }
  if (response?.stop_reason === "max_tokens") {
    throw new AiProviderError("Claude stopped before finishing its answer. Try fewer pages per job.");
  }
  const text = Array.isArray(response?.content)
    ? response.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("")
    : "";
  if (!text.trim()) throw new AiProviderError("Anthropic returned no annotation text.");
  return text;
}

async function callGemini(settings: AiConnectionSettings, prompt: string): Promise<string> {
  const model = settings.model.replace(/^models\//, "");
  const url = endpoint(settings.baseUrl, `models/${encodeURIComponent(model)}:generateContent`);
  const response = await postJson(
    url,
    { "x-goog-api-key": settings.apiKey.trim() },
    {
      systemInstruction: {
        parts: [{ text: "You create grounded PDF annotations. Respond with valid JSON only." }],
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    }
  );
  const parts = response?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((part: any) => part?.text ?? "").join("") : "";
  if (!text.trim()) throw new AiProviderError("Gemini returned no annotation text.");
  return text;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  try {
    const response = await withDeadline(requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      throw: false,
    }));
    if (response.status < 200 || response.status >= 300) {
      const message = providerErrorMessage(readJson(response), response.text, response.status);
      throw new AiProviderError(message, response.status);
    }
    return response.json;
  } catch (error: any) {
    if (error instanceof AiProviderError) throw error;
    throw safeProviderError(error, ...Object.values(headers));
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  try {
    const response = await withDeadline(requestUrl({
      url,
      method: "GET",
      headers,
      throw: false,
    }));
    if (response.status < 200 || response.status >= 300) {
      throw new AiProviderError(providerErrorMessage(readJson(response), response.text, response.status), response.status);
    }
    return response.json;
  } catch (error: any) {
    throw safeProviderError(error, ...Object.values(headers));
  }
}

function readJson(response: { json: any }): any {
  try { return response.json; } catch { return null; }
}

export function safeProviderError(error: unknown, ...secrets: string[]): AiProviderError {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of secrets) {
    const secret = value.replace(/^Bearer\s+/i, "").trim();
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return new AiProviderError(message.slice(0, 1000), error instanceof AiProviderError ? error.status : undefined);
}

async function withDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AiProviderError("The provider did not respond within 3 minutes. This request was not retried automatically; you can resume the job.")), 180_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function endpoint(baseUrl: string, path: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (clean.toLowerCase().endsWith(`/${path.toLowerCase()}`)) return clean;
  return `${clean}/${path}`;
}

function providerErrorMessage(json: any, text: string, status: number): string {
  const raw = json?.error?.message ?? json?.message ?? text ?? "";
  const message = String(raw).replace(/(bearer\s+|api[_ -]?key["' :=]+)[^\s"']+/gi, "$1[redacted]");
  return `Provider request failed (${status})${message ? `: ${message}` : ""}`;
}

export function parseAnnotationResponse(text: string): AiAnnotationResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiProviderError("The provider response did not contain a JSON object.");
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new AiProviderError("The provider response was not valid JSON.");
  }
  if (!parsed || !Array.isArray(parsed.annotations)) {
    throw new AiProviderError("The provider JSON did not contain an annotations array.");
  }
  const annotations = parsed.annotations
    .filter((item: any) => item && typeof item === "object")
    .map((item: any) => ({
      pageNumber: Number(item.pageNumber ?? item.page),
      exactQuote: String(item.exactQuote ?? item.quote ?? "").trim(),
      prefix: typeof item.prefix === "string" ? item.prefix : undefined,
      suffix: typeof item.suffix === "string" ? item.suffix : undefined,
      note: String(item.note ?? item.annotation ?? "").trim(),
      style: typeof item.style === "string" ? item.style : undefined,
      color: typeof item.color === "string" ? item.color : undefined,
    }))
    .filter((item: AiAnnotationCandidate) =>
      Number.isInteger(item.pageNumber) && item.pageNumber > 0 && item.exactQuote.length > 1 && !!item.note
    );
  return { annotations };
}
