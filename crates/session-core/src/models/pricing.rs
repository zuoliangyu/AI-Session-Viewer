//! Per-model token pricing and cost computation.
//!
//! Prices are USD per million tokens (USD/MTok). The table below mirrors
//! Anthropic's and OpenAI's published list pricing as of 2026-04. The table
//! is updated alongside app releases — there is no runtime sync, since list
//! prices change rarely and a stale entry is better than a network failure
//! at viewer launch.
//!
//! ## Pricing rules
//!
//! Anthropic (Claude) bills four streams separately:
//!   - **input**: standard prompt tokens not served from cache
//!   - **cache_creation**: tokens written to the cache on this request
//!     (1.25× input price for 5-minute TTL caches)
//!   - **cache_read**: tokens hit in the cache (0.10× input price)
//!   - **output**: generated tokens
//!
//! OpenAI (Codex) currently exposes cumulative `input_tokens` and
//! `output_tokens` only; cache hits are reflected inside `input_tokens`. The
//! pricing function treats `cache_*` as 0 for Codex models so the math still
//! works without double-counting.

/// USD per million input / cache_creation / cache_read / output tokens.
#[derive(Debug, Clone, Copy)]
pub struct ModelPrice {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    /// Multiplier applied to `input_per_mtok` for cache-creation tokens.
    /// Anthropic charges 1.25× for the default 5-minute cache.
    pub cache_creation_multiplier: f64,
    /// Multiplier applied to `input_per_mtok` for cache-read tokens.
    /// Anthropic charges 0.10× for served-from-cache tokens.
    pub cache_read_multiplier: f64,
}

impl ModelPrice {
    const fn anthropic(input: f64, output: f64) -> Self {
        Self {
            input_per_mtok: input,
            output_per_mtok: output,
            cache_creation_multiplier: 1.25,
            cache_read_multiplier: 0.10,
        }
    }

    const fn openai(input: f64, output: f64) -> Self {
        Self {
            input_per_mtok: input,
            output_per_mtok: output,
            // Codex JSONL doesn't separate cache streams; multipliers are
            // unused in practice but kept defaulted for parity.
            cache_creation_multiplier: 1.0,
            cache_read_multiplier: 0.25,
        }
    }
}

/// Resolve a model identifier to a price entry. The match is permissive:
/// we look for known prefixes so dated suffixes (`claude-sonnet-4-5-20250929`)
/// still resolve. Returns `None` for unknown models — the caller decides
/// whether to fall back to zero cost or a generic estimate.
pub fn lookup(model: &str) -> Option<ModelPrice> {
    if let Some(p) = llm_prices::lookup(model) {
        if let (Some(input), Some(output)) = (p.input, p.output) {
            if input > 0.0 {
                return Some(ModelPrice {
                    input_per_mtok: input,
                    output_per_mtok: output,
                    cache_creation_multiplier: p.cache_write("5m").map_or(1.0, |w| w / input),
                    cache_read_multiplier: p.cache_read.map_or(1.0, |r| r / input),
                });
            }
        }
    }
    let m = model.to_ascii_lowercase();

    // ── Anthropic Claude 4.x family ────────────────────────────────────────
    if m.contains("opus-4") {
        return Some(ModelPrice::anthropic(15.00, 75.00));
    }
    if m.contains("sonnet-4") {
        return Some(ModelPrice::anthropic(3.00, 15.00));
    }
    if m.contains("haiku-4") {
        return Some(ModelPrice::anthropic(1.00, 5.00));
    }
    // ── Anthropic Claude 3.x family (kept for older sessions) ──────────────
    if m.contains("opus-3") || m.contains("claude-3-opus") {
        return Some(ModelPrice::anthropic(15.00, 75.00));
    }
    if m.contains("sonnet-3-7") || m.contains("claude-3-7-sonnet") {
        return Some(ModelPrice::anthropic(3.00, 15.00));
    }
    if m.contains("sonnet-3-5") || m.contains("claude-3-5-sonnet") {
        return Some(ModelPrice::anthropic(3.00, 15.00));
    }
    if m.contains("haiku-3-5") || m.contains("claude-3-5-haiku") {
        return Some(ModelPrice::anthropic(0.80, 4.00));
    }
    if m.contains("haiku-3") || m.contains("claude-3-haiku") {
        return Some(ModelPrice::anthropic(0.25, 1.25));
    }
    // ── OpenAI Codex / GPT family ──────────────────────────────────────────
    if m.starts_with("gpt-5") {
        return Some(ModelPrice::openai(1.25, 10.00));
    }
    if m.starts_with("gpt-4.1") {
        return Some(ModelPrice::openai(2.00, 8.00));
    }
    if m.starts_with("gpt-4o-mini") {
        return Some(ModelPrice::openai(0.15, 0.60));
    }
    if m.starts_with("gpt-4o") {
        return Some(ModelPrice::openai(2.50, 10.00));
    }
    if m.starts_with("o4-mini") {
        return Some(ModelPrice::openai(1.10, 4.40));
    }
    if m.starts_with("o3-mini") {
        return Some(ModelPrice::openai(1.10, 4.40));
    }
    if m.starts_with("o3") {
        return Some(ModelPrice::openai(2.00, 8.00));
    }
    if m.starts_with("o1-mini") {
        return Some(ModelPrice::openai(1.10, 4.40));
    }
    if m.starts_with("o1") {
        return Some(ModelPrice::openai(15.00, 60.00));
    }
    None
}

/// Compute the USD cost of a single request given its token breakdown.
/// Unknown models cost 0.0 (caller may surface this as "未定价").
pub fn compute_cost(
    model: &str,
    input_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    output_tokens: u64,
) -> f64 {
    let Some(price) = lookup(model) else {
        return 0.0;
    };
    let per_token_input = price.input_per_mtok / 1_000_000.0;
    let per_token_output = price.output_per_mtok / 1_000_000.0;

    let input = input_tokens as f64 * per_token_input;
    let cache_w = cache_creation_tokens as f64 * per_token_input * price.cache_creation_multiplier;
    let cache_r = cache_read_tokens as f64 * per_token_input * price.cache_read_multiplier;
    let output = output_tokens as f64 * per_token_output;

    input + cache_w + cache_r + output
}

/// Indicate whether a model has a known price entry. UI can use this to
/// annotate rows with "未定价" instead of misleading $0.00.
pub fn is_priced(model: &str) -> bool {
    lookup(model).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_models_use_their_own_list_price() {
        let opus = lookup("claude-opus-4-7").unwrap();
        assert_eq!((opus.input_per_mtok, opus.output_per_mtok), (5.0, 25.0));
        let gpt = lookup("gpt-5.5").unwrap();
        assert_eq!((gpt.input_per_mtok, gpt.output_per_mtok), (5.0, 30.0));
        let gpt = lookup("gpt-5.4").unwrap();
        assert_eq!((gpt.input_per_mtok, gpt.output_per_mtok), (2.5, 15.0));
        assert!(is_priced("claude-opus-5"));
        assert!(is_priced("claude-sonnet-5"));
        let sonnet = lookup("claude-sonnet-4-5-20250929").unwrap();
        assert!((sonnet.cache_creation_multiplier - 1.25).abs() < 1e-9);
        assert!((sonnet.cache_read_multiplier - 0.10).abs() < 1e-9);
    }
}
