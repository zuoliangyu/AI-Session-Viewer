//! Per-model token pricing and cost computation.
//!
//! Prices are USD per million tokens (USD/MTok). A model id is resolved in
//! this order, first hit wins:
//!
//! 1. **Online catalog** — LiteLLM's community price list, downloaded by
//!    [`crate::pricing_sync`] when the user turns on online updates.
//! 2. **Snapshot** — the same list filtered and committed to
//!    `crates/session-core/data/model-prices.json` by
//!    `scripts/sync-prices.mjs`, embedded at build time.
//! 3. **Built-in table** — official Anthropic / OpenAI list prices checked by
//!    hand ([`builtin`]); covers ids the catalogs lack (older snapshots,
//!    unusual spellings).
//!
//! Unknown ids return `None` ("未定价") rather than borrowing a similar
//! model's price.
//!
//! ## Token streams
//!
//! [`TokenCounts`] splits a request's prompt into uncached input, cache
//! reads and cache writes (5-minute and 1-hour TTL), plus output. Some
//! models bill every stream at higher rates once one request's prompt
//! crosses a threshold; see [`PriceTier`].

mod builtin;
mod catalog;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use parking_lot::{Mutex, RwLock};

pub use catalog::Catalog;
pub(crate) use catalog::{filter_models, models_from_json};

/// USD per million tokens for each billed stream.
#[derive(Debug, Clone, PartialEq)]
pub struct Rates {
    /// Prompt tokens not served from or written to the cache.
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// Cache writes with the short TTL (Anthropic 5 minutes, OpenAI 30 minutes).
    pub cache_write_5m: f64,
    /// Cache writes with the long TTL (Anthropic 1 hour, OpenAI 12 hours).
    pub cache_write_1h: f64,
}

impl Rates {
    /// Multiply every input-side rate by `input_mul` and the output rate by
    /// `output_mul`.
    pub(crate) fn scaled(&self, input_mul: f64, output_mul: f64) -> Self {
        Self {
            input: self.input * input_mul,
            output: self.output * output_mul,
            cache_read: self.cache_read * input_mul,
            cache_write_5m: self.cache_write_5m * input_mul,
            cache_write_1h: self.cache_write_1h * input_mul,
        }
    }
}

/// Rates that replace the base rates for a request whose prompt (input +
/// cache reads + cache writes) is strictly longer than `above_tokens`.
#[derive(Debug, Clone, PartialEq)]
pub struct PriceTier {
    pub above_tokens: u64,
    pub rates: Rates,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelPrice {
    pub base: Rates,
    /// Sorted by `above_tokens`, ascending.
    pub tiers: Vec<PriceTier>,
}

impl ModelPrice {
    /// The rates that apply to a request with this many prompt tokens.
    pub fn rates_for(&self, prompt_tokens: u64) -> &Rates {
        self.tiers
            .iter()
            .rev()
            .find(|tier| prompt_tokens > tier.above_tokens)
            .map_or(&self.base, |tier| &tier.rates)
    }

    /// USD cost of one request.
    pub fn cost(&self, tokens: &TokenCounts) -> f64 {
        let rates = self.rates_for(tokens.prompt_tokens());
        let micro = tokens.input as f64 * rates.input
            + tokens.cache_read as f64 * rates.cache_read
            + tokens.cache_write_5m as f64 * rates.cache_write_5m
            + tokens.cache_write_1h as f64 * rates.cache_write_1h
            + tokens.output as f64 * rates.output;
        micro / 1_000_000.0
    }
}

/// Token usage of a single request, split by billing stream.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TokenCounts {
    /// Prompt tokens billed at the base input rate.
    pub input: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub output: u64,
}

impl TokenCounts {
    /// Prompt length used to pick a long-context tier.
    pub fn prompt_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write_5m)
            .saturating_add(self.cache_write_1h)
    }
}

// ── Price sources ──────────────────────────────────────────────────────────

const SNAPSHOT_JSON: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/data/model-prices.json"));

static SNAPSHOT: LazyLock<Catalog> = LazyLock::new(|| {
    Catalog::from_json_str(SNAPSHOT_JSON).unwrap_or_else(|error| {
        eprintln!("[pricing] built-in price snapshot is unreadable: {error}");
        Catalog::default()
    })
});

static ONLINE: LazyLock<RwLock<Option<Arc<Catalog>>>> = LazyLock::new(|| RwLock::new(None));

/// Resolved prices by exact model string. Stats views price every request
/// record, so most lookups hit this map. Cleared when the online catalog
/// changes.
static MEMO: LazyLock<Mutex<HashMap<String, Option<Arc<ModelPrice>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The catalog compiled into the binary.
pub fn snapshot_catalog() -> &'static Catalog {
    &SNAPSHOT
}

/// The downloaded catalog, if online updates are on and one has loaded.
pub fn online_catalog() -> Option<Arc<Catalog>> {
    ONLINE.read().clone()
}

/// Replace (or with `None`, drop) the downloaded catalog.
pub fn set_online_catalog(catalog: Option<Arc<Catalog>>) {
    // Release the write lock before touching MEMO: `lookup` holds MEMO while
    // it reads ONLINE, so nesting the other way round could deadlock.
    {
        *ONLINE.write() = catalog;
    }
    MEMO.lock().clear();
}

/// Resolve a model identifier to its price. Returns `None` for unknown
/// models — the caller decides whether to show "未定价" or zero cost.
pub fn lookup(model: &str) -> Option<Arc<ModelPrice>> {
    let mut memo = MEMO.lock();
    if let Some(hit) = memo.get(model) {
        return hit.clone();
    }
    let found = resolve(model);
    memo.insert(model.to_string(), found.clone());
    found
}

fn resolve(model: &str) -> Option<Arc<ModelPrice>> {
    if let Some(online) = ONLINE.read().as_ref() {
        if let Some(price) = online.get(model) {
            return Some(price);
        }
    }
    SNAPSHOT.get(model).or_else(|| builtin::lookup(model).map(Arc::new))
}

/// USD cost of a single request. Unknown models cost 0.0 (callers surface
/// this as "未定价" through [`is_priced`]).
///
/// Long-context tiers are decided per call, so the counts must describe one
/// request. Codex rollouts that lack `last_token_usage` are priced from
/// cumulative deltas, which can span several requests and may cross a
/// threshold that no single request did.
pub fn compute_cost(model: &str, tokens: &TokenCounts) -> f64 {
    lookup(model).map_or(0.0, |price| price.cost(tokens))
}

/// Whether a model has a known price. UI uses this to annotate rows with
/// "未定价" instead of a misleading $0.00.
pub fn is_priced(model: &str) -> bool {
    lookup(model).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn flat(input: f64, output: f64) -> Rates {
        Rates {
            input,
            output,
            cache_read: input * 0.1,
            cache_write_5m: input * 1.25,
            cache_write_1h: input * 2.0,
        }
    }

    #[test]
    fn cost_adds_every_stream() {
        let price = ModelPrice { base: flat(4.0, 20.0), tiers: Vec::new() };
        let tokens = TokenCounts {
            input: 1_000_000,
            cache_read: 1_000_000,
            cache_write_5m: 1_000_000,
            cache_write_1h: 1_000_000,
            output: 1_000_000,
        };
        assert!(close(price.cost(&tokens), 4.0 + 0.4 + 5.0 + 8.0 + 20.0));
    }

    #[test]
    fn tiers_apply_strictly_above_threshold() {
        let base = flat(0.1, 0.5);
        let price = ModelPrice {
            tiers: vec![PriceTier { above_tokens: 100_000, rates: base.scaled(5.0, 5.0) }],
            base,
        };
        let at = TokenCounts { input: 100_000, output: 1_000_000, ..Default::default() };
        assert!(close(price.cost(&at), 0.01 + 0.5));
        // Cache reads count toward the prompt length and are billed at the tier rate.
        let over = TokenCounts { input: 1, cache_read: 100_000, output: 1_000_000, ..Default::default() };
        assert!(close(price.cost(&over), 0.5 / 1e6 + 100_000.0 * 0.05 / 1e6 + 2.5));
    }

    #[test]
    fn highest_crossed_tier_wins() {
        let base = flat(1.0, 2.0);
        let price = ModelPrice {
            tiers: vec![
                PriceTier { above_tokens: 128_000, rates: base.scaled(2.0, 2.0) },
                PriceTier { above_tokens: 256_000, rates: base.scaled(4.0, 4.0) },
            ],
            base,
        };
        assert!(close(price.rates_for(100_000).input, 1.0));
        assert!(close(price.rates_for(200_000).input, 2.0));
        assert!(close(price.rates_for(300_000).input, 4.0));
    }

    #[test]
    fn snapshot_loads_and_prices_current_models() {
        let snapshot = snapshot_catalog();
        assert!(snapshot.len() > 100, "snapshot has only {} models", snapshot.len());
        for id in ["claude-opus-4-7", "claude-sonnet-4-5-20250929", "gpt-5.4", "gpt-5.3-codex"] {
            let price = snapshot.get(id).unwrap_or_else(|| panic!("{id} missing from snapshot"));
            assert!(price.base.input > 0.0 && price.base.output > 0.0, "{id} has no price");
        }
    }

    #[test]
    fn lookup_falls_back_to_builtin_table() {
        // Dotted, router-prefixed spelling resolves through the catalog
        // normalisation or the built-in parser either way.
        assert!(is_priced("anthropic/claude-opus-4.7"));
        assert!(is_priced("claude-3-5-haiku-20241022"));
        assert!(!is_priced("<synthetic>"));
        assert!(!is_priced("definitely-not-a-model"));
        assert!(close(compute_cost("definitely-not-a-model", &TokenCounts { input: 1_000_000, ..Default::default() }), 0.0));
    }
}
