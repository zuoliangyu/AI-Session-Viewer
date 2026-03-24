use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::fs;

use serde::Deserialize;

use crate::models::stats::{DailyTokenEntry, TokenUsageSummary};
use crate::parser::path_encoder::get_projects_dir;
use crate::provider::codex;

pub fn get_stats(source: &str) -> Result<TokenUsageSummary, String> {
    match source {
        "claude" => get_claude_stats(),
        "codex" => codex::get_stats(),
        _ => Err(format!("Unknown source: {}", source)),
    }
}

// ── Minimal structs for stats scanning (only fields we need) ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsRecord {
    #[serde(rename = "type")]
    record_type: String,
    timestamp: Option<String>,
    session_id: Option<String>,
    message: Option<StatsMessage>,
}

#[derive(Deserialize)]
struct StatsMessage {
    role: Option<String>,
    model: Option<String>,
    usage: Option<UsageData>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct UsageData {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

fn get_claude_stats() -> Result<TokenUsageSummary, String> {
    let projects_dir = get_projects_dir().ok_or("Could not find projects dir")?;

    if !projects_dir.exists() {
        return Ok(empty_summary());
    }

    // daily: date -> (input, output)
    let mut daily_input: HashMap<String, u64> = HashMap::new();
    let mut daily_output: HashMap<String, u64> = HashMap::new();
    let mut daily_model: HashMap<String, HashMap<String, u64>> = HashMap::new();
    let mut tokens_by_model: HashMap<String, u64> = HashMap::new();
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut session_ids: HashSet<String> = HashSet::new();
    let mut message_count: u64 = 0;

    let project_dirs = fs::read_dir(&projects_dir)
        .map_err(|e| format!("Failed to read projects dir: {}", e))?;

    for project_entry in project_dirs.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }

        let jsonl_files = match fs::read_dir(&project_path) {
            Ok(d) => d,
            Err(_) => continue,
        };

        for file_entry in jsonl_files.flatten() {
            let path = file_entry.path();
            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                scan_jsonl(
                    &path,
                    &mut daily_input,
                    &mut daily_output,
                    &mut daily_model,
                    &mut tokens_by_model,
                    &mut total_input,
                    &mut total_output,
                    &mut session_ids,
                    &mut message_count,
                );
            }
        }
    }

    // Build sorted daily token list
    let mut all_dates: HashSet<String> = HashSet::new();
    all_dates.extend(daily_input.keys().cloned());
    all_dates.extend(daily_output.keys().cloned());
    let mut dates: Vec<String> = all_dates.into_iter().collect();
    dates.sort();

    let daily_tokens: Vec<DailyTokenEntry> = dates
        .iter()
        .map(|date| {
            let input = *daily_input.get(date).unwrap_or(&0);
            let output = *daily_output.get(date).unwrap_or(&0);
            DailyTokenEntry {
                date: date.clone(),
                input_tokens: input,
                output_tokens: output,
                total_tokens: input + output,
            }
        })
        .collect();

    Ok(TokenUsageSummary {
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_tokens: total_input + total_output,
        tokens_by_model,
        daily_tokens,
        session_count: session_ids.len() as u64,
        message_count,
    })
}

#[allow(clippy::too_many_arguments)]
fn scan_jsonl(
    path: &std::path::Path,
    daily_input: &mut HashMap<String, u64>,
    daily_output: &mut HashMap<String, u64>,
    daily_model: &mut HashMap<String, HashMap<String, u64>>,
    tokens_by_model: &mut HashMap<String, u64>,
    total_input: &mut u64,
    total_output: &mut u64,
    session_ids: &mut HashSet<String>,
    message_count: &mut u64,
) {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let record: StatsRecord = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(_) => continue,
        };

        if record.record_type != "assistant" {
            continue;
        }

        let msg = match &record.message {
            Some(m) => m,
            None => continue,
        };

        if msg.role.as_deref() != Some("assistant") {
            continue;
        }

        let usage = match &msg.usage {
            Some(u) => u,
            None => continue,
        };

        // Count this as a message
        *message_count += 1;

        // Track session
        if let Some(sid) = &record.session_id {
            session_ids.insert(sid.clone());
        }

        // Token accounting: input = input_tokens + cache_read + cache_creation
        let input = usage.input_tokens
            + usage.cache_read_input_tokens
            + usage.cache_creation_input_tokens;
        let output = usage.output_tokens;

        *total_input += input;
        *total_output += output;

        // Per-model
        if let Some(model) = &msg.model {
            let total_for_msg = input + output;
            *tokens_by_model.entry(model.clone()).or_insert(0) += total_for_msg;

            if let Some(date) = record.timestamp.as_deref().and_then(|ts| ts.get(..10)) {
                daily_model
                    .entry(date.to_string())
                    .or_default()
                    .entry(model.clone())
                    .and_modify(|v| *v += total_for_msg)
                    .or_insert(total_for_msg);
            }
        }

        // Per-day
        if let Some(date) = record.timestamp.as_deref().and_then(|ts| ts.get(..10)) {
            *daily_input.entry(date.to_string()).or_insert(0) += input;
            *daily_output.entry(date.to_string()).or_insert(0) += output;
        }
    }
}

fn empty_summary() -> TokenUsageSummary {
    TokenUsageSummary {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
        tokens_by_model: HashMap::new(),
        daily_tokens: Vec::new(),
        session_count: 0,
        message_count: 0,
    }
}
