use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The stats-cache.json file structure (Claude-specific)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCache {
    pub version: Option<u32>,
    pub last_computed_date: Option<String>,
    #[serde(default)]
    pub daily_activity: Vec<DailyActivity>,
    #[serde(default)]
    pub daily_model_tokens: Vec<DailyModelTokens>,
    #[serde(default)]
    pub model_usage: HashMap<String, ModelUsageEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageEntry {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyActivity {
    pub date: String,
    pub message_count: u64,
    pub session_count: u64,
    pub tool_call_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyModelTokens {
    pub date: String,
    pub tokens_by_model: HashMap<String, u64>,
}

/// Unified token usage summary (works for both Claude and Codex).
///
/// Field naming:
///   - `total_input_tokens` is the pure non-cached input stream (Claude
///     `input_tokens`). For backwards compatibility with v2.13.0 clients
///     that read this as "all of the input side", the frontend also has
///     `total_cache_read_tokens` and `total_cache_creation_tokens` and can
///     sum them itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSummary {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    pub total_tokens: u64,
    pub total_cost_usd: f64,
    pub tokens_by_model: HashMap<String, u64>,
    pub cost_by_model: HashMap<String, f64>,
    pub daily_tokens: Vec<DailyTokenEntry>,
    pub session_count: u64,
    pub message_count: u64,
    /// True when no prior cache existed — first-time full scan (may be slow)
    #[serde(default)]
    pub is_first_build: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyTokenEntry {
    pub date: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    /// Number of assistant messages produced on this date.
    #[serde(default)]
    pub message_count: u64,
    /// Per-model cache hit ratio for this day:
    /// `cache_read / (input + cache_read + cache_creation)`. Empty when no
    /// data, useful for the "cache hit rate trend" chart.
    #[serde(default)]
    pub cache_hit_ratio_by_model: HashMap<String, f64>,
}

/// A single assistant request as seen in a JSONL file. The frontend renders
/// these one-per-row in the "逐请求账单" view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRecord {
    pub timestamp: String,
    pub source: String,
    pub project_id: String,
    pub session_id: String,
    pub file_path: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    /// Milliseconds between the preceding user message and this assistant
    /// message. `None` when no user message preceded (sidechain, system).
    pub duration_ms: Option<u64>,
    /// The matched UUID of the assistant message — lets the frontend deep
    /// link into the message viewer with a highlight.
    pub message_uuid: Option<String>,
}

/// Paginated request log response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogPage {
    pub records: Vec<RequestRecord>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    pub has_more: bool,
    pub total_cost_usd: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
}

/// Per-project cost / token totals used by the "项目花费排行" chart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCostEntry {
    pub source: String,
    pub project_id: String,
    pub display_name: String,
    pub request_count: u64,
    pub total_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64,
}

/// Per-session cost summary used by the MessagesPage badge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCostSummary {
    pub source: String,
    pub session_id: String,
    pub file_path: String,
    pub request_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    /// Average cost per request, USD. `None` when `request_count == 0`.
    pub avg_cost_usd: Option<f64>,
    /// Each request in chronological order — small enough (typically <100)
    /// to ship in one shot so the modal can render without further calls.
    pub requests: Vec<RequestRecord>,
}
