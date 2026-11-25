// Refresh the built-in model price snapshot from LiteLLM's community price list.
//
//   node scripts/sync-prices.mjs            download, filter, write the snapshot
//   node scripts/sync-prices.mjs <file>     use a local copy of the LiteLLM JSON
//
// The snapshot keeps LiteLLM's own field names; only first-party providers,
// chat-style models and token-price fields are kept. Rust parses the same
// format for the snapshot and for the optional online update
// (crates/session-core/src/models/pricing/catalog.rs), so the two filters
// below must stay in sync with PROVIDERS / MODES / is_price_field there.
// Review the git diff of the snapshot before committing it.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(root, "crates/session-core/data/model-prices.json");

const SOURCES = [
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
];

// First-party providers, in priority order: when two providers list the same
// model id, the earlier one wins.
const PROVIDERS = [
  "anthropic", "openai", "xai", "gemini", "deepseek", "mistral",
  "moonshot", "zai", "dashscope", "volcengine", "minimax",
];
const MODES = new Set(["chat", "responses", "completion"]);
const PRICE_FIELD =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost(_above_1hr|_above_12hr)?)(_above_\d+k_tokens)?$/;

async function download() {
  for (const url of SOURCES) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      console.log(`[sync-prices] downloaded ${(text.length / 1e6).toFixed(1)} MB from ${url}`);
      return { url, data: JSON.parse(text) };
    } catch (error) {
      console.warn(`[sync-prices] ${url} failed: ${error.message}`);
    }
  }
  throw new Error("all sources failed");
}

function filter(data) {
  const models = {};
  for (const [id, entry] of Object.entries(data).sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry || typeof entry !== "object") continue;
    if (!PROVIDERS.includes(entry.litellm_provider) || !MODES.has(entry.mode)) continue;
    const kept = { litellm_provider: entry.litellm_provider, mode: entry.mode };
    for (const [field, value] of Object.entries(entry)) {
      if (PRICE_FIELD.test(field) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
        kept[field] = value;
      }
    }
    if (!(kept.input_cost_per_token > 0) || !(typeof kept.output_cost_per_token === "number")) continue;
    models[id] = kept;
  }
  return models;
}

function summarizeChanges(before, after) {
  const changed = [];
  const added = Object.keys(after).filter((id) => !(id in before));
  const removed = Object.keys(before).filter((id) => !(id in after));
  for (const id of Object.keys(after)) {
    if (id in before && JSON.stringify(before[id]) !== JSON.stringify(after[id])) changed.push(id);
  }
  const show = (label, ids) => {
    if (ids.length === 0) return;
    console.log(`[sync-prices] ${label} ${ids.length}: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ", ..." : ""}`);
  };
  show("added", added);
  show("removed", removed);
  show("changed", changed);
}

const local = process.argv[2];
const { url, data } = local
  ? { url: `file:${local}`, data: JSON.parse(readFileSync(local, "utf-8")) }
  : await download();

const models = filter(data);
const count = Object.keys(models).length;
const byProvider = PROVIDERS.map((p) => `${p}=${Object.values(models).filter((m) => m.litellm_provider === p).length}`);
console.log(`[sync-prices] kept ${count} models: ${byProvider.join(" ")}`);
for (const anchor of ["anthropic", "openai"]) {
  if (!Object.values(models).some((m) => m.litellm_provider === anchor)) {
    console.error(`[sync-prices] no ${anchor} models in the source; refusing to write`);
    process.exit(1);
  }
}

const previous = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf-8")).models ?? {} : {};
summarizeChanges(previous, models);

const snapshot = {
  _meta: {
    source: "litellm",
    url,
    generatedAt: new Date().toISOString(),
    license: "MIT (BerriAI/litellm)",
  },
  models,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(snapshot, null, 1) + "\n", "utf-8");
console.log(`[sync-prices] wrote ${outPath}`);
