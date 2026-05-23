use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::fs;
use std::sync::OnceLock;
use std::time::{Duration, Instant, UNIX_EPOCH};

use parking_lot::Mutex;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::models::pricing;
use crate::models::stats::{
    DailyTokenEntry, ProjectCostEntry, RequestLogPage, RequestRecord, SessionCostSummary,
    TokenUsageSummary,
};
use crate::parser::path_encoder::{decode_project_path_validated, get_projects_dir};
use crate::provider::codex;

// ── Public entry point ──────────────────────────────────────────────────────

pub fn get_stats(source: &str) -> Result<TokenUsageSummary, String> {
    match source {
        "claude" => get_claude_stats(),
        "codex" => codex::get_stats(),
        _ => Err(format!("Unknown source: {}", source)),
    }
}

/// Filter parameters for the paginated request log.
#[derive(Debug, Default, Clone)]
pub struct RequestLogFilter {
    pub source: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    /// Inclusive YYYY-MM-DD lower bound (UTC).
    pub start_date: Option<String>,
    /// Inclusive YYYY-MM-DD upper bound (UTC).
    pub end_date: Option<String>,
    pub model: Option<String>,
}

pub fn get_request_log(
    filter: RequestLogFilter,
    page: usize,
    page_size: usize,
) -> Result<RequestLogPage, String> {
    // Codex still goes through the legacy path — its cache layout is
    // session-shaped, not record-shaped, and the volume is tiny.
    if filter.source == "codex" {
        let records = codex::collect_requests()?;
        return Ok(paginate_records(records, &filter, page, page_size));
    }
    if filter.source != "claude" {
        return Err(format!("Unknown source: {}", filter.source));
    }

    ensure_claude_cache_fresh()?;
    with_claude_cache(|cache| {
        // First pass: count + accumulate totals over the filtered set, so we
        // can return accurate aggregates without materialising the full list.
        let mut matched_count = 0usize;
        let mut total_cost = 0.0_f64;
        let mut total_input = 0u64;
        let mut total_output = 0u64;
        let mut total_cache_read = 0u64;
        let mut total_cache_creation = 0u64;
        // Collect indexes referencing live records to avoid clones until
        // we know which slice the caller wants.
        let mut hits: Vec<(&str, &CompactRecord, &FileStat)> = Vec::new();

        for (file_key, fs) in cache.files.iter() {
            if let Some(pid) = filter.project_id.as_deref() {
                if fs.project_id != pid {
                    continue;
                }
            }
            for rec in &fs.requests {
                if let Some(sid) = filter.session_id.as_deref() {
                    if rec.s.as_deref().unwrap_or("") != sid {
                        continue;
                    }
                }
                if let Some(start) = filter.start_date.as_deref() {
                    if rec.t.as_str() < start {
                        continue;
                    }
                }
                if let Some(end) = filter.end_date.as_deref() {
                    let date_prefix = rec.t.get(..10).unwrap_or(rec.t.as_str());
                    if date_prefix > end {
                        continue;
                    }
                }
                if let Some(model) = filter.model.as_deref() {
                    if rec.m != model {
                        continue;
                    }
                }
                matched_count += 1;
                total_cost += rec.c;
                total_input += rec.i;
                total_output += rec.o;
                total_cache_read += rec.cr;
                total_cache_creation += rec.cw;
                hits.push((file_key.as_str(), rec, fs));
            }
        }

        // Sort newest-first by timestamp.
        hits.sort_by(|a, b| b.1.t.cmp(&a.1.t));

        let start = page.saturating_mul(page_size);
        let end = start.saturating_add(page_size).min(hits.len());
        let records: Vec<RequestRecord> = if start >= hits.len() {
            Vec::new()
        } else {
            hits[start..end]
                .iter()
                .map(|(key, rec, fs)| compact_to_record(key, rec, fs, "claude"))
                .collect()
        };

        Ok(RequestLogPage {
            records,
            total: matched_count,
            page,
            page_size,
            has_more: end < matched_count,
            total_cost_usd: total_cost,
            total_input_tokens: total_input,
            total_output_tokens: total_output,
            total_cache_read_tokens: total_cache_read,
            total_cache_creation_tokens: total_cache_creation,
        })
    })
}

/// Codex still returns the full record list — pagination/sort happens here.
fn paginate_records(
    mut records: Vec<RequestRecord>,
    filter: &RequestLogFilter,
    page: usize,
    page_size: usize,
) -> RequestLogPage {
    records.retain(|r| {
        if let Some(pid) = filter.project_id.as_deref() {
            if r.project_id != pid {
                return false;
            }
        }
        if let Some(sid) = filter.session_id.as_deref() {
            if r.session_id != sid {
                return false;
            }
        }
        if let Some(start) = filter.start_date.as_deref() {
            if r.timestamp.as_str() < start {
                return false;
            }
        }
        if let Some(end) = filter.end_date.as_deref() {
            let date_prefix = r.timestamp.get(..10).unwrap_or(r.timestamp.as_str());
            if date_prefix > end {
                return false;
            }
        }
        if let Some(model) = filter.model.as_deref() {
            if r.model != model {
                return false;
            }
        }
        true
    });
    records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    let total = records.len();
    let total_cost: f64 = records.iter().map(|r| r.cost_usd).sum();
    let total_input: u64 = records.iter().map(|r| r.input_tokens).sum();
    let total_output: u64 = records.iter().map(|r| r.output_tokens).sum();
    let total_cache_read: u64 = records.iter().map(|r| r.cache_read_tokens).sum();
    let total_cache_creation: u64 = records.iter().map(|r| r.cache_creation_tokens).sum();

    let start = page.saturating_mul(page_size);
    let end = start.saturating_add(page_size).min(total);
    let records = if start >= total {
        Vec::new()
    } else {
        records[start..end].to_vec()
    };

    RequestLogPage {
        records,
        total,
        page,
        page_size,
        has_more: end < total,
        total_cost_usd: total_cost,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read_tokens: total_cache_read,
        total_cache_creation_tokens: total_cache_creation,
    }
}

pub fn get_project_costs(source: &str) -> Result<Vec<ProjectCostEntry>, String> {
    if source == "codex" {
        return codex_project_costs();
    }
    if source != "claude" {
        return Err(format!("Unknown source: {}", source));
    }

    ensure_claude_cache_fresh()?;
    with_claude_cache(|cache| {
        let mut by_project: HashMap<String, ProjectCostEntry> = HashMap::new();
        for fs in cache.files.values() {
            let entry = by_project
                .entry(fs.project_id.clone())
                .or_insert_with(|| ProjectCostEntry {
                    source: "claude".to_string(),
                    project_id: fs.project_id.clone(),
                    display_name: project_display_name("claude", &fs.project_id),
                    request_count: 0,
                    total_tokens: 0,
                    cache_read_tokens: 0,
                    cost_usd: 0.0,
                });
            entry.request_count += fs.message_count;
            entry.total_tokens +=
                fs.input_tokens + fs.output_tokens + fs.cache_read_tokens + fs.cache_creation_tokens;
            entry.cache_read_tokens += fs.cache_read_tokens;
            entry.cost_usd += fs.cost_usd;
        }
        let mut list: Vec<ProjectCostEntry> = by_project.into_values().collect();
        list.sort_by(|a, b| {
            b.cost_usd
                .partial_cmp(&a.cost_usd)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(list)
    })
}

fn codex_project_costs() -> Result<Vec<ProjectCostEntry>, String> {
    let records = codex::collect_requests()?;
    let mut by_project: HashMap<String, ProjectCostEntry> = HashMap::new();
    for r in records {
        let entry = by_project
            .entry(r.project_id.clone())
            .or_insert_with(|| ProjectCostEntry {
                source: "codex".to_string(),
                project_id: r.project_id.clone(),
                display_name: project_display_name("codex", &r.project_id),
                request_count: 0,
                total_tokens: 0,
                cache_read_tokens: 0,
                cost_usd: 0.0,
            });
        entry.request_count += 1;
        entry.total_tokens += r.total_tokens;
        entry.cache_read_tokens += r.cache_read_tokens;
        entry.cost_usd += r.cost_usd;
    }
    let mut list: Vec<ProjectCostEntry> = by_project.into_values().collect();
    list.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(list)
}

pub fn get_session_cost(source: &str, file_path: &str) -> Result<SessionCostSummary, String> {
    if source == "codex" {
        let records = codex::collect_requests()?;
        return Ok(build_session_summary_from_records(source, file_path, records));
    }
    if source != "claude" {
        return Err(format!("Unknown source: {}", source));
    }

    ensure_claude_cache_fresh()?;
    with_claude_cache(|cache| {
        let Some(fs_entry) = cache.files.get(file_path) else {
            return Ok(empty_session_summary(source, file_path));
        };
        let mut records: Vec<RequestRecord> = fs_entry
            .requests
            .iter()
            .map(|rec| compact_to_record(file_path, rec, fs_entry, "claude"))
            .collect();
        records.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        Ok(materialise_session_summary(source, file_path, records))
    })
}

fn build_session_summary_from_records(
    source: &str,
    file_path: &str,
    records: Vec<RequestRecord>,
) -> SessionCostSummary {
    let matched: Vec<RequestRecord> = records
        .into_iter()
        .filter(|r| r.file_path == file_path)
        .collect();
    materialise_session_summary(source, file_path, matched)
}

fn materialise_session_summary(
    source: &str,
    file_path: &str,
    mut matched: Vec<RequestRecord>,
) -> SessionCostSummary {
    matched.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    let session_id = matched
        .first()
        .map(|r| r.session_id.clone())
        .unwrap_or_else(|| {
            Path::new(file_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        });

    let input: u64 = matched.iter().map(|r| r.input_tokens).sum();
    let output: u64 = matched.iter().map(|r| r.output_tokens).sum();
    let cache_read: u64 = matched.iter().map(|r| r.cache_read_tokens).sum();
    let cache_creation: u64 = matched.iter().map(|r| r.cache_creation_tokens).sum();
    let total: u64 = matched.iter().map(|r| r.total_tokens).sum();
    let cost: f64 = matched.iter().map(|r| r.cost_usd).sum();
    let count = matched.len() as u64;
    let avg = if count == 0 { None } else { Some(cost / count as f64) };

    SessionCostSummary {
        source: source.to_string(),
        session_id,
        file_path: file_path.to_string(),
        request_count: count,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_creation,
        total_tokens: total,
        cost_usd: cost,
        avg_cost_usd: avg,
        requests: matched,
    }
}

fn empty_session_summary(source: &str, file_path: &str) -> SessionCostSummary {
    SessionCostSummary {
        source: source.to_string(),
        session_id: String::new(),
        file_path: file_path.to_string(),
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_tokens: 0,
        cost_usd: 0.0,
        avg_cost_usd: None,
        requests: Vec::new(),
    }
}

/// Project display name resolution. For Claude the project id is the encoded
/// directory name and `decode_project_path_validated` already returns a nice
/// short name. For Codex the project id is the cwd path, so we just take the
/// last segment.
fn project_display_name(source: &str, project_id: &str) -> String {
    match source {
        "claude" => decode_project_path_validated(project_id).display_path,
        _ => Path::new(project_id)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(project_id)
            .to_string(),
    }
}

// ── Minimal parse structs (only fields needed for stats) ────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsRecord {
    #[serde(rename = "type")]
    record_type: String,
    uuid: Option<String>,
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

#[derive(Deserialize, Default, Clone, Copy)]
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

/// CACHE_VERSION 4 (v2.14.x):
///   - `FileStat.requests` now uses `CompactRecord` with short field names
///     and no project/file/source redundancy (those are inferred from the
///     enclosing FileStat / cache key).
///   - This drops the on-disk JSON size by roughly 2× on a representative
///     cache; the IO win then compounds with the singleflight + in-memory
///     guards added below.
///
/// Old v3 caches are dropped on first load (the user takes the rescan hit
/// once, then enjoys the smaller faster cache forever).
const CACHE_VERSION: u32 = 4;

#[derive(Serialize, Deserialize, Default, Clone)]
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
    /// Encoded project directory name (the parent dir under
    /// `~/.claude/projects/`). Used by the "项目花费排行" view to group
    /// requests without rescanning.
    #[serde(default)]
    project_id: String,
    input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_creation_tokens: u64,
    #[serde(default)]
    cost_usd: f64,
    /// model → total tokens
    #[serde(default)]
    tokens_by_model: HashMap<String, u64>,
    /// model → cost USD
    #[serde(default)]
    cost_by_model: HashMap<String, f64>,
    /// date (YYYY-MM-DD) → DailyBuckets
    #[serde(default)]
    daily: HashMap<String, DailyBuckets>,
    #[serde(default)]
    session_ids: Vec<String>,
    message_count: u64,
    /// Each assistant message with token usage. Kept in chronological order.
    /// `CompactRecord` drops fields the FileStat already encodes (source /
    /// file_path / project_id) plus uses one-letter aliases, shaving roughly
    /// half the on-disk JSON.
    #[serde(default)]
    requests: Vec<CompactRecord>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CompactRecord {
    /// timestamp (RFC3339)
    t: String,
    /// model name
    m: String,
    /// input_tokens
    i: u64,
    /// output_tokens
    o: u64,
    /// cache_read_tokens
    #[serde(default)]
    cr: u64,
    /// cache_creation_tokens
    #[serde(default)]
    cw: u64,
    /// cost_usd
    #[serde(default)]
    c: f64,
    /// duration_ms (user→assistant turnaround)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    d: Option<u64>,
    /// session_id — kept because a JSONL can contain multiple sub-sessions
    /// (e.g. after `--resume`); we can't infer it from the file alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    s: Option<String>,
    /// assistant message uuid (for deep linking)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    u: Option<String>,
}

fn compact_to_record(
    file_key: &str,
    rec: &CompactRecord,
    fs_entry: &FileStat,
    source: &str,
) -> RequestRecord {
    let total =
        rec.i + rec.o + rec.cr + rec.cw;
    RequestRecord {
        timestamp: rec.t.clone(),
        source: source.to_string(),
        project_id: fs_entry.project_id.clone(),
        session_id: rec.s.clone().unwrap_or_default(),
        file_path: file_key.to_string(),
        model: rec.m.clone(),
        input_tokens: rec.i,
        output_tokens: rec.o,
        cache_read_tokens: rec.cr,
        cache_creation_tokens: rec.cw,
        total_tokens: total,
        cost_usd: rec.c,
        duration_ms: rec.d,
        message_uuid: rec.u.clone(),
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct DailyBuckets {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    cost: f64,
    messages: u64,
    /// model → (cache_read, total_input_side)
    /// Used to compute per-model cache hit ratio on this day without storing
    /// the full per-message split.
    #[serde(default)]
    per_model_cache_ratio_num: HashMap<String, u64>,
    #[serde(default)]
    per_model_cache_ratio_den: HashMap<String, u64>,
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

fn load_cache_from_disk() -> AsvStatsCache {
    let Some(path) = cache_path() else {
        return AsvStatsCache::default();
    };
    let Ok(file) = fs::File::open(&path) else {
        return AsvStatsCache::default();
    };
    // `from_reader` over a `BufReader` lets serde_json parse incrementally
    // instead of allocating one massive String for a 50MB+ cache file.
    let reader = BufReader::with_capacity(256 * 1024, file);
    let cache: AsvStatsCache = match serde_json::from_reader(reader) {
        Ok(c) => c,
        Err(_) => return AsvStatsCache::default(),
    };
    if cache.version != CACHE_VERSION {
        return AsvStatsCache::default();
    }
    cache
}

fn write_cache_to_disk(cache: &AsvStatsCache) {
    let Some(path) = cache_path() else { return };
    let tmp_path = path.with_extension("json.tmp");
    let Ok(file) = fs::File::create(&tmp_path) else {
        return;
    };
    {
        let mut writer = BufWriter::with_capacity(256 * 1024, file);
        if serde_json::to_writer(&mut writer, cache).is_err() {
            return;
        }
        use std::io::Write;
        if writer.flush().is_err() {
            return;
        }
    }
    // Atomic-ish replace: rename usually succeeds on the same volume even
    // if a previous reader still has the old inode open.
    let _ = fs::rename(&tmp_path, &path);
}

fn file_mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0)
}

// ── In-memory cache + singleflight ──────────────────────────────────────────

/// How long after a successful refresh we consider the cache "fresh" and
/// skip the mtime walk + parallel rescan entirely. The Stats page issues
/// `getStats` and `getProjectCosts` back-to-back; this throttle collapses
/// them to a single disk pass.
const REFRESH_THROTTLE: Duration = Duration::from_millis(750);

struct CacheState {
    cache: AsvStatsCache,
    /// `None` until the first successful refresh has populated `cache`.
    last_refresh: Option<Instant>,
    /// Set when we've mutated `cache` in memory but not yet flushed to disk.
    dirty: bool,
    /// First time we discovered no cache file on disk — used to surface the
    /// `is_first_build` hint to the UI on the very first scan.
    is_first_build: bool,
    /// True when no disk cache existed at process startup.
    pristine: bool,
}

fn cache_state() -> &'static Mutex<CacheState> {
    static CELL: OnceLock<Mutex<CacheState>> = OnceLock::new();
    CELL.get_or_init(|| {
        let pristine = cache_path()
            .map(|p| !p.exists())
            .unwrap_or(true);
        Mutex::new(CacheState {
            cache: load_cache_from_disk(),
            last_refresh: None,
            dirty: false,
            is_first_build: pristine,
            pristine,
        })
    })
}

/// Make sure the in-memory cache reflects the current state of disk JSONL
/// files. Within `REFRESH_THROTTLE` of the last refresh this is a no-op.
///
/// Concurrency: callers serialise on `cache_state()`. The lock is held for
/// the full mtime walk + par_iter scan — this is intentional, because the
/// alternative ("release, scan, reacquire") leads to two callers arriving
/// in parallel each doing the same scan. Holding the lock means the second
/// caller waits, then sees a fresh throttle and exits in microseconds.
fn ensure_claude_cache_fresh() -> Result<(), String> {
    let projects_dir = match get_projects_dir() {
        Some(d) => d,
        None => return Err("Could not find projects dir".to_string()),
    };
    if !projects_dir.exists() {
        // Reset cache to empty rather than confuse the user with stale
        // numbers from a previous projects dir.
        let mut guard = cache_state().lock();
        guard.cache = AsvStatsCache::default();
        guard.cache.version = CACHE_VERSION;
        guard.last_refresh = Some(Instant::now());
        return Ok(());
    }

    let mut guard = cache_state().lock();

    // Throttle fast path. The cache file is up to date and we just confirmed
    // it within REFRESH_THROTTLE — skip the IO entirely.
    if let Some(ts) = guard.last_refresh {
        if ts.elapsed() < REFRESH_THROTTLE {
            return Ok(());
        }
    }

    let all_paths = collect_jsonl_paths(&projects_dir);

    // Build the mtime diff inside the locked region.
    let stale: Vec<PathBuf> = all_paths
        .iter()
        .filter(|p| {
            let key = p.to_string_lossy();
            let mtime = file_mtime(p);
            match guard.cache.files.get(key.as_ref()) {
                Some(entry) => entry.mtime != mtime,
                None => true,
            }
        })
        .cloned()
        .collect();

    let mut any_change = false;

    if !stale.is_empty() {
        // par_iter is heavy but doesn't touch `guard.cache`; rayon worker
        // threads operate on the `stale` Vec only.
        let new_stats: Vec<(String, FileStat)> = stale
            .par_iter()
            .filter_map(|path| {
                let stat = scan_file(path)?;
                Some((path.to_string_lossy().into_owned(), stat))
            })
            .collect();

        for (key, stat) in new_stats {
            guard.cache.files.insert(key, stat);
            any_change = true;
        }
    }

    // Drop entries for files that no longer exist on disk.
    let existing_keys: HashSet<String> = all_paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let before = guard.cache.files.len();
    guard.cache.files.retain(|k, _| existing_keys.contains(k));
    if guard.cache.files.len() != before {
        any_change = true;
    }

    if any_change || guard.cache.version != CACHE_VERSION {
        guard.cache.version = CACHE_VERSION;
        guard.dirty = true;
    }
    guard.last_refresh = Some(Instant::now());

    if guard.dirty {
        // Snapshot + spawn a writer so the RPC response doesn't wait on
        // disk. The clone is the cheapest available option here — bincode
        // would avoid it but at the cost of a new dependency.
        let snapshot = guard.cache.clone();
        guard.dirty = false;
        std::thread::spawn(move || {
            write_cache_to_disk(&snapshot);
        });
    }

    Ok(())
}

fn with_claude_cache<T>(f: impl FnOnce(&AsvStatsCache) -> T) -> T {
    let guard = cache_state().lock();
    f(&guard.cache)
}

fn get_claude_stats() -> Result<TokenUsageSummary, String> {
    ensure_claude_cache_fresh()?;
    let mut guard = cache_state().lock();
    let summary = merge_into_summary(&guard.cache);
    // `is_first_build` is true exactly once, on the response that finishes
    // the very first scan. Subsequent calls report false.
    let was_first_build = guard.is_first_build && guard.pristine;
    guard.is_first_build = false;
    let mut summary = summary;
    summary.is_first_build = was_first_build;
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
    let reader = BufReader::with_capacity(64 * 1024, file);

    // Encoded project directory is the parent dir name.
    let project_id = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let mut stat = FileStat {
        mtime,
        project_id,
        ..Default::default()
    };
    let mut session_set: HashSet<String> = HashSet::new();
    // Track the most recent user-side timestamp so we can attribute a
    // `duration_ms` to each assistant request.
    let mut last_user_ts: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Double pre-filter: cheap substring tests gate the expensive
        // `serde_json::from_str` call. We only need user rows (for
        // `duration_ms`) and assistant rows that carry a usage block.
        let is_user = trimmed.contains("\"type\":\"user\"");
        let is_assistant_with_usage =
            trimmed.contains("\"type\":\"assistant\"") && trimmed.contains("\"usage\"");
        if !is_user && !is_assistant_with_usage {
            continue;
        }

        let record: StatsRecord = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(_) => continue,
        };

        if record.record_type == "user" {
            if let Some(ts) = record.timestamp.as_ref() {
                last_user_ts = Some(ts.clone());
            }
            continue;
        }

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
            Some(u) => *u,
            None => continue,
        };

        stat.message_count += 1;

        if let Some(sid) = &record.session_id {
            session_set.insert(sid.clone());
        }

        let model = msg.model.clone().unwrap_or_else(|| "unknown".to_string());
        let timestamp = record.timestamp.clone().unwrap_or_default();
        let duration_ms = compute_duration_ms(last_user_ts.as_deref(), Some(timestamp.as_str()));

        let cost = pricing::compute_cost(
            &model,
            usage.input_tokens,
            usage.cache_creation_input_tokens,
            usage.cache_read_input_tokens,
            usage.output_tokens,
        );

        // Aggregate totals
        stat.input_tokens += usage.input_tokens;
        stat.output_tokens += usage.output_tokens;
        stat.cache_read_tokens += usage.cache_read_input_tokens;
        stat.cache_creation_tokens += usage.cache_creation_input_tokens;
        stat.cost_usd += cost;

        let total_for_record = usage.input_tokens
            + usage.output_tokens
            + usage.cache_read_input_tokens
            + usage.cache_creation_input_tokens;

        *stat.tokens_by_model.entry(model.clone()).or_insert(0) += total_for_record;
        *stat.cost_by_model.entry(model.clone()).or_insert(0.0) += cost;

        if let Some(date) = timestamp.get(..10) {
            let buckets = stat.daily.entry(date.to_string()).or_default();
            buckets.input += usage.input_tokens;
            buckets.output += usage.output_tokens;
            buckets.cache_read += usage.cache_read_input_tokens;
            buckets.cache_creation += usage.cache_creation_input_tokens;
            buckets.cost += cost;
            buckets.messages += 1;
            let input_side =
                usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
            *buckets.per_model_cache_ratio_num.entry(model.clone()).or_insert(0) +=
                usage.cache_read_input_tokens;
            *buckets.per_model_cache_ratio_den.entry(model.clone()).or_insert(0) += input_side;
        }

        // Per-request record for the 逐请求账单 view (compact form).
        let session_id = record.session_id.clone().filter(|s| !s.is_empty());
        stat.requests.push(CompactRecord {
            t: timestamp,
            m: model,
            i: usage.input_tokens,
            o: usage.output_tokens,
            cr: usage.cache_read_input_tokens,
            cw: usage.cache_creation_input_tokens,
            c: cost,
            d: duration_ms,
            s: session_id,
            u: record.uuid.clone(),
        });
    }

    stat.session_ids = session_set.into_iter().collect();
    Some(stat)
}

/// Parse two RFC3339 timestamps and return the millisecond delta, or None
/// when either is missing/malformed. Used to attribute `duration_ms` to
/// assistant responses.
pub(crate) fn compute_duration_ms(start: Option<&str>, end: Option<&str>) -> Option<u64> {
    use chrono::DateTime;
    let s = DateTime::parse_from_rfc3339(start?).ok()?;
    let e = DateTime::parse_from_rfc3339(end?).ok()?;
    let delta = e.timestamp_millis() - s.timestamp_millis();
    if delta < 0 {
        None
    } else {
        Some(delta as u64)
    }
}

/// Merge all per-file stats in the cache into a single TokenUsageSummary.
fn merge_into_summary(cache: &AsvStatsCache) -> TokenUsageSummary {
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut total_cache_creation: u64 = 0;
    let mut total_cost: f64 = 0.0;
    let mut tokens_by_model: HashMap<String, u64> = HashMap::new();
    let mut cost_by_model: HashMap<String, f64> = HashMap::new();
    let mut daily_map: HashMap<String, DailyBuckets> = HashMap::new();
    let mut all_session_ids: HashSet<String> = HashSet::new();
    let mut message_count: u64 = 0;

    for stat in cache.files.values() {
        total_input += stat.input_tokens;
        total_output += stat.output_tokens;
        total_cache_read += stat.cache_read_tokens;
        total_cache_creation += stat.cache_creation_tokens;
        total_cost += stat.cost_usd;
        message_count += stat.message_count;

        for sid in &stat.session_ids {
            all_session_ids.insert(sid.clone());
        }
        for (model, tokens) in &stat.tokens_by_model {
            *tokens_by_model.entry(model.clone()).or_insert(0) += tokens;
        }
        for (model, cost) in &stat.cost_by_model {
            *cost_by_model.entry(model.clone()).or_insert(0.0) += cost;
        }
        for (date, bucket) in &stat.daily {
            let merged = daily_map.entry(date.clone()).or_default();
            merged.input += bucket.input;
            merged.output += bucket.output;
            merged.cache_read += bucket.cache_read;
            merged.cache_creation += bucket.cache_creation;
            merged.cost += bucket.cost;
            merged.messages += bucket.messages;
            for (model, n) in &bucket.per_model_cache_ratio_num {
                *merged
                    .per_model_cache_ratio_num
                    .entry(model.clone())
                    .or_insert(0) += n;
            }
            for (model, d) in &bucket.per_model_cache_ratio_den {
                *merged
                    .per_model_cache_ratio_den
                    .entry(model.clone())
                    .or_insert(0) += d;
            }
        }
    }

    let mut dates: Vec<String> = daily_map.keys().cloned().collect();
    dates.sort();

    let daily_tokens = dates
        .iter()
        .map(|date| {
            let bucket = daily_map.get(date).cloned().unwrap_or_default();
            let total = bucket.input + bucket.output + bucket.cache_read + bucket.cache_creation;
            let mut ratio_by_model: HashMap<String, f64> = HashMap::new();
            for (model, num) in &bucket.per_model_cache_ratio_num {
                let den = bucket.per_model_cache_ratio_den.get(model).copied().unwrap_or(0);
                if den > 0 {
                    ratio_by_model.insert(model.clone(), *num as f64 / den as f64);
                }
            }
            DailyTokenEntry {
                date: date.clone(),
                input_tokens: bucket.input,
                output_tokens: bucket.output,
                cache_read_tokens: bucket.cache_read,
                cache_creation_tokens: bucket.cache_creation,
                total_tokens: total,
                cost_usd: bucket.cost,
                message_count: bucket.messages,
                cache_hit_ratio_by_model: ratio_by_model,
            }
        })
        .collect();

    TokenUsageSummary {
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_cache_read_tokens: total_cache_read,
        total_cache_creation_tokens: total_cache_creation,
        total_tokens: total_input + total_output + total_cache_read + total_cache_creation,
        total_cost_usd: total_cost,
        tokens_by_model,
        cost_by_model,
        daily_tokens,
        session_count: all_session_ids.len() as u64,
        message_count,
        is_first_build: false, // caller overrides if needed
    }
}

pub(crate) fn empty_summary() -> TokenUsageSummary {
    TokenUsageSummary {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        tokens_by_model: HashMap::new(),
        cost_by_model: HashMap::new(),
        daily_tokens: Vec::new(),
        session_count: 0,
        message_count: 0,
        is_first_build: false,
    }
}
