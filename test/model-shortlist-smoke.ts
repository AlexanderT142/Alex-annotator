import assert from "node:assert/strict";
import { recentAnnotationModels } from "../src/model-shortlist";
import { AI_PROVIDER_PRESETS, DEFAULT_AI_SETTINGS, modelDisplayName, modelVendor, normalizeAiSettings, replacementForRetiredModel, suggestedModels } from "../src/ai-provider";
import { PROVIDER_LOGOS } from "../src/provider-logos";

const openai = [
  { id: "gpt-5.4-mini", created: 100 },
  { id: "gpt-5.4-mini-2026-03-17", created: 100 },
  { id: "gpt-5.6-sol", created: 300 },
  { id: "gpt-5.6-sol", created: 300, reasoning_effort: "low" },
  { id: "gpt-5.6-sol", created: 300, reasoning_effort: "high" },
  { id: "gpt-5.6-terra", created: 290 },
  { id: "gpt-5.6-luna", created: 280 },
  { id: "gpt-6-astra", created: 400 },
  { id: "gpt-image-2", created: 900 },
  { id: "gpt-5.5-pro", created: 900 },
  { id: "gpt-realtime", created: 900 },
  { id: "text-embedding-3-large", created: 900 },
  { id: "gpt-5.3-codex", created: 900 },
  { id: "gpt-9-retired", created: 950, deprecated: true },
];
assert.deepEqual(recentAnnotationModels("openai", openai), ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
assert.deepEqual(recentAnnotationModels("openai", openai.slice(0, 5)), ["gpt-5.6-sol", "gpt-5.4-mini"], "efforts and dated copies consume no extra slots");
assert.deepEqual(recentAnnotationModels("glm", ["glm-5.2", "glm-4.7", "glm-5.3-flash", "glm-5.3", "glm-5.1", "glm-5", "glm-image"].map(id => ({ id }))), ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1"]);
assert.deepEqual(recentAnnotationModels("anthropic", [
  { id: "claude-opus-5", created_at: "2026-07-24T00:00:00Z" },
  { id: "claude-sonnet-4-6", created_at: "2026-02-17T00:00:00Z" },
  { id: "claude-opus-5-20260724", created_at: "2026-07-24T00:00:00Z" },
]), ["claude-opus-5", "claude-sonnet-4-6"]);
assert.deepEqual(recentAnnotationModels("gemini", [
  { name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-3.1-pro", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-4-embedding", supportedGenerationMethods: ["embedContent"] },
  { name: "models/gemini-4-image", supportedGenerationMethods: ["generateContent"] },
]), ["gemini-3.7-flash", "gemini-3.1-pro"]);
for (const provider of ["openai", "anthropic", "gemini", "xai", "deepseek", "glm", "qwen", "kimi", "custom"]) {
  const prefix = provider === "openai" ? "gpt" : provider === "anthropic" ? "claude" : provider;
  const input = Array.from({ length: 20 }, (_, i) => ({ id: `${prefix}-${i + 1}`, created: i + 1 }));
  const original = JSON.stringify(input);
  const result = recentAnnotationModels(provider, input);
  assert.equal(result.length, 4, `${provider}: hard cap at four`);
  assert.equal(new Set(result).size, 4);
  assert.equal(result[0], `${prefix}-20`);
  assert.equal(JSON.stringify(input), original, "provider records remain unchanged");
}
assert.deepEqual(recentAnnotationModels("custom", []), []);
// Retired models: saved settings move to the provider's replacement; current models are left alone.
assert.equal(replacementForRetiredModel("anthropic", "claude-sonnet-4-5"), "claude-sonnet-5-5");
assert.equal(replacementForRetiredModel("anthropic", "claude-sonnet-4-5-20250929"), "claude-sonnet-5-5", "dated snapshots match");
assert.equal(replacementForRetiredModel("openai", "gpt-4o-2024-11-20"), "gpt-6-luna");
assert.equal(replacementForRetiredModel("gemini", "models/gemini-3.7-flash"), "gemini-3.8-flash");
assert.equal(replacementForRetiredModel("deepseek", "deepseek-chat"), "deepseek-flash");
assert.equal(replacementForRetiredModel("openai", "gpt-5.4-mini"), null, "still-served models are kept");
assert.equal(replacementForRetiredModel("custom", "gpt-4o"), null, "custom endpoints are never rewritten");
assert.equal(normalizeAiSettings({ provider: "kimi", model: "kimi-k2.5" }).model, "kimi-k3.1-pro");
for (const preset of AI_PROVIDER_PRESETS) {
  assert.equal(replacementForRetiredModel(preset.id, preset.defaultModel), null, `${preset.id} default is not retired`);
}

for (const preset of AI_PROVIDER_PRESETS) {
  const suggested = suggestedModels(preset.id);
  if (preset.id === "custom") { assert.equal(suggested.length, 0); continue; }
  assert.ok(suggested.some((model) => model.id === preset.defaultModel), `${preset.id} default is in its suggested list`);
  assert.equal(new Set(suggested.map((model) => model.id)).size, suggested.length, `${preset.id} suggestions are distinct`);
  for (const model of suggested) {
    assert.equal(replacementForRetiredModel(preset.id, model.id), null, `${model.id} is not retired`);
    assert.equal(modelVendor(model.id, preset.id), preset.id, `${model.id} shows its own provider logo`);
  }
  assert.ok(PROVIDER_LOGOS[preset.id as keyof typeof PROVIDER_LOGOS].startsWith("<svg"), `${preset.id} has a logo`);
}
// Replacements must themselves be current, so a moved setting never needs a second move.
for (const preset of AI_PROVIDER_PRESETS) {
  for (const model of ["gpt-4o", "claude-sonnet-4-5", "gemini-2.5-pro", "grok-3", "deepseek-chat", "qwen-max", "kimi-k2.5"]) {
    const next = replacementForRetiredModel(preset.id, model);
    if (next) assert.equal(replacementForRetiredModel(preset.id, next), null, `${model} → ${next} is current`);
  }
}
assert.equal(DEFAULT_AI_SETTINGS.model, "gpt-6.2-sol");
assert.equal(normalizeAiSettings({ provider: "openai", model: "gpt-5.4-mini" }).model, "gpt-5.4-mini", "a saved current model is kept");
assert.equal(normalizeAiSettings({ provider: "gemini" }).model, "gemini-4-neon", "new Gemini setups use the new default");
assert.equal(modelVendor("claude-opus-5-5", "custom"), "anthropic", "custom endpoints show the model vendor's logo");
assert.equal(modelVendor("anthropic/claude-sonnet-5-5", "custom"), "anthropic");
assert.equal(modelVendor("llama-4", "custom"), null);
assert.equal(modelVendor("my-finetune", "openai"), "openai");
assert.equal(modelDisplayName("claude-fable-5-2"), "Claude Fable 5.2");
console.log("model shortlist smoke: nine providers, four distinct models, newest-first ranking, effort/snapshot deduplication, media filtering, retired-model replacement, suggested models and logos passed");
