import assert from "node:assert/strict";
import { recentAnnotationModels } from "../src/model-shortlist";

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
console.log("model shortlist smoke: nine providers, four distinct models, newest-first ranking, effort/snapshot deduplication and media filtering passed");
