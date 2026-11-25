//! Official list prices checked by hand, the last-resort price source.
//!
//! Checked on 2026-11-25 against:
//!   - Anthropic: <https://platform.claude.com/docs/en/about-claude/pricing>
//!   - OpenAI:    <https://developers.openai.com/api/docs/pricing>
//!
//! The catalogs (online / snapshot) take precedence; this table covers ids
//! they lack and keeps working offline. Only verified models are listed —
//! an unknown id returns `None` instead of borrowing a similar model's price,
//! which is how Opus 4.5+ was once billed at Opus 4's $15/$75.

use super::{ModelPrice, PriceTier, Rates};

pub(super) fn lookup(model: &str) -> Option<ModelPrice> {
    let lower = model.trim().to_ascii_lowercase();
    // Router / gateway ids put the vendor in front: keep the last segment.
    let m = lower.rsplit('/').next().unwrap_or(&lower);

    if m.contains("claude") || CLAUDE_FAMILIES.iter().any(|family| m.contains(family)) {
        let (family, major, minor) = claude_version(m)?;
        return claude_price(family, major, minor);
    }
    openai_price(m)
}

impl ModelPrice {
    fn flat(base: Rates) -> Self {
        Self { base, tiers: Vec::new() }
    }

    /// Add a tier that multiplies the base input-side and output rates.
    fn with_tier(mut self, above_tokens: u64, input_mul: f64, output_mul: f64) -> Self {
        let rates = self.base.scaled(input_mul, output_mul);
        self.tiers.push(PriceTier { above_tokens, rates });
        self
    }
}

// ── Anthropic Claude ───────────────────────────────────────────────────────

const CLAUDE_FAMILIES: [&str; 5] = ["opus", "sonnet", "haiku", "fable", "mythos"];

/// Anthropic's multipliers on the input price: 5-minute cache writes 1.25×,
/// 1-hour writes 2×, cache hits `cache_read_mul` (0.1× on most models).
fn anthropic(input: f64, output: f64, cache_read_mul: f64) -> ModelPrice {
    ModelPrice::flat(Rates {
        input,
        output,
        cache_read: input * cache_read_mul,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 2.0,
    })
}

fn claude_price(family: &str, major: u32, minor: u32) -> Option<ModelPrice> {
    Some(match (family, major, minor) {
        ("fable" | "mythos", 5, 2) => anthropic(8.00, 40.00, 0.025),
        ("fable" | "mythos", 5, 1) => anthropic(10.00, 50.00, 0.025),
        ("fable" | "mythos", 5, 0) => anthropic(10.00, 50.00, 0.10),
        ("opus", 5, 5) => anthropic(4.00, 20.00, 0.05),
        ("opus", 5, 0) => anthropic(5.00, 25.00, 0.10),
        // Opus 4.5 through 4.8 share the lower price.
        ("opus", 4, 5..) => anthropic(5.00, 25.00, 0.10),
        // Opus 4 / 4.1 and Claude 3 Opus.
        ("opus", 4 | 3, _) => anthropic(15.00, 75.00, 0.10),
        ("sonnet", 5, 5) => anthropic(2.00, 10.00, 0.05),
        ("sonnet", 5, 0) => anthropic(2.00, 10.00, 0.10),
        ("sonnet", 4 | 3, _) => anthropic(3.00, 15.00, 0.10),
        // Haiku 5.5: every rate ×5 once the prompt is over 100K tokens.
        ("haiku", 5, 5) => anthropic(0.10, 0.50, 0.10).with_tier(100_000, 5.0, 5.0),
        ("haiku", 4, 5) => anthropic(1.00, 5.00, 0.10),
        ("haiku", 3, 5) => anthropic(0.80, 4.00, 0.10),
        ("haiku", 3, 0) => anthropic(0.25, 1.25, 0.10),
        _ => return None,
    })
}

/// `(family, major, minor)` of a Claude id, in both naming schemes:
/// `claude-opus-4-7`, `claude-opus-4-20250514`, `claude-opus-4.7`,
/// `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, and the 3.x scheme
/// `claude-3-5-sonnet-20241022` / `claude-3-opus-20240229`.
fn claude_version(m: &str) -> Option<(&'static str, u32, u32)> {
    let family = CLAUDE_FAMILIES.iter().copied().find(|family| m.contains(family))?;
    let pos = m.find(family)?;
    let after = version_parts(&m[pos + family.len()..]);
    if let Some(major) = after.first().copied().flatten() {
        let minor = after.get(1).copied().flatten().unwrap_or(0);
        return Some((family, major, minor));
    }
    // 3.x scheme: the version sits between `claude-` and the family name.
    match version_parts(&m[..pos]).as_slice() {
        [.., Some(major), Some(minor)] => Some((family, *major, *minor)),
        [.., Some(major)] => Some((family, *major, 0)),
        _ => None,
    }
}

/// Split on id separators; each part is `Some(n)` when it is a short version
/// number (1–2 digits) and `None` otherwise (words, `20250929`-style dates).
fn version_parts(s: &str) -> Vec<Option<u32>> {
    s.split(['-', '.', '@', '_', ':', '[', ']', ' '])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let short_number = part.len() <= 2 && part.bytes().all(|b| b.is_ascii_digit());
            if short_number { part.parse().ok() } else { None }
        })
        .collect()
}

// ── OpenAI GPT / o-series ──────────────────────────────────────────────────

/// `(id prefix, input, cached input, output, has the >272K tier)`.
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
    let &(prefix, input, cached, output, long_context) = OPENAI_PRICES.iter().find(|(prefix, ..)| {
        m.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
    })?;
    // GPT-6.x and GPT-5.6 bill cache writes: 30-minute 1.25×, 12-hour 2.5×.
    // Older models bill written tokens as plain input.
    let (write_short, write_long) = if prefix.starts_with("gpt-6") || prefix.starts_with("gpt-5.6") {
        (input * 1.25, input * 2.5)
    } else {
        (input, input)
    };
    let price = ModelPrice::flat(Rates {
        input,
        output,
        cache_read: cached.unwrap_or(input),
        cache_write_5m: write_short,
        cache_write_1h: write_long,
    });
    // GPT-5.4 and later bill prompts over 272K tokens at input ×2, output ×1.5.
    Some(if long_context { price.with_tier(272_000, 2.0, 1.5) } else { price })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::pricing::TokenCounts;

    fn rates(model: &str) -> (f64, f64) {
        let p = lookup(model).unwrap_or_else(|| panic!("{model} should be priced"));
        (p.base.input, p.base.output)
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
    fn claude_cache_rates() {
        let opus55 = lookup("claude-opus-5-5").unwrap().base;
        assert!(close(opus55.cache_read, 0.20));
        assert!(close(opus55.cache_write_5m, 5.0));
        assert!(close(opus55.cache_write_1h, 8.0));
        assert!(close(lookup("claude-sonnet-5-5").unwrap().base.cache_read, 0.10));
        assert!(close(lookup("claude-fable-5-2").unwrap().base.cache_read, 0.20));
        assert!(close(lookup("claude-fable-5").unwrap().base.cache_read, 1.0));
        assert!(close(lookup("claude-sonnet-4-5").unwrap().base.cache_write_1h, 6.0));
    }

    #[test]
    fn unknown_models_are_not_priced() {
        for id in [
            "claude-opus-5-6", "claude-sonnet-6", "claude-opus", "<synthetic>", "gpt-5.7",
            "gpt-5.45", "gpt-6-cyborg", "grok-4.7", "deepseek-chat", "",
        ] {
            assert!(lookup(id).is_none(), "{id} should not be priced");
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
        let gpt54 = lookup("gpt-5.4").unwrap().base;
        assert!(close(gpt54.cache_read, 0.25));
        assert!(close(gpt54.cache_write_5m, 2.5));
        assert!(close(lookup("gpt-5.5-pro").unwrap().base.cache_read, 30.0));
        assert!(close(lookup("gpt-6-sol").unwrap().base.cache_write_5m, 2.5));
    }

    #[test]
    fn long_context_tiers() {
        let haiku = lookup("claude-haiku-5-5").unwrap();
        let at = TokenCounts { input: 100_000, output: 1_000_000, ..Default::default() };
        assert!(close(haiku.cost(&at), 0.01 + 0.50));
        let over = TokenCounts { input: 1, cache_read: 100_000, output: 1_000_000, ..Default::default() };
        assert!(close(haiku.cost(&over), 0.5 / 1e6 + 100_000.0 * 0.05 / 1e6 + 2.50));

        let gpt = lookup("gpt-5.4").unwrap();
        let long = TokenCounts { input: 300_000, output: 1_000_000, ..Default::default() };
        assert!(close(gpt.cost(&long), 300_000.0 * 5.0 / 1e6 + 22.5));
        let short = TokenCounts { input: 272_000, ..Default::default() };
        assert!(close(gpt.cost(&short), 272_000.0 * 2.5 / 1e6));

        let opus = lookup("claude-opus-4-7").unwrap();
        let big = TokenCounts { input: 900_000, ..Default::default() };
        assert!(close(opus.cost(&big), 900_000.0 * 5.0 / 1e6));
    }

    #[test]
    fn one_hour_cache_writes_cost_double_input() {
        let opus = lookup("claude-opus-4-7").unwrap();
        let tokens = TokenCounts { cache_write_5m: 1_000_000, cache_write_1h: 1_000_000, ..Default::default() };
        assert!(close(opus.cost(&tokens), 6.25 + 10.0));
    }
}
