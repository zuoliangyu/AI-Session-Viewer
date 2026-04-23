use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use rayon::prelude::*;
use serde_json::Value;

use crate::models::message::{DisplayContentBlock, DisplayMessage, PaginatedMessages};
use crate::models::project::ProjectEntry;
use crate::models::session::SessionIndexEntry;
use crate::models::stats::{DailyTokenEntry, TokenUsageSummary};
use crate::state::{
    clear_message_cache, get_cached_full_messages, get_cached_page, paginate_from_range,
    store_full_messages, store_partial_messages, tail_window_len,
};

const DISK_CACHE_VERSION: u32 = 2;

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CodexDiskCache {
    version: u32,
    #[serde(default)]
    projects: Option<CachedProjects>,
    #[serde(default)]
    sessions_by_project: HashMap<String, CachedSessions>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CachedProjects {
    entries: Vec<ProjectEntry>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CachedSessions {
    entries: Vec<SessionIndexEntry>,
}

fn disk_cache_path() -> Option<PathBuf> {
    let dir = dirs::config_dir()?.join("ai-session-viewer");
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("codex-list-cache.json"))
}

fn read_disk_cache() -> CodexDiskCache {
    let path = match disk_cache_path() {
        Some(path) => path,
        None => return CodexDiskCache::default(),
    };

    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return CodexDiskCache::default(),
    };

    let cache: CodexDiskCache = match serde_json::from_str(&content) {
        Ok(cache) => cache,
        Err(_) => return CodexDiskCache::default(),
    };

    if cache.version != DISK_CACHE_VERSION {
        return CodexDiskCache::default();
    }

    cache
}

fn cache_state() -> &'static Mutex<CodexDiskCache> {
    static CACHE_STATE: OnceLock<Mutex<CodexDiskCache>> = OnceLock::new();
    CACHE_STATE.get_or_init(|| Mutex::new(read_disk_cache()))
}

fn save_disk_cache(cache: &CodexDiskCache) {
    if let Some(path) = disk_cache_path() {
        if let Ok(json) = serde_json::to_string(cache) {
            let tmp_path = path.with_extension("json.tmp");
            if fs::write(&tmp_path, json).is_ok() {
                let _ = fs::rename(&tmp_path, &path);
            }
        }
    }
}

fn cached_projects() -> Option<Vec<ProjectEntry>> {
    cache_state()
        .lock()
        .projects
        .as_ref()
        .map(|cached| cached.entries.clone())
}

fn store_projects(entries: &[ProjectEntry]) {
    let cache = {
        let mut cache = cache_state().lock();
        cache.version = DISK_CACHE_VERSION;
        cache.projects = Some(CachedProjects {
            entries: entries.to_vec(),
        });
        cache.clone()
    };
    save_disk_cache(&cache);
}

fn cached_project_sessions(cwd: &str) -> Option<Vec<SessionIndexEntry>> {
    cache_state()
        .lock()
        .sessions_by_project
        .get(cwd)
        .map(|cached| cached.entries.clone())
}

fn cached_project_count(cwd: &str) -> Option<usize> {
    cache_state()
        .lock()
        .sessions_by_project
        .get(cwd)
        .map(|cached| cached.entries.len())
}

fn store_project_sessions(cwd: &str, entries: &[SessionIndexEntry]) {
    let cache = {
        let mut cache = cache_state().lock();
        cache.version = DISK_CACHE_VERSION;
        cache.sessions_by_project.insert(
            cwd.to_string(),
            CachedSessions {
                entries: entries.to_vec(),
            },
        );
        cache.clone()
    };
    save_disk_cache(&cache);
}

fn clear_disk_cache() {
    if let Some(path) = disk_cache_path() {
        let _ = fs::remove_file(path);
    }
}

pub fn invalidate_sessions_cache() {
    *cache_state().lock() = CodexDiskCache::default();
    clear_message_cache();
    clear_disk_cache();
}

/// Maximum size for text content blocks sent to frontend (20KB)
const MAX_TEXT_BLOCK_SIZE: usize = 20_000;
/// Maximum size for tool output blocks sent to frontend (30KB)
const MAX_OUTPUT_BLOCK_SIZE: usize = 30_000;
/// Maximum size for function call arguments (10KB)
const MAX_ARGS_SIZE: usize = 10_000;

// ── Directory scanning ──

fn get_codex_home() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex"))
}

pub fn get_sessions_dir() -> Option<PathBuf> {
    get_codex_home().map(|h| h.join("sessions"))
}

pub fn scan_all_session_files() -> Vec<PathBuf> {
    let sessions_dir = match get_sessions_dir() {
        Some(d) if d.exists() => d,
        _ => return Vec::new(),
    };

    let mut files: Vec<PathBuf> = Vec::new();

    let year_dirs = match fs::read_dir(&sessions_dir) {
        Ok(d) => d,
        Err(_) => return files,
    };

    for year_entry in year_dirs.flatten() {
        let year_path = year_entry.path();
        if !year_path.is_dir() {
            continue;
        }
        let month_dirs = match fs::read_dir(&year_path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for month_entry in month_dirs.flatten() {
            let month_path = month_entry.path();
            if !month_path.is_dir() {
                continue;
            }
            let day_dirs = match fs::read_dir(&month_path) {
                Ok(d) => d,
                Err(_) => continue,
            };
            for day_entry in day_dirs.flatten() {
                let day_path = day_entry.path();
                if !day_path.is_dir() {
                    continue;
                }
                let jsonl_files = match fs::read_dir(&day_path) {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                for file_entry in jsonl_files.flatten() {
                    let file_path = file_entry.path();
                    if file_path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                        files.push(file_path);
                    }
                }
            }
        }
    }

    files
}

fn short_name_from_path(path: &str) -> String {
    let path = path.trim_end_matches(['/', '\\']);
    if let Some(pos) = path.rfind(['/', '\\']) {
        path[pos + 1..].to_string()
    } else {
        path.to_string()
    }
}

fn extract_date_from_path(path: &Path) -> Option<String> {
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    let len = components.len();
    if len >= 4 {
        let day = components[len - 2];
        let month = components[len - 3];
        let year = components[len - 4];

        if year.len() == 4
            && year.chars().all(|c| c.is_ascii_digit())
            && month.len() <= 2
            && month.chars().all(|c| c.is_ascii_digit())
            && day.len() <= 2
            && day.chars().all(|c| c.is_ascii_digit())
        {
            return Some(format!("{}-{:0>2}-{:0>2}", year, month, day));
        }
    }
    None
}

// ── Session metadata ──

pub struct SessionMeta {
    pub id: String,
    pub cwd: String,
    pub cli_version: Option<String>,
    pub model_provider: Option<String>,
    pub git_branch: Option<String>,
    /// Session source: "cli", "vscode", "exec", "mcp", or an object for "subagent".
    /// Only "cli" and "vscode" are interactive sessions that should be shown to users.
    pub is_interactive: bool,
}

pub fn extract_session_meta(path: &Path) -> Option<SessionMeta> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines().take(5) {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let row: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if row_type == "session_meta" {
            if let Some(payload) = row.get("payload") {
                let id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let cwd = payload
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let cli_version = payload
                    .get("cli_version")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let model_provider = payload
                    .get("model_provider")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let git_branch = payload
                    .get("git")
                    .and_then(|g| g.get("branch"))
                    .and_then(|v| v.as_str())
                    .map(String::from);

                // Determine if this is an interactive session.
                // Codex uses rename_all="lowercase": Cli→"cli", VSCode→"vscode",
                // SubAgent→{"subagent":{...}} (object), Exec→"exec", Mcp→"mcp"
                let is_interactive = match payload.get("source") {
                    Some(Value::String(s)) => s == "cli" || s == "vscode",
                    None => true, // missing source → assume interactive (old format)
                    _ => false,   // object (subagent) or other → non-interactive
                };

                return Some(SessionMeta {
                    id,
                    cwd,
                    cli_version,
                    model_provider,
                    git_branch,
                    is_interactive,
                });
            }
        }
    }
    None
}

// ── Single-pass file scan ──

struct SessionFileScan {
    first_prompt: Option<String>,
    message_count: u32,
}

/// Read a session JSONL file once and extract meta + first_prompt + message count.
fn scan_session_file(path: &Path) -> SessionFileScan {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return SessionFileScan {
                first_prompt: None,
                message_count: 0,
            }
        }
    };
    let reader = BufReader::new(file);

    let mut first_prompt: Option<String> = None;
    let mut message_count: u32 = 0;
    let mut meta_found = false;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Fast path: count messages without JSON parsing
        if first_prompt.is_some() && meta_found {
            // Only need message count from here — use cheap string check
            if (trimmed.contains("\"type\":\"response_item\"")
                || trimmed.contains("\"type\": \"response_item\""))
                && (trimmed.contains("\"type\":\"message\"")
                    || trimmed.contains("\"type\": \"message\""))
                && !trimmed.contains("\"developer\"")
                && !trimmed.contains("\"system\"")
            {
                message_count += 1;
            }
            continue;
        }

        // Need to parse JSON for meta or first_prompt
        let row: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if !meta_found && row_type == "session_meta" {
            meta_found = true;
            continue;
        }

        if row_type == "response_item" {
            if let Some(payload) = row.get("payload") {
                let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if payload_type == "message" {
                    let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
                    if role != "developer" && role != "system" {
                        message_count += 1;
                        if first_prompt.is_none() && role == "user" {
                            if let Some(content) =
                                payload.get("content").and_then(|c| c.as_array())
                            {
                                for item in content {
                                    let item_type =
                                        item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    if item_type == "input_text" || item_type == "text" {
                                        if let Some(text) =
                                            item.get("text").and_then(|v| v.as_str())
                                        {
                                            if !text.is_empty() {
                                                first_prompt =
                                                    Some(truncate_string(text, 200));
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    SessionFileScan {
        first_prompt,
        message_count,
    }
}

#[derive(Default)]
struct SessionVisibilityScan {
    first_prompt: Option<String>,
    message_count: u32,
    has_visible_activity: bool,
}

fn scan_session_visibility(path: &Path) -> SessionVisibilityScan {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return SessionVisibilityScan::default(),
    };
    let reader = BufReader::new(file);

    let mut scan = SessionVisibilityScan::default();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let row: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if row.get("type").and_then(|v| v.as_str()) != Some("response_item") {
            continue;
        }

        let Some(payload) = row.get("payload") else {
            continue;
        };

        let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match payload_type {
            "message" => {
                let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role == "developer" || role == "system" {
                    continue;
                }

                if let Some(first_prompt) = extract_first_prompt_text(payload) {
                    if scan.first_prompt.is_none() && role == "user" {
                        scan.first_prompt = Some(truncate_string(&first_prompt, 200));
                    }
                }

                if !extract_message_content(payload).is_empty() {
                    scan.message_count += 1;
                    scan.has_visible_activity = true;
                }
            }
            "function_call"
                if payload
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|name| !name.trim().is_empty())
                    .unwrap_or(false) =>
            {
                scan.has_visible_activity = true;
            }
            "function_call_output"
                if payload
                    .get("output")
                    .map(value_has_visible_content)
                    .unwrap_or(false) =>
            {
                scan.has_visible_activity = true;
            }
            "reasoning"
                if extract_reasoning_text(payload)
                    .map(|text| !text.trim().is_empty())
                    .unwrap_or(false) =>
            {
                scan.has_visible_activity = true;
            }
            _ => {}
        }
    }

    scan
}

fn extract_first_prompt_text(payload: &Value) -> Option<String> {
    let content = payload.get("content")?.as_array()?;
    for item in content {
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if item_type == "input_text" || item_type == "text" {
            let text = item.get("text").and_then(|v| v.as_str())?;
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn extract_reasoning_text(payload: &Value) -> Option<String> {
    let value = payload
        .get("text")
        .or_else(|| payload.get("summary").and_then(|summary| summary.get(0)))?;

    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }

    if let Some(arr) = value.as_array() {
        let text = arr
            .iter()
            .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<&str>>()
            .join("\n");
        return (!text.trim().is_empty()).then_some(text);
    }

    Some(value.to_string())
}

fn value_has_visible_content(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        Value::Bool(_) | Value::Number(_) => true,
    }
}

fn scan_projects_from_meta() -> Result<Vec<ProjectEntry>, String> {
    let files = scan_all_session_files();
    let mut project_map: HashMap<String, ProjectEntry> = HashMap::new();

    for file_path in files {
        let Some(meta) = extract_session_meta(&file_path) else {
            continue;
        };
        if !meta.is_interactive || meta.cwd.is_empty() {
            continue;
        }

        let cwd = meta.cwd;
        let modified = fs::metadata(&file_path)
            .and_then(|m| m.modified())
            .ok()
            .map(|t| {
                let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            });

        let entry = project_map
            .entry(cwd.clone())
            .or_insert_with(|| ProjectEntry {
                source: "codex".to_string(),
                id: cwd.clone(),
                display_path: cwd.clone(),
                short_name: short_name_from_path(&cwd),
                session_count: 0,
                last_modified: None,
                model_provider: meta.model_provider.clone(),
                alias: None,
                path_exists: std::path::Path::new(&cwd).exists(),
            });

        entry.session_count += 1;

        if let Some(ref modified) = modified {
            if entry
                .last_modified
                .as_ref()
                .map(|m| modified > m)
                .unwrap_or(true)
            {
                entry.last_modified = Some(modified.clone());
            }
        }
    }

    for (cwd, project) in &mut project_map {
        if let Some(cached_count) = cached_project_count(cwd) {
            if cached_count == project.session_count {
                project.session_count = cached_count;
            }
        }
    }

    let mut projects: Vec<ProjectEntry> = project_map.into_values().collect();
    projects.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    Ok(projects)
}

fn refresh_projects_cache() -> Result<Vec<ProjectEntry>, String> {
    let projects = scan_projects_from_meta()?;
    store_projects(&projects);
    Ok(projects)
}

pub fn get_projects() -> Result<Vec<ProjectEntry>, String> {
    if let Some(projects) = cached_projects() {
        return Ok(projects);
    }

    refresh_projects_cache()
}

pub fn refresh_sessions_cache(cwd: &str) -> Result<Vec<SessionIndexEntry>, String> {
    let files = scan_all_session_files();

    let mut entries: Vec<SessionIndexEntry> = files
        .into_par_iter()
        .filter_map(|file_path| {
            let meta = extract_session_meta(&file_path)?;
            if !meta.is_interactive || meta.cwd != cwd {
                return None;
            }

            let scan = scan_session_file(&file_path);
            let file_meta = fs::metadata(&file_path).ok();
            let modified = file_meta.as_ref().and_then(|m| {
                m.modified().ok().map(|t| {
                    let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                    chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
            });
            let created = file_meta.as_ref().and_then(|m| {
                m.created().ok().map(|t| {
                    let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                    chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
            });

            Some(SessionIndexEntry {
                source: "codex".to_string(),
                session_id: meta.id,
                file_path: file_path.to_string_lossy().to_string(),
                first_prompt: scan.first_prompt,
                message_count: scan.message_count,
                created,
                modified,
                git_branch: meta.git_branch,
                project_path: None,
                is_sidechain: None,
                cwd: Some(meta.cwd),
                model_provider: meta.model_provider,
                cli_version: meta.cli_version,
                alias: None,
                tags: None,
            })
        })
        .collect();

    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    store_project_sessions(cwd, &entries);
    Ok(entries)
}

pub fn get_sessions(cwd: &str) -> Result<Vec<SessionIndexEntry>, String> {
    if let Some(entries) = cached_project_sessions(cwd) {
        return Ok(entries);
    }

    refresh_sessions_cache(cwd)
}

pub fn get_invalid_sessions(cwd: &str) -> Result<Vec<SessionIndexEntry>, String> {
    let mut entries: Vec<SessionIndexEntry> = scan_all_session_files()
        .into_par_iter()
        .filter_map(|file_path| {
            let meta = extract_session_meta(&file_path)?;
            if !meta.is_interactive || meta.cwd != cwd {
                return None;
            }

            let scan = scan_session_visibility(&file_path);
            if scan.has_visible_activity {
                return None;
            }

            let file_meta = fs::metadata(&file_path).ok();
            let modified = file_meta.as_ref().and_then(|m| {
                m.modified().ok().map(|t| {
                    let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                    chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
            });
            let created = file_meta.as_ref().and_then(|m| {
                m.created().ok().map(|t| {
                    let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                    chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
            });

            Some(SessionIndexEntry {
                source: "codex".to_string(),
                session_id: meta.id,
                file_path: file_path.to_string_lossy().to_string(),
                first_prompt: scan.first_prompt,
                message_count: scan.message_count,
                created,
                modified,
                git_branch: meta.git_branch,
                project_path: None,
                is_sidechain: None,
                cwd: Some(meta.cwd),
                model_provider: meta.model_provider,
                cli_version: meta.cli_version,
                alias: None,
                tags: None,
            })
        })
        .collect();

    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(entries)
}

// ── Message parsing ──

pub fn parse_session_messages(
    path: &Path,
    page: usize,
    page_size: usize,
    from_end: bool,
) -> Result<PaginatedMessages, String> {
    if let Ok(Some(cached)) = get_cached_page(path, page, page_size, from_end) {
        return Ok(cached);
    }

    if from_end {
        return parse_tail_messages(path, page, page_size);
    }

    let all_messages = parse_all_messages(path)?;
    let total = all_messages.len();
    let start = page * page_size;
    let end = (start + page_size).min(total);
    let has_more = end < total;

    let page_messages = if start < total {
        all_messages[start..end].to_vec()
    } else {
        Vec::new()
    };

    Ok(PaginatedMessages {
        messages: page_messages,
        total,
        page,
        page_size,
        has_more,
    })
}

pub fn parse_all_messages(path: &Path) -> Result<Vec<DisplayMessage>, String> {
    if let Ok(Some(cached)) = get_cached_full_messages(path) {
        return Ok(cached);
    }

    let file = fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = BufReader::new(file);
    let mut messages: Vec<DisplayMessage> = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let row: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(message) = display_message_from_row(&row) {
            messages.push(message);
        }
    }

    let _ = store_full_messages(path, &messages);
    Ok(messages)
}

fn parse_tail_messages(path: &Path, page: usize, page_size: usize) -> Result<PaginatedMessages, String> {
    let file = fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = BufReader::new(file);
    let window_len = tail_window_len(page, page_size);
    let mut tail_messages: VecDeque<DisplayMessage> = VecDeque::with_capacity(window_len);
    let mut total = 0usize;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let row: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(message) = display_message_from_row(&row) {
            total += 1;
            if tail_messages.len() == window_len {
                tail_messages.pop_front();
            }
            tail_messages.push_back(message);
        }
    }

    let messages: Vec<DisplayMessage> = tail_messages.into_iter().collect();
    let range_start = total.saturating_sub(messages.len());
    let _ = store_partial_messages(path, total, range_start, &messages);

    paginate_from_range(&messages, total, page, page_size, true, range_start)
        .ok_or_else(|| "Failed to paginate tail messages".to_string())
}

fn display_message_from_row(row: &Value) -> Option<DisplayMessage> {
    let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if row_type != "response_item" {
        return None;
    }

    let timestamp = row.get("timestamp").and_then(|v| v.as_str()).map(String::from);
    let payload = row.get("payload")?;
    let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match payload_type {
        "message" => {
            let role = payload
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if role == "developer" || role == "system" {
                return None;
            }
            if role != "user" && role != "assistant" {
                return None;
            }

            let content_blocks = extract_message_content(payload);
            if content_blocks.is_empty() {
                return None;
            }

            Some(DisplayMessage {
                uuid: None,
                parent_uuid: None,
                role: role.to_string(),
                timestamp,
                model: None,
                content: content_blocks,
            })
        }
        "function_call" => {
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let arguments = payload
                .get("arguments")
                .map(|v| {
                    if let Some(s) = v.as_str() {
                        if let Ok(parsed) = serde_json::from_str::<Value>(s) {
                            serde_json::to_string_pretty(&parsed)
                                .unwrap_or_else(|_| s.to_string())
                        } else {
                            s.to_string()
                        }
                    } else {
                        serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
                    }
                })
                .unwrap_or_default();
            let call_id = payload
                .get("call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            Some(DisplayMessage {
                uuid: None,
                parent_uuid: None,
                role: "assistant".to_string(),
                timestamp,
                model: None,
                content: vec![DisplayContentBlock::FunctionCall {
                    name,
                    arguments: truncate_string(&arguments, MAX_ARGS_SIZE),
                    call_id,
                }],
            })
        }
        "function_call_output" => {
            let call_id = payload
                .get("call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let output = payload
                .get("output")
                .map(|v| {
                    if let Some(s) = v.as_str() {
                        s.to_string()
                    } else {
                        serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
                    }
                })
                .unwrap_or_default();

            Some(DisplayMessage {
                uuid: None,
                parent_uuid: None,
                role: "tool".to_string(),
                timestamp,
                model: None,
                content: vec![DisplayContentBlock::FunctionCallOutput {
                    call_id,
                    output: truncate_string(&output, MAX_OUTPUT_BLOCK_SIZE),
                }],
            })
        }
        "reasoning" => {
            let text = payload
                .get("text")
                .or_else(|| payload.get("summary").and_then(|s| s.get(0)))
                .map(|v| {
                    if let Some(s) = v.as_str() {
                        s.to_string()
                    } else if let Some(arr) = v.as_array() {
                        arr.iter()
                            .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                            .collect::<Vec<&str>>()
                            .join("\n")
                    } else {
                        v.to_string()
                    }
                })
                .unwrap_or_default();

            if text.is_empty() {
                return None;
            }

            Some(DisplayMessage {
                uuid: None,
                parent_uuid: None,
                role: "assistant".to_string(),
                timestamp,
                model: None,
                content: vec![DisplayContentBlock::Reasoning { text }],
            })
        }
        _ => None,
    }
}

fn extract_message_content(payload: &Value) -> Vec<DisplayContentBlock> {
    let mut blocks = Vec::new();

    if let Some(content) = payload.get("content") {
        if let Some(arr) = content.as_array() {
            for item in arr {
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match item_type {
                    "input_text" | "output_text" | "text" => {
                        let text = item
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !text.trim().is_empty() {
                            blocks.push(DisplayContentBlock::Text {
                                text: truncate_string(text, MAX_TEXT_BLOCK_SIZE),
                            });
                        }
                    }
                    "reasoning" => {
                        let text = item
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !text.trim().is_empty() {
                            blocks.push(DisplayContentBlock::Reasoning {
                                text: truncate_string(text, MAX_TEXT_BLOCK_SIZE),
                            });
                        }
                    }
                    _ => {}
                }
            }
        } else if let Some(s) = content.as_str() {
            if !s.trim().is_empty() {
                blocks.push(DisplayContentBlock::Text {
                    text: truncate_string(s, MAX_TEXT_BLOCK_SIZE),
                });
            }
        }
    }

    blocks
}

pub fn extract_first_prompt(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.contains("\"role\"") || !trimmed.contains("\"user\"") {
            continue;
        }

        let row: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if row_type != "response_item" {
            continue;
        }

        if let Some(payload) = row.get("payload") {
            let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if payload_type != "message" {
                continue;
            }
            let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role != "user" {
                continue;
            }

            if let Some(content) = payload.get("content").and_then(|c| c.as_array()) {
                for item in content {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if item_type == "input_text" || item_type == "text" {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                return Some(truncate_string(text, 200));
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

pub fn count_messages(path: &Path) -> u32 {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return 0,
    };
    let reader = BufReader::new(file);
    let mut count: u32 = 0;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();

        // More precise matching: check type field value, not arbitrary string position
        if (trimmed.contains("\"type\":\"response_item\"")
            || trimmed.contains("\"type\": \"response_item\""))
            && (trimmed.contains("\"type\":\"message\"")
                || trimmed.contains("\"type\": \"message\""))
            && !trimmed.contains("\"developer\"")
            && !trimmed.contains("\"system\"")
        {
            count += 1;
        }
    }
    count
}

// ── Token info ──

pub struct TokenInfo {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

pub fn extract_token_info(path: &Path) -> Option<TokenInfo> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut last_token_info: Option<TokenInfo> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("\"token_count\"") {
            continue;
        }

        let row: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if row_type != "event_msg" {
            continue;
        }

        if let Some(payload) = row.get("payload") {
            let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if payload_type != "token_count" {
                continue;
            }

            if let Some(info) = payload.get("info").and_then(|i| i.get("total_token_usage")) {
                let input = info.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let output = info.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let total = info.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(input + output);

                last_token_info = Some(TokenInfo {
                    input_tokens: input,
                    output_tokens: output,
                    total_tokens: total,
                });
            }
        }
    }

    last_token_info
}

// ── Stats ──

pub fn get_stats() -> Result<TokenUsageSummary, String> {
    let files = scan_all_session_files();

    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut total_tokens: u64 = 0;
    let mut tokens_by_model: HashMap<String, u64> = HashMap::new();
    let mut daily_map: HashMap<String, (u64, u64, u64)> = HashMap::new();
    let mut session_count: u64 = 0;
    let mut message_count: u64 = 0;

    for file_path in &files {
        session_count += 1;
        message_count += count_messages(file_path) as u64;

        let model_provider = extract_session_meta(file_path)
            .and_then(|m| m.model_provider)
            .unwrap_or_else(|| "unknown".to_string());

        if let Some(token_info) = extract_token_info(file_path) {
            total_input_tokens += token_info.input_tokens;
            total_output_tokens += token_info.output_tokens;
            total_tokens += token_info.total_tokens;

            *tokens_by_model.entry(model_provider).or_insert(0) += token_info.total_tokens;

            if let Some(date) = extract_date_from_path(file_path) {
                let entry = daily_map.entry(date).or_insert((0, 0, 0));
                entry.0 += token_info.input_tokens;
                entry.1 += token_info.output_tokens;
                entry.2 += token_info.total_tokens;
            }
        }
    }

    let mut daily_tokens: Vec<DailyTokenEntry> = daily_map
        .into_iter()
        .map(|(date, (input, output, total))| DailyTokenEntry {
            date,
            input_tokens: input,
            output_tokens: output,
            total_tokens: total,
        })
        .collect();
    daily_tokens.sort_by(|a, b| a.date.cmp(&b.date));

    Ok(TokenUsageSummary {
        total_input_tokens,
        total_output_tokens,
        total_tokens,
        tokens_by_model,
        daily_tokens,
        session_count,
        message_count,
        is_first_build: false,
    })
}


fn truncate_string(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_len).collect();
        format!("{}...", truncated)
    }
}
