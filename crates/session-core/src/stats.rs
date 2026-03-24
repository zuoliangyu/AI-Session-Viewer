use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::fs;
use std::time::UNIX_EPOCH;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::models::stats::{DailyTokenEntry, TokenUsageSummary};
use crate::parser::path_encoder::get_projects_dir;
use crate::provider::codex;

// ── Public entry point ──────────────────────────────────────────────────────

pub fn get_stats(source: &str) -> Result<TokenUsageSummary, String> {
    match source {
        "claude" => get_claude_stats(),
        "codex" => codex::get_stats(),
        _ => Err(format!("Unknown source: {}", source)),
    }
}

// ── Minimal parse structs (only fields needed for stats) ────────────────────

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

// ── Per-file cache ───────────────────────────────────────────────────────────

const CACHE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Default)]
struct AsvStatsCache {
    version: u32,
    #[serde(default)]
    files: HashMap<String, FileStat>,
}

/// Stats aggregated for a single JSONL file.
#[derive(Serialize, Deserialize, Clone, Default)]
struct FileStat {
    /// File mtime (seconds since UNIX epoch) at scan time.
    mtime: u64,
    input_tokens: u64,
    output_tokens: u64,
    /// model → total tokens
    tokens_by_model: HashMap<String, u64>,
    /// date (YYYY-MM-DD) → input tokens
    daily_input: HashMap<String, u64>,
    /// date (YYYY-MM-DD) → output tokens
    daily_output: HashMap<String, u64>,
    session_ids: Vec<String>,
    message_count: u64,
}

fn cache_path() -> Option<PathBuf> {
    // Store in the OS config dir for this app, not in ~/.claude
    // Windows:  %APPDATA%\ai-session-viewer\stats-cache.json
    // macOS:    ~/Library/Application Support/ai-session-viewer/stats-cache.json
    // Linux:    ~/.config/ai-session-viewer/stats-cache.json
    let dir = dirs::config_dir()?.join("ai-session-viewer");
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("stats-cache.json"))
}

fn load_cache() -> AsvStatsCache {
    let path = match cache_path() {
        Some(p) => p,
        None => return AsvStatsCache::default(),
    };
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return AsvStatsCache::default(),
    };
    let cache: AsvStatsCache = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(_) => return AsvStatsCache::default(),
    };
    if cache.version != CACHE_VERSION {
        return AsvStatsCache::default();
    }
    cache
}

fn save_cache(cache: &AsvStatsCache) {
    if let Some(path) = cache_path() {
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = fs::write(path, json);
        }
    }
}

fn file_mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .and_then(|t| Ok(t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()))
        .unwrap_or(0)
}

// ── Core stats computation ───────────────────────────────────────────────────

fn get_claude_stats() -> Result<TokenUsageSummary, String> {
    let projects_dir = get_projects_dir().ok_or("Could not find projects dir")?;
    if !projects_dir.exists() {
        return Ok(empty_summary());
    }

    // 1. Collect all JSONL file paths
    let all_paths = collect_jsonl_paths(&projects_dir);
    if all_paths.is_empty() {
        return Ok(empty_summary());
    }

    // 2. Load existing per-file cache; detect first-time build
    let cache_exists = cache_path().map(|p| p.exists()).unwrap_or(false);
    let is_first_build = !cache_exists;
    let mut cache = load_cache();

    // 3. Determine which files need re-scanning
    let stale: Vec<&PathBuf> = all_paths
        .iter()
        .filter(|p| {
            let key = p.to_string_lossy();
            let mtime = file_mtime(p);
            match cache.files.get(key.as_ref()) {
                Some(entry) => entry.mtime != mtime,
                None => true,
            }
        })
        .collect();

    // 4. Scan stale files in parallel
    let new_stats: Vec<(String, FileStat)> = stale
        .par_iter()
        .filter_map(|path| {
            let stat = scan_file(path)?;
            Some((path.to_string_lossy().into_owned(), stat))
        })
        .collect();

    // 5. Update cache
    for (key, stat) in new_stats {
        cache.files.insert(key, stat);
    }

    // 6. Remove entries for files that no longer exist
    let existing_keys: HashSet<String> = all_paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    cache.files.retain(|k, _| existing_keys.contains(k));

    // 7. Persist updated cache (best-effort)
    cache.version = CACHE_VERSION;
    save_cache(&cache);

    // 8. Merge all cached file stats into summary
    let mut summary = merge_into_summary(&cache);
    summary.is_first_build = is_first_build;
    Ok(summary)
}

/// Collect all *.jsonl paths under the projects directory.
fn collect_jsonl_paths(projects_dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(project_entries) = fs::read_dir(projects_dir) else {
        return paths;
    };
    for project in project_entries.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&project_path) else {
            continue;
        };
        for file in files.flatten() {
            let p = file.path();
            if p.extension().map(|e| e == "jsonl").unwrap_or(false) {
                paths.push(p);
            }
        }
    }
    paths
}

/// Scan a single JSONL file and return its aggregated stats.
/// Returns None only if the file cannot be opened at all.
fn scan_file(path: &Path) -> Option<FileStat> {
    let mtime = file_mtime(path);
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut stat = FileStat {
        mtime,
        ..Default::default()
    };
    let mut session_set: HashSet<String> = HashSet::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Quick pre-filter: skip lines that can't possibly have token usage
        if !trimmed.contains("\"usage\"") {
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

        stat.message_count += 1;

        if let Some(sid) = &record.session_id {
            session_set.insert(sid.clone());
        }

        let input = usage.input_tokens
            + usage.cache_read_input_tokens
            + usage.cache_creation_input_tokens;
        let output = usage.output_tokens;

        stat.input_tokens += input;
        stat.output_tokens += output;

        if let Some(date) = record.timestamp.as_deref().and_then(|ts| ts.get(..10)) {
            *stat.daily_input.entry(date.to_string()).or_insert(0) += input;
            *stat.daily_output.entry(date.to_string()).or_insert(0) += output;

            if let Some(model) = &msg.model {
                *stat
                    .tokens_by_model
                    .entry(model.clone())
                    .or_insert(0) += input + output;
            }
        } else if let Some(model) = &msg.model {
            *stat.tokens_by_model.entry(model.clone()).or_insert(0) += input + output;
        }
    }

    stat.session_ids = session_set.into_iter().collect();
    Some(stat)
}

/// Merge all per-file stats in the cache into a single TokenUsageSummary.
fn merge_into_summary(cache: &AsvStatsCache) -> TokenUsageSummary {
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut tokens_by_model: HashMap<String, u64> = HashMap::new();
    let mut daily_input: HashMap<String, u64> = HashMap::new();
    let mut daily_output: HashMap<String, u64> = HashMap::new();
    let mut all_session_ids: HashSet<String> = HashSet::new();
    let mut message_count: u64 = 0;

    for stat in cache.files.values() {
        total_input += stat.input_tokens;
        total_output += stat.output_tokens;
        message_count += stat.message_count;

        for sid in &stat.session_ids {
            all_session_ids.insert(sid.clone());
        }
        for (model, tokens) in &stat.tokens_by_model {
            *tokens_by_model.entry(model.clone()).or_insert(0) += tokens;
        }
        for (date, tokens) in &stat.daily_input {
            *daily_input.entry(date.clone()).or_insert(0) += tokens;
        }
        for (date, tokens) in &stat.daily_output {
            *daily_output.entry(date.clone()).or_insert(0) += tokens;
        }
    }

    let mut dates: Vec<String> = {
        let mut set = HashSet::new();
        set.extend(daily_input.keys().cloned());
        set.extend(daily_output.keys().cloned());
        set.into_iter().collect()
    };
    dates.sort();

    let daily_tokens = dates
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

    TokenUsageSummary {
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_tokens: total_input + total_output,
        tokens_by_model,
        daily_tokens,
        session_count: all_session_ids.len() as u64,
        message_count,
        is_first_build: false, // caller overrides if needed
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
        is_first_build: false,
    }
}
