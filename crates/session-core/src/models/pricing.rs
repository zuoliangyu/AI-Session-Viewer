//! Per-model token pricing and cost computation.
//!
//! Prices are USD per million tokens (USD/MTok). The built-in table mirrors
//! the providers' published list pricing, checked on 2026-11-25 against:
//!   - Anthropic: <https://platform.claude.com/docs/en/about-claude/pricing>
//!   - OpenAI:    <https://developers.openai.com/api/docs/pricing>
//!
//! Only models whose price was verified on those pages are listed. An id the
//! table does not know returns `None` ("未定价") instead of borrowing the
//! price of a similar-looking model — a too-broad match is how Opus 4.5+
//! ended up billed at Opus 4's $15/$75.
//!
//! ## Pricing rules
//!
//! Anthropic (Claude) bills four streams separately:
//!   - **input**: standard prompt tokens not served from cache
//!   - **cache_creation**: tokens written to the cache on this request
//!     (1.25× input price for 5-minute TTL caches)
//!   - **cache_read**: tokens hit in the cache (0.10× input price on most
//!     models; 0.05× on Opus 5.5 / Sonnet 5.5, 0.025× on Fable 5.1 / 5.2)
//!   - **output**: generated tokens
//!
//! Some models charge more once a single request's prompt (input + cache
//! reads + cache writes) crosses a threshold — see [`LongContextTier`].
//!
//! OpenAI (Codex) currently exposes `input_tokens` and `output_tokens` only;
//! cache hits are reflected inside `input_tokens`. Callers pass `cache_*` as 0
//! for Codex models so the math still works without double-counting.

/// Higher rates a provider charges once one request's prompt crosses a
/// threshold. The prompt length counts input, cache-read and cache-write
/// tokens of that single request.
#[derive(Debug, Clone, Copy)]
pub struct LongContextTier {
    /// The tier applies when the prompt is strictly longer than this.
    pub threshold_tokens: u64,
    /// Applied to the input rate, and through it to cache reads and writes.
    pub input_multiplier: f64,
    /// Applied to the output rate.
    pub output_multiplier: f64,
}

/// USD per million input / cache_creation / cache_read / output tokens.
#[derive(Debug, Clone, Copy)]
pub struct ModelPrice {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    /// Multiplier applied to `input_per_mtok` for cache-creation tokens.
    /// Anthropic charges 1.25× for the default 5-minute cache.
    pub cache_creation_multiplier: f64,
    /// Multiplier applied to `input_per_mtok` for cache-read tokens.
    pub cache_read_multiplier: f64,
    /// Long-prompt surcharge, if the model has one.
    pub long_context: Option<LongContextTier>,
}

impl ModelPrice {
    const fn anthropic(input: f64, output: f64) -> Self {
        Self {
            input_per_mtok: input,
            output_per_mtok: output,
            cache_creation_multiplier: 1.25,
            cache_read_multiplier: 0.10,
            long_context: None,
        }
    }

    /// OpenAI lists the cached-input price directly; `None` means the model
    /// has no cache discount.
    fn openai(input: f64, cached_input: Option<f64>, output: f64) -> Self {
        Self {
            input_per_mtok: input,
            output_per_mtok: output,
            // Codex JSONL doesn't separate cache streams; multipliers are
            // unused in practice but kept accurate for parity.
            cache_creation_multiplier: 1.0,
            cache_read_multiplier: cached_input.map_or(1.0, |cached| cached / input),
            long_context: None,
        }
    }

    const fn with_cache_read(mut self, multiplier: f64) -> Self {
        self.cache_read_multiplier = multiplier;
        self
    }

    const fn with_long_context(mut self, threshold_tokens: u64, input_multiplier: f64, output_multiplier: f64) -> Self {
        self.long_context = Some(LongContextTier {
            threshold_tokens,
            input_multiplier,
            output_multiplier,
        });
        self
    }
}

/// Resolve a model identifier to a price entry. Accepts dated snapshots
/// (`claude-sonnet-4-5-20250929`), dotted versions and router prefixes
/// (`anthropic/claude-opus-4.7`, `openai/gpt-5.4`). Returns `None` for
/// unknown models — the caller decides whether to fall back to zero cost or
/// a generic estimate.
pub fn lookup(model: &str) -> Option<ModelPrice> {
    let lower = model.trim().to_ascii_lowercase();
    // Router / gateway ids put the vendor in front: keep the last segment.
    let m = lower.rsplit('/').next().unwrap_or(&lower);

    if m.contains("claude") || CLAUDE_FAMILIES.iter().any(|f| m.contains(f)) {
        if let Some((family, major, minor)) = claude_version(m) {
            return claude_price(family, major, minor);
        }
        return None;
    }
    openai_price(m)
}

// ── Anthropic Claude ───────────────────────────────────────────────────────

const CLAUDE_FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "mythos"];

fn claude_price(family: &str, major: u32, minor: u32) -> Option<ModelPrice> {
    let p = ModelPrice::anthropic;
    Some(match (family, major, minor) {
        ("fable" | "mythos", 5, 2) => p(8.00, 40.00).with_cache_read(0.025),
        ("fable" | "mythos", 5, 1) => p(10.00, 50.00).with_cache_read(0.025),
        ("fable" | "mythos", 5, 0) => p(10.00, 50.00),
        ("opus", 5, 5) => p(4.00, 20.00).with_cache_read(0.05),
        ("opus", 5, 0) => p(5.00, 25.00),
        // Opus 4.5 through 4.8 share the lower price.
        ("opus", 4, 5..) => p(5.00, 25.00),
        // Opus 4 / 4.1 and Claude 3 Opus.
        ("opus", 4 | 3, _) => p(15.00, 75.00),
        ("sonnet", 5, 5) => p(2.00, 10.00).with_cache_read(0.05),
        ("sonnet", 5, 0) => p(2.00, 10.00),
        ("sonnet", 4 | 3, _) => p(3.00, 15.00),
        // Haiku 5.5: every rate ×5 once the prompt is over 100K tokens.
        ("haiku", 5, 5) => p(0.10, 0.50).with_long_context(100_000, 5.0, 5.0),
        ("haiku", 4, 5) => p(1.00, 5.00),
        ("haiku", 3, 5) => p(0.80, 4.00),
        ("haiku", 3, 0) => p(0.25, 1.25),
        _ => return None,
    })
}

/// `(family, major, minor)` of a Claude id, in both naming schemes:
/// `claude-opus-4-7`, `claude-opus-4-20250514`, `claude-opus-4.7`,
/// `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, and the 3.x scheme
/// `claude-3-5-sonnet-20241022` / `claude-3-opus-20240229`.
fn claude_version(m: &str) -> Option<(&'static str, u32, u32)> {
    let family = CLAUDE_FAMILIES.into_iter().find(|f| m.contains(f))?;
    let pos = m.find(family)?;
    let after = version_parts(&m[pos + family.len()..]);
    if let Some(major) = after.first().copied().flatten() {
        let minor = after.get(1).copied().flatten().unwrap_or(0);
        return Some((family, major, minor));
    }
    // 3.x scheme: the version sits between `claude-` and the family name.
    let before = version_parts(&m[..pos]);
    match before.as_slice() {
        [.., Some(major), Some(minor)] => Some((family, *major, *minor)),
        [.., Some(major)] => Some((family, *major, 0)),
        _ => None,
    }
}

/// Split on id separators; each part is `Some(n)` when it is a short version
/// number (1–2 digits) and `None` otherwise (words, `20250929`-style dates).
fn version_parts(s: &str) -> Vec<Option<u32>> {
    s.split(|c: char| matches!(c, '-' | '.' | '@' | '_' | ':' | '[' | ']' | ' '))
        .filter(|part| !part.is_empty())
        .map(|part| {
            let short_number = part.len() <= 2 && part.bytes().all(|b| b.is_ascii_digit());
            if short_number { part.parse().ok() } else { None }
        })
        .collect()
}

// ── OpenAI GPT / o-series ──────────────────────────────────────────────────

/// GPT-5.4 and later bill more for prompts over 272K tokens:
/// input and cached input ×2, output ×1.5.
const OPENAI_LONG_CONTEXT: (u64, f64, f64) = (272_000, 2.0, 1.5);

/// `(id prefix, input, cached input, output, has long-context tier)`.
/// First match wins, so a variant must come before its base model. A prefix
/// only matches when the id ends there or continues with `-`, so `gpt-5`
/// never matches `gpt-5.7` and `gpt-5.4` never matches `gpt-5.45`.
const OPENAI_PRICES: &[(&str, f64, Option<f64>, f64, bool)] = &[
    ("gpt-6.2-astra", 8.00, Some(0.40), 40.00, true),
    ("gpt-6.2-sol", 2.00, Some(0.10), 10.00, true),
    ("gpt-6.1-sol", 2.00, Some(0.10), 10.00, true),
    ("gpt-6.1-terra", 1.00, Some(0.05), 5.00, true),
    ("gpt-6-cyber", 20.00, Some(2.00), 100.00, true),
    ("gpt-6-rosalind", 10.00, Some(1.00), 50.00, true),
    ("gpt-6-astra", 10.00, Some(1.00), 50.00, true),
    ("gpt-6-sol", 2.00, Some(0.20), 10.00, true),
    ("gpt-6-luna", 0.10, Some(0.01), 0.50, true),
    ("gpt-5.6-cyber", 12.50, Some(1.25), 75.00, false),
    ("gpt-5.6-sol", 4.00, Some(0.40), 20.00, true),
    ("gpt-5.6-terra", 2.00, Some(0.20), 12.00, true),
    ("gpt-5.6-luna", 0.20, Some(0.02), 1.20, true),
    ("gpt-5.5-cyber", 12.50, Some(1.25), 75.00, false),
    ("gpt-5.5-pro", 30.00, None, 180.00, true),
    ("gpt-5.5", 5.00, Some(0.50), 30.00, true),
    ("gpt-5.4-pro", 30.00, None, 180.00, true),
    ("gpt-5.4-mini", 0.75, Some(0.075), 4.50, false),
    ("gpt-5.4-nano", 0.20, Some(0.02), 1.25, false),
    ("gpt-5.4", 2.50, Some(0.25), 15.00, true),
    ("gpt-5.3-codex", 1.75, Some(0.175), 14.00, false),
    ("gpt-5.2-pro", 21.00, None, 168.00, false),
    ("gpt-5.2", 1.75, Some(0.175), 14.00, false),
    ("gpt-5.1-codex-mini", 0.25, Some(0.025), 2.00, false),
    ("gpt-5.1", 1.25, Some(0.125), 10.00, false),
    ("gpt-5-pro", 15.00, None, 120.00, false),
    ("gpt-5-mini", 0.25, Some(0.025), 2.00, false),
    ("gpt-5-nano", 0.05, Some(0.005), 0.40, false),
    ("gpt-5", 1.25, Some(0.125), 10.00, false),
    ("gpt-4.1-mini", 0.40, Some(0.10), 1.60, false),
    ("gpt-4.1-nano", 0.10, Some(0.025), 0.40, false),
    ("gpt-4.1", 2.00, Some(0.50), 8.00, false),
    ("gpt-4o-mini", 0.15, Some(0.075), 0.60, false),
    ("gpt-4o", 2.50, Some(1.25), 10.00, false),
    ("o4-mini", 1.10, Some(0.275), 4.40, false),
    ("o3-pro", 20.00, None, 80.00, false),
    ("o3-mini", 1.10, Some(0.55), 4.40, false),
    ("o3", 2.00, Some(0.50), 8.00, false),
    ("o1-pro", 150.00, None, 600.00, false),
    ("o1-mini", 1.10, Some(0.55), 4.40, false),
    ("o1", 15.00, Some(7.50), 60.00, false),
];

fn openai_price(m: &str) -> Option<ModelPrice> {
    OPENAI_PRICES
        .iter()
        .find(|(prefix, ..)| {
            m.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
        })
        .map(|&(_, input, cached, output, long)| {
            let price = ModelPrice::openai(input, cached, output);
            if long {
                let (threshold, input_mul, output_mul) = OPENAI_LONG_CONTEXT;
                price.with_long_context(threshold, input_mul, output_mul)
            } else {
                price
            }
        })
}

// ── Cost ───────────────────────────────────────────────────────────────────

/// Compute the USD cost of a single request given its token breakdown.
/// Unknown models cost 0.0 (caller may surface this as "未定价").
///
/// Long-context tiers are decided per call, so the token counts must describe
/// one request. Codex rollouts that lack `last_token_usage` are priced from
/// cumulative deltas, which can span several requests and may cross a
/// threshold that no single request did.
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
    let prompt_tokens = input_tokens
        .saturating_add(cache_creation_tokens)
        .saturating_add(cache_read_tokens);
    let (input_mul, output_mul) = match price.long_context {
        Some(tier) if prompt_tokens > tier.threshold_tokens => (tier.input_multiplier, tier.output_multiplier),
        _ => (1.0, 1.0),
    };
    let per_token_input = price.input_per_mtok * input_mul / 1_000_000.0;
    let per_token_output = price.output_per_mtok * output_mul / 1_000_000.0;

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

    fn rates(model: &str) -> (f64, f64) {
        let p = lookup(model).unwrap_or_else(|| panic!("{model} should be priced"));
        (p.input_per_mtok, p.output_per_mtok)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn claude_current_and_dated_ids() {
        assert_eq!(rates("claude-opus-4-7"), (5.0, 25.0));
        assert_eq!(rates("claude-opus-4-5-20251101"), (5.0, 25.0));
        assert_eq!(rates("claude-opus-4-8"), (5.0, 25.0));
        assert_eq!(rates("claude-opus-4-1-20250805"), (15.0, 75.0));
        assert_eq!(rates("claude-opus-4-20250514"), (15.0, 75.0));
        assert_eq!(rates("claude-opus-5"), (5.0, 25.0));
        assert_eq!(rates("claude-opus-5-5"), (4.0, 20.0));
        assert_eq!(rates("claude-sonnet-5"), (2.0, 10.0));
        assert_eq!(rates("claude-sonnet-5-5"), (2.0, 10.0));
        assert_eq!(rates("claude-sonnet-4-5-20250929"), (3.0, 15.0));
        assert_eq!(rates("claude-haiku-4-5-20251001"), (1.0, 5.0));
        assert_eq!(rates("claude-haiku-5-5"), (0.10, 0.50));
        assert_eq!(rates("claude-fable-5-2"), (8.0, 40.0));
        assert_eq!(rates("claude-mythos-5-1"), (10.0, 50.0));
    }

    #[test]
    fn claude_legacy_and_prefixed_ids() {
        assert_eq!(rates("claude-3-5-sonnet-20241022"), (3.0, 15.0));
        assert_eq!(rates("claude-3-7-sonnet-latest"), (3.0, 15.0));
        assert_eq!(rates("claude-3-5-haiku-20241022"), (0.80, 4.00));
        assert_eq!(rates("claude-3-haiku-20240307"), (0.25, 1.25));
        assert_eq!(rates("claude-3-opus-20240229"), (15.0, 75.0));
        assert_eq!(rates("anthropic/claude-opus-4.7"), (5.0, 25.0));
        assert_eq!(rates("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), (3.0, 15.0));
        assert_eq!(rates("Claude-Opus-4-6"), (5.0, 25.0));
    }

    #[test]
    fn claude_cache_multipliers() {
        let opus55 = lookup("claude-opus-5-5").unwrap();
        assert!(close(opus55.cache_read_multiplier, 0.05));
        assert!(close(opus55.cache_creation_multiplier, 1.25));
        assert!(close(lookup("claude-sonnet-5-5").unwrap().cache_read_multiplier, 0.05));
        assert!(close(lookup("claude-fable-5-2").unwrap().cache_read_multiplier, 0.025));
        assert!(close(lookup("claude-fable-5").unwrap().cache_read_multiplier, 0.10));
        assert!(close(lookup("claude-sonnet-4-5").unwrap().cache_read_multiplier, 0.10));
    }

    #[test]
    fn unknown_models_are_not_priced() {
        for id in ["claude-opus-5-6", "claude-sonnet-6", "claude-opus", "<synthetic>", "gpt-5.7", "gpt-5.45", "gpt-6-cyborg", "grok-4.7", "deepseek-chat", ""] {
            assert!(!is_priced(id), "{id} should not be priced");
        }
    }

    #[test]
    fn openai_variants() {
        assert_eq!(rates("gpt-5.5"), (5.0, 30.0));
        assert_eq!(rates("gpt-5.4"), (2.5, 15.0));
        assert_eq!(rates("gpt-5.4-mini"), (0.75, 4.5));
        assert_eq!(rates("gpt-5.3-codex"), (1.75, 14.0));
        assert_eq!(rates("gpt-5.2-codex"), (1.75, 14.0));
        assert_eq!(rates("gpt-5.1-codex-max"), (1.25, 10.0));
        assert_eq!(rates("gpt-5.1-codex-mini"), (0.25, 2.0));
        assert_eq!(rates("gpt-5-codex"), (1.25, 10.0));
        assert_eq!(rates("gpt-5-mini"), (0.25, 2.0));
        assert_eq!(rates("gpt-5.5-cyber-preview"), (12.5, 75.0));
        assert_eq!(rates("gpt-6.2-astra-law"), (8.0, 40.0));
        assert_eq!(rates("openai/gpt-5.4"), (2.5, 15.0));
        assert_eq!(rates("gpt-4o-2024-08-06"), (2.5, 10.0));
        assert_eq!(rates("o3"), (2.0, 8.0));
        assert_eq!(rates("o3-mini"), (1.1, 4.4));
        assert!(close(lookup("gpt-5.4").unwrap().cache_read_multiplier, 0.1));
        assert!(close(lookup("gpt-5.5-pro").unwrap().cache_read_multiplier, 1.0));
    }

    #[test]
    fn long_context_tiers() {
        // Haiku 5.5: 100K tokens is still the base tier; one more moves the
        // whole request to the ×5 rates, cache reads included.
        let base = compute_cost("claude-haiku-5-5", 100_000, 0, 0, 1_000_000);
        assert!(close(base, 0.01 + 0.50));
        let long = compute_cost("claude-haiku-5-5", 1, 0, 100_000, 1_000_000);
        assert!(close(long, 0.5 / 1e6 + 100_000.0 * 0.05 / 1e6 + 2.50));

        // GPT-5.4 over 272K: input ×2, output ×1.5.
        let gpt = compute_cost("gpt-5.4", 300_000, 0, 0, 1_000_000);
        assert!(close(gpt, 300_000.0 * 5.0 / 1e6 + 22.5));
        let gpt_short = compute_cost("gpt-5.4", 272_000, 0, 0, 0);
        assert!(close(gpt_short, 272_000.0 * 2.5 / 1e6));

        // Models without a tier are flat at any length.
        let opus = compute_cost("claude-opus-4-7", 900_000, 0, 0, 0);
        assert!(close(opus, 900_000.0 * 5.0 / 1e6));
    }

    #[test]
    fn cost_streams_add_up() {
        // Opus 5.5: $4 input, $5 cache write, $0.20 cache read, $20 output.
        let cost = compute_cost("claude-opus-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000);
        assert!(close(cost, 4.0 + 5.0 + 0.20 + 20.0));
        assert!(close(compute_cost("unknown-model", 1_000_000, 0, 0, 1_000_000), 0.0));
    }
}
