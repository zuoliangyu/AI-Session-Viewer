use std::collections::HashMap;
use std::fs;

use crate::models::stats::{DailyTokenEntry, StatsCache, TokenUsageSummary};
use crate::parser::path_encoder::get_stats_cache_path;

#[tauri::command]
pub fn get_global_stats() -> Result<StatsCache, String> {
    let path = get_stats_cache_path().ok_or("Could not find stats cache path")?;

    if !path.exists() {
        return Ok(StatsCache {
            version: None,
            last_computed_date: None,
            daily_activity: Vec::new(),
            daily_model_tokens: Vec::new(),
        });
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read stats cache: {}", e))?;

    let stats: StatsCache =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse stats cache: {}", e))?;

    Ok(stats)
}

#[tauri::command]
pub fn get_token_summary() -> Result<TokenUsageSummary, String> {
    let stats = get_global_stats()?;

    let mut total_tokens: u64 = 0;
    let mut tokens_by_model: HashMap<String, u64> = HashMap::new();
    let mut daily_tokens: Vec<DailyTokenEntry> = Vec::new();

    for day in &stats.daily_model_tokens {
        let mut day_total: u64 = 0;
        for (model, tokens) in &day.tokens_by_model {
            total_tokens += tokens;
            day_total += tokens;
            *tokens_by_model.entry(model.clone()).or_insert(0) += tokens;
        }
        daily_tokens.push(DailyTokenEntry {
            date: day.date.clone(),
            tokens: day_total,
        });
    }

    Ok(TokenUsageSummary {
        total_tokens,
        tokens_by_model,
        daily_tokens,
    })
}
