//! Price catalog in LiteLLM's `model_prices_and_context_window.json` format.
//!
//! The same parser reads the committed snapshot and the online download.
//! LiteLLM lists USD per token; this module converts to USD per million
//! tokens. Long-context tiers appear as `*_above_{N}k_tokens` fields and the
//! long cache TTL as `cache_creation_input_token_cost_above_1hr` (Anthropic)
//! or `..._above_12hr` (OpenAI).
//!
//! `PROVIDERS`, `MODES` and [`is_price_field`] must match the filter in
//! `scripts/sync-prices.mjs`.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};

use super::{ModelPrice, PriceTier, Rates};

/// First-party providers in priority order: when two list the same model
/// id, the earlier one wins.
const PROVIDERS: [&str; 11] = [
    "anthropic",
    "openai",
    "xai",
    "gemini",
    "deepseek",
    "mistral",
    "moonshot",
    "zai",
    "dashscope",
    "volcengine",
    "minimax",
];
const MODES: [&str; 3] = ["chat", "responses", "completion"];

/// Base field names, longest first so `..._above_1hr` is not read as a tier
/// suffix of `cache_creation_input_token_cost`.
const PRICE_FIELDS: [&str; 6] = [
    "cache_creation_input_token_cost_above_1hr",
    "cache_creation_input_token_cost_above_12hr",
    "cache_creation_input_token_cost",
    "cache_read_input_token_cost",
    "input_cost_per_token",
    "output_cost_per_token",
];

/// A token-price field we keep: one of [`PRICE_FIELDS`], optionally followed
/// by a `_above_{N}k_tokens` tier suffix. Batch / priority / flex variants
/// are dropped.
fn is_price_field(name: &str) -> bool {
    PRICE_FIELDS.iter().any(|base| {
        name.strip_prefix(base)
            .is_some_and(|rest| rest.is_empty() || tier_threshold(rest).is_some())
    })
}

/// `_above_272k_tokens` → `272_000`.
fn tier_threshold(suffix: &str) -> Option<u64> {
    let digits = suffix.strip_prefix("_above_")?.strip_suffix("k_tokens")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok()?.checked_mul(1_000)
}

/// The model map inside a JSON document: our snapshot wraps it as
/// `{ "_meta": ..., "models": { ... } }`, LiteLLM's own file is the map itself.
pub(crate) fn models_from_json(value: Value) -> Result<Map<String, Value>, String> {
    let Value::Object(mut root) = value else {
        return Err("price data is not a JSON object".to_string());
    };
    match root.remove("models") {
        Some(Value::Object(models)) => Ok(models),
        Some(_) => Err("`models` is not a JSON object".to_string()),
        None => Ok(root),
    }
}

/// Keep first-party chat models with a positive input price, and only their
/// token-price fields.
pub(crate) fn filter_models(models: &Map<String, Value>) -> Map<String, Value> {
    let mut kept = Map::new();
    for (id, entry) in models {
        let Some(entry) = entry.as_object() else { continue };
        let provider = entry.get("litellm_provider").and_then(Value::as_str);
        let mode = entry.get("mode").and_then(Value::as_str);
        if !provider.is_some_and(|p| PROVIDERS.contains(&p)) || !mode.is_some_and(|m| MODES.contains(&m)) {
            continue;
        }
        let mut out = Map::new();
        out.insert("litellm_provider".into(), Value::from(provider.unwrap_or_default()));
        out.insert("mode".into(), Value::from(mode.unwrap_or_default()));
        for (field, value) in entry {
            let valid = value.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0);
            if valid && is_price_field(field) {
                out.insert(field.clone(), value.clone());
            }
        }
        let input = out.get("input_cost_per_token").and_then(Value::as_f64).unwrap_or(0.0);
        if input > 0.0 && out.contains_key("output_cost_per_token") {
            kept.insert(id.clone(), Value::Object(out));
        }
    }
    kept
}

/// Model prices indexed by normalised id.
#[derive(Debug, Default)]
pub struct Catalog {
    index: HashMap<String, Arc<ModelPrice>>,
    generated_at: Option<String>,
}

impl Catalog {
    /// Parse a snapshot (or a raw LiteLLM file) from text.
    pub fn from_json_str(text: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(text).map_err(|e| format!("invalid price JSON: {e}"))?;
        let generated_at = value
            .pointer("/_meta/generatedAt")
            .and_then(Value::as_str)
            .map(str::to_string);
        let models = models_from_json(value)?;
        Ok(Self::from_models(&filter_models(&models), generated_at))
    }

    /// Build from an already filtered model map.
    pub fn from_models(models: &Map<String, Value>, generated_at: Option<String>) -> Self {
        let mut index = HashMap::new();
        for provider in PROVIDERS {
            let mut entries: Vec<(&String, &Map<String, Value>)> = models
                .iter()
                .filter_map(|(id, entry)| Some((id, entry.as_object()?)))
                .filter(|(_, entry)| entry.get("litellm_provider").and_then(Value::as_str) == Some(provider))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            for (id, entry) in entries {
                let Some(price) = entry_price(entry) else { continue };
                let key = index_key(id);
                if !key.is_empty() {
                    index.entry(key).or_insert_with(|| Arc::new(price));
                }
            }
        }
        Self { index, generated_at }
    }

    pub fn len(&self) -> usize {
        self.index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }

    /// When `scripts/sync-prices.mjs` or the online update produced the data.
    pub fn generated_at(&self) -> Option<&str> {
        self.generated_at.as_deref()
    }

    /// Price for a model id as written in session logs.
    pub fn get(&self, model: &str) -> Option<Arc<ModelPrice>> {
        candidates(model).iter().find_map(|id| self.index.get(id).cloned())
    }
}

/// LiteLLM keys a provider's models as `deepseek/deepseek-chat`,
/// `xai/grok-4.7` or bare `gpt-5.4`; session logs carry the bare id.
fn index_key(id: &str) -> String {
    id.rsplit('/').next().unwrap_or(id).trim().to_ascii_lowercase()
}

/// Spellings to try for a logged model id: the id itself first, then
/// normalised forms.
fn candidates(model: &str) -> Vec<String> {
    let lower = model.trim().to_ascii_lowercase();
    let raw = lower.rsplit('/').next().unwrap_or(&lower);
    let mut id = raw.to_string();
    // Claude Code's context-window marker, e.g. `claude-opus-4-7[1m]`.
    if let Some(bracket) = id.find('[') {
        id.truncate(bracket);
    }
    // Bedrock ids: `us.anthropic.claude-...-v1:0`. The version suffix always
    // has a colon, so ids like `deepseek-v3` stay intact.
    if let Some(pos) = id.find("anthropic.") {
        id.replace_range(..pos + "anthropic.".len(), "");
    }
    if let Some(pos) = id.rfind("-v") {
        let rest = &id[pos + 2..];
        if rest.contains(':') && rest.bytes().all(|b| b.is_ascii_digit() || b == b':') {
            id.truncate(pos);
        }
    }
    // Vertex snapshots: `claude-opus-4-1@20250805`.
    let id = id.replace('@', "-");

    let mut out = Vec::new();
    push_unique(&mut out, raw.to_string());
    push_unique(&mut out, id.clone());
    if id.starts_with("claude") && id.contains('.') {
        push_unique(&mut out, id.replace('.', "-"));
    }
    for i in 0..out.len() {
        let base = out[i].strip_suffix("-latest").unwrap_or(&out[i]).to_string();
        let undated = strip_date(&base).unwrap_or(&base).to_string();
        push_unique(&mut out, base);
        push_unique(&mut out, undated);
    }
    out
}

fn push_unique(out: &mut Vec<String>, candidate: String) {
    if !candidate.is_empty() && !out.contains(&candidate) {
        out.push(candidate);
    }
}

/// `id` without a trailing `-YYYYMMDD` or `-YYYY-MM-DD` snapshot date.
fn strip_date(id: &str) -> Option<&str> {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (head, tail) = id.rsplit_once('-')?;
    if tail.len() == 8 && tail.starts_with("20") && digits(tail) {
        return Some(head);
    }
    let (rest, month) = head.rsplit_once('-')?;
    let (base, year) = rest.rsplit_once('-')?;
    let dated = tail.len() == 2 && month.len() == 2 && year.len() == 4 && year.starts_with("20");
    (dated && digits(tail) && digits(month) && digits(year) && !base.is_empty()).then_some(base)
}

/// USD per token → USD per million tokens, rounded off float noise.
fn per_mtok(per_token: f64) -> f64 {
    (per_token * 1e15).round() / 1e9
}

fn entry_price(entry: &Map<String, Value>) -> Option<ModelPrice> {
    let num = |field: &str| {
        entry
            .get(field)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(per_mtok)
    };
    let input = num("input_cost_per_token").filter(|v| *v > 0.0)?;
    let output = num("output_cost_per_token")?;
    let base = stream_rates(&num, "", input, output, None);

    let mut thresholds: Vec<u64> = entry
        .keys()
        .filter_map(|key| tier_threshold(key.strip_prefix("input_cost_per_token")?))
        .collect();
    thresholds.sort_unstable();
    thresholds.dedup();

    let tiers = thresholds
        .into_iter()
        .map(|above_tokens| {
            let suffix = format!("_above_{}k_tokens", above_tokens / 1_000);
            let tier_input = num(&format!("input_cost_per_token{suffix}")).unwrap_or(input);
            let tier_output = num(&format!("output_cost_per_token{suffix}")).unwrap_or(output);
            PriceTier {
                above_tokens,
                rates: stream_rates(&num, &suffix, tier_input, tier_output, Some(&base)),
            }
        })
        .collect();
    Some(ModelPrice { base, tiers })
}

/// Rates for one tier (`suffix` empty for the base tier). A stream the data
/// leaves out is derived from the base tier, scaled like the input rate;
/// on the base tier, missing cache rates fall back to the plain input rate.
fn stream_rates(
    num: &dyn Fn(&str) -> Option<f64>,
    suffix: &str,
    input: f64,
    output: f64,
    base: Option<&Rates>,
) -> Rates {
    let scale = base.map_or(1.0, |b| input / b.input);
    let derived = |pick: fn(&Rates) -> f64, default: f64| base.map_or(default, |b| pick(b) * scale);
    let cache_read = num(&format!("cache_read_input_token_cost{suffix}"))
        .unwrap_or_else(|| derived(|b| b.cache_read, input));
    let cache_write_5m = num(&format!("cache_creation_input_token_cost{suffix}"))
        .unwrap_or_else(|| derived(|b| b.cache_write_5m, input));
    let cache_write_1h = num(&format!("cache_creation_input_token_cost_above_1hr{suffix}"))
        .or_else(|| num(&format!("cache_creation_input_token_cost_above_12hr{suffix}")))
        .unwrap_or_else(|| derived(|b| b.cache_write_1h, cache_write_5m));
    Rates { input, output, cache_read, cache_write_5m, cache_write_1h }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn fixture() -> Catalog {
        let data = json!({
            "claude-haiku-5-5": {
                "litellm_provider": "anthropic", "mode": "chat",
                "input_cost_per_token": 1e-7, "output_cost_per_token": 5e-7,
                "cache_read_input_token_cost": 1e-8,
                "cache_creation_input_token_cost": 1.25e-7,
                "cache_creation_input_token_cost_above_1hr": 2e-7,
                "input_cost_per_token_above_100k_tokens": 5e-7,
                "output_cost_per_token_above_100k_tokens": 2.5e-6,
                "cache_read_input_token_cost_above_100k_tokens": 5e-8,
                "cache_creation_input_token_cost_above_100k_tokens": 6.25e-7,
                "cache_creation_input_token_cost_above_1hr_above_100k_tokens": 1e-6,
                "input_cost_per_token_batches": 5e-8
            },
            "claude-sonnet-4-5-20250929": {
                "litellm_provider": "anthropic", "mode": "chat",
                "input_cost_per_token": 3e-6, "output_cost_per_token": 1.5e-5
            },
            "gpt-5.4": {
                "litellm_provider": "openai", "mode": "chat",
                "input_cost_per_token": 2.5e-6, "output_cost_per_token": 1.5e-5,
                "cache_read_input_token_cost": 2.5e-7,
                "input_cost_per_token_above_272k_tokens": 5e-6,
                "output_cost_per_token_above_272k_tokens": 2.25e-5
            },
            "xai/grok-4.7": {
                "litellm_provider": "xai", "mode": "chat",
                "input_cost_per_token": 2e-6, "output_cost_per_token": 6e-6
            },
            "openrouter/openai/gpt-5.4": {
                "litellm_provider": "openrouter", "mode": "chat",
                "input_cost_per_token": 9e-6, "output_cost_per_token": 9e-6
            },
            "gpt-image-2": {
                "litellm_provider": "openai", "mode": "image_generation",
                "input_cost_per_token": 5e-6, "output_cost_per_token": 4e-5
            },
            "free-model": {
                "litellm_provider": "openai", "mode": "chat",
                "input_cost_per_token": 0, "output_cost_per_token": 0
            }
        });
        let models = models_from_json(data).unwrap();
        Catalog::from_models(&filter_models(&models), None)
    }

    #[test]
    fn field_filter() {
        assert!(is_price_field("input_cost_per_token"));
        assert!(is_price_field("cache_creation_input_token_cost_above_1hr"));
        assert!(is_price_field("cache_creation_input_token_cost_above_1hr_above_100k_tokens"));
        assert!(is_price_field("output_cost_per_token_above_272k_tokens"));
        assert!(!is_price_field("input_cost_per_token_batches"));
        assert!(!is_price_field("input_cost_per_token_above_272k_tokens_priority"));
        assert!(!is_price_field("cache_creation_input_token_cost_flex"));
        assert_eq!(tier_threshold("_above_272k_tokens"), Some(272_000));
        assert_eq!(tier_threshold("_above_1hr"), None);
    }

    #[test]
    fn keeps_first_party_chat_models_only() {
        let catalog = fixture();
        assert_eq!(catalog.len(), 4);
        assert!(catalog.get("gpt-image-2").is_none());
        assert!(catalog.get("free-model").is_none());
        // The OpenRouter resale row neither appears nor overrides OpenAI's own.
        assert!(close(catalog.get("gpt-5.4").unwrap().base.input, 2.5));
    }

    #[test]
    fn converts_streams_and_tiers() {
        let haiku = fixture().get("claude-haiku-5-5").unwrap();
        assert!(close(haiku.base.input, 0.1));
        assert!(close(haiku.base.cache_read, 0.01));
        assert!(close(haiku.base.cache_write_5m, 0.125));
        assert!(close(haiku.base.cache_write_1h, 0.2));
        assert_eq!(haiku.tiers.len(), 1);
        let tier = &haiku.tiers[0];
        assert_eq!(tier.above_tokens, 100_000);
        assert!(close(tier.rates.input, 0.5));
        assert!(close(tier.rates.cache_write_1h, 1.0));
        assert!(close(tier.rates.output, 2.5));
    }

    #[test]
    fn derives_missing_streams() {
        let catalog = fixture();
        // No cache fields at all: cache streams bill at the input rate.
        let sonnet = catalog.get("claude-sonnet-4-5-20250929").unwrap();
        assert!(close(sonnet.base.cache_read, 3.0));
        assert!(close(sonnet.base.cache_write_1h, 3.0));
        // Tier without a cache-read field scales the base cache rate.
        let gpt = catalog.get("gpt-5.4").unwrap();
        assert!(close(gpt.tiers[0].rates.cache_read, 0.5));
        assert!(close(gpt.tiers[0].rates.output, 22.5));
    }

    #[test]
    fn normalises_logged_ids() {
        let catalog = fixture();
        for id in [
            "claude-haiku-5-5",
            "CLAUDE-HAIKU-5-5",
            "anthropic/claude-haiku-5.5",
            "claude-haiku-5-5[1m]",
            "claude-haiku-5-5-20261001",
            "us.anthropic.claude-haiku-5-5-v1:0",
            "claude-haiku-5-5@20261001",
        ] {
            assert!(catalog.get(id).is_some(), "{id} should resolve");
        }
        assert!(catalog.get("grok-4.7").is_some());
        assert!(catalog.get("xai/grok-4.7").is_some());
        assert!(catalog.get("gpt-5.4-2026-03-05").is_some());
        assert!(catalog.get("gpt-5.45").is_none());
        assert!(candidates("deepseek-v3").contains(&"deepseek-v3".to_string()));
        assert!(!candidates("deepseek-v3").contains(&"deepseek".to_string()));
    }

    #[test]
    fn reads_snapshot_wrapper() {
        let text = json!({
            "_meta": { "generatedAt": "2026-11-25T00:00:00Z" },
            "models": { "gpt-5.4": { "litellm_provider": "openai", "mode": "chat",
                "input_cost_per_token": 2.5e-6, "output_cost_per_token": 1.5e-5 } }
        })
        .to_string();
        let catalog = Catalog::from_json_str(&text).unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog.generated_at(), Some("2026-11-25T00:00:00Z"));
        assert!(Catalog::from_json_str("[1, 2]").is_err());
    }
}
