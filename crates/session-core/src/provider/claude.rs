use std::fs;
use std::path::{Path, PathBuf};

use crate::models::message::{DisplayMessage, PaginatedMessages};
use crate::models::project::ProjectEntry;
use crate::models::session::{SessionIndexEntry, SessionsIndex, SessionsIndexFileEntry};
use crate::parser::jsonl as claude_parser;
use crate::parser::path_encoder::{
    decode_project_path_validated, get_projects_dir, short_name_from_path,
};

#[derive(serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DeleteLevel {
    SessionOnly,
    WithCcConfig,
    /// Level 3：清理 history.jsonl。保留后端实现，前端 UI 不暴露。
    WithHistory,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub sessions_deleted: usize,
    pub config_cleaned: bool,
    pub bookmarks_removed: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProjectMeta {
    alias: Option<String>,
}

/// 读取项目别名。文件不存在或 alias 字段缺失时返回 Ok(None)，不报错。
/// 使用 canonicalize + starts_with 防止路径遍历。
pub fn get_project_alias(project_id: &str) -> Result<Option<String>, String> {
    let projects_dir = get_projects_dir()
        .ok_or_else(|| "Cannot find Claude projects directory".to_string())?;
    let project_dir = projects_dir.join(project_id);
    if !project_dir.exists() {
        return Ok(None);
    }
    // 防止路径遍历：规范化后验证仍在 projects_dir 内
    let canonical_dir = project_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;
    let canonical_base = projects_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve projects directory: {}", e))?;
    if !canonical_dir.starts_with(&canonical_base) {
        return Ok(None); // 路径逃逸，静默返回无别名
    }
    let meta_path = canonical_dir.join(".project-meta.json");
    if !meta_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Failed to read project meta: {}", e))?;
    let meta: ProjectMeta = serde_json::from_str(&content)
        .unwrap_or_default();
    Ok(meta.alias)
}

/// 写入别名。
///
/// - alias 为 Some(s)：写入 / 更新 .project-meta.json 中的 alias 字段
/// - alias 为 None：删除 alias 字段；若文件其余字段为空（{}）则删除文件
///
/// 使用 canonicalize + starts_with 防止路径遍历。
pub fn set_project_alias(project_id: &str, alias: Option<String>) -> Result<(), String> {
    let projects_dir = get_projects_dir()
        .ok_or_else(|| "Cannot find Claude projects directory".to_string())?;
    let project_dir = projects_dir.join(project_id);

    if !project_dir.exists() {
        return Err(format!("Project not found: {}", project_id));
    }
    let canonical_dir = project_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;
    let canonical_base = projects_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve projects directory: {}", e))?;
    if !canonical_dir.starts_with(&canonical_base) {
        return Err(format!("Invalid project id: {}", project_id));
    }

    let meta_path = canonical_dir.join(".project-meta.json");

    let mut raw: serde_json::Map<String, serde_json::Value> = if meta_path.exists() {
        let content = fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read project meta: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };

    match alias {
        Some(a) => {
            let a = a.trim().to_string();
            if a.is_empty() {
                raw.remove("alias");
            } else {
                raw.insert("alias".to_string(), serde_json::Value::String(a));
            }
        }
        None => {
            raw.remove("alias");
        }
    }

    if raw.is_empty() {
        if meta_path.exists() {
            fs::remove_file(&meta_path)
                .map_err(|e| format!("Failed to remove project meta: {}", e))?;
        }
    } else {
        let json = serde_json::to_string(&raw)
            .map_err(|e| format!("Failed to serialize project meta: {}", e))?;
        fs::write(&meta_path, json)
            .map_err(|e| format!("Failed to write project meta: {}", e))?;
    }

    Ok(())
}

/// Get all Claude projects
pub fn get_projects() -> Result<Vec<ProjectEntry>, String> {
    let projects_dir = get_projects_dir().ok_or("Could not find Claude projects directory")?;

    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects: Vec<ProjectEntry> = Vec::new();

    let entries =
        fs::read_dir(&projects_dir).map_err(|e| format!("Failed to read projects dir: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let encoded_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        // Read sessions-index.json for display path and accurate session count
        let index_path = path.join("sessions-index.json");
        let parsed_index = fs::read_to_string(&index_path)
            .ok()
            .and_then(|c| serde_json::from_str::<SessionsIndex>(&c).ok());

        let (display_path, path_exists) = parsed_index
            .as_ref()
            .and_then(|idx| {
                // Primary: use originalPath from the index
                idx.original_path.clone().or_else(|| {
                    // Secondary: use projectPath from the first available entry
                    idx.entries.iter().find_map(|e| e.project_path.clone())
                })
            })
            .map(|p| {
                let exists = std::path::Path::new(&p).exists();
                (p, exists)
            })
            .unwrap_or_else(|| {
                let decoded = decode_project_path_validated(&encoded_name);
                (decoded.display_path, decoded.path_exists)
            });
        let short_name = short_name_from_path(&display_path);

        // 用轻量计数：只检查文件大小，避免读取文件内容
        let session_count = count_jsonl_files(&path);

        let last_modified = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .map(|t| {
                let duration = t
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default();
                chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            });

        if session_count > 0 {
            let alias = get_project_alias(&encoded_name).unwrap_or(None);
            projects.push(ProjectEntry {
                source: "claude".to_string(),
                id: encoded_name,
                display_path,
                short_name,
                session_count,
                last_modified,
                model_provider: None,
                alias,
                path_exists,
            });
        }
    }

    projects.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(projects)
}

/// Get sessions for a Claude project
pub fn get_sessions(encoded_name: &str) -> Result<Vec<SessionIndexEntry>, String> {
    let projects_dir = get_projects_dir().ok_or("Could not find Claude projects directory")?;
    let project_dir = projects_dir.join(encoded_name);

    if !project_dir.exists() {
        return Err(format!("Project directory not found: {}", encoded_name));
    }

    // Step 1：磁盘扫描，分类 valid / invalid
    let (mut valid_sessions, invalid_items) = scan_project_dir(&project_dir);

    // Step 2：index 元数据补充（可选，失败时静默跳过）
    enrich_with_index(&project_dir, &mut valid_sessions);

    // Step 3：移动无效 item（静默，不影响返回值）
    cleanup_invalid_sessions(&project_dir, invalid_items);

    valid_sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(valid_sessions)
}


/// Parse messages from a Claude JSONL file
pub fn parse_session_messages(
    path: &std::path::Path,
    page: usize,
    page_size: usize,
    from_end: bool,
) -> Result<PaginatedMessages, String> {
    claude_parser::parse_session_messages(path, page, page_size, from_end)
}

/// Parse all messages (for search)
pub fn parse_all_messages(path: &std::path::Path) -> Result<Vec<DisplayMessage>, String> {
    claude_parser::parse_all_messages(path)
}

/// Collect all JSONL files for search
pub fn collect_all_jsonl_files() -> Vec<(String, String, PathBuf)> {
    let projects_dir = match get_projects_dir() {
        Some(d) if d.exists() => d,
        _ => return Vec::new(),
    };

    let mut files: Vec<(String, String, PathBuf)> = Vec::new();

    let project_dirs = match fs::read_dir(&projects_dir) {
        Ok(d) => d,
        Err(_) => return files,
    };

    for entry in project_dirs.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let encoded_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        // Prefer originalPath from sessions-index.json (same as get_projects)
        let index_path = path.join("sessions-index.json");
        let display_path = fs::read_to_string(&index_path)
            .ok()
            .and_then(|c| serde_json::from_str::<SessionsIndex>(&c).ok())
            .and_then(|idx| {
                idx.original_path
                    .or_else(|| idx.entries.iter().find_map(|e| e.project_path.clone()))
            })
            .unwrap_or_else(|| decode_project_path_validated(&encoded_name).display_path);
        let project_name = short_name_from_path(&display_path);

        if let Ok(dir_files) = fs::read_dir(&path) {
            for file_entry in dir_files.flatten() {
                let file_path = file_entry.path();
                if file_path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    files.push((encoded_name.clone(), project_name.clone(), file_path));
                }
            }
        }
    }

    files
}

#[derive(Debug)]
enum InvalidReason {
    Empty,
    NoMessages,
    Corrupt,
    OrphanDir,
}

#[derive(Debug)]
struct InvalidItem {
    path: PathBuf,
    reason: InvalidReason,
}

// ── internal helpers ──

/// Step 1：磁盘扫描 — 将顶层 .jsonl 文件分类为 valid / invalid，
/// 同时检测孤儿 UUID 子目录（有目录但无对应 .jsonl）。
fn scan_project_dir(
    project_dir: &Path,
) -> (Vec<SessionIndexEntry>, Vec<InvalidItem>) {
    let mut valid_sessions: Vec<SessionIndexEntry> = Vec::new();
    let mut invalid_items: Vec<InvalidItem> = Vec::new();
    let mut valid_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    let entries = match fs::read_dir(project_dir) {
        Ok(e) => e,
        Err(_) => return (valid_sessions, invalid_items),
    };

    // 第一遍：处理顶层 .jsonl 文件
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(ext) = path.extension() else { continue };
        if ext != "jsonl" {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if session_id.is_empty() {
            continue;
        }

        // 检查文件大小
        let file_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if file_size == 0 {
            invalid_items.push(InvalidItem { path, reason: InvalidReason::Empty });
            continue;
        }

        // 尝试计数消息（返回 0 或解析失败）
        let msg_count_result = count_messages_result(&path);
        match msg_count_result {
            Err(_) => {
                invalid_items.push(InvalidItem { path, reason: InvalidReason::Corrupt });
            }
            Ok(0) => {
                invalid_items.push(InvalidItem { path, reason: InvalidReason::NoMessages });
            }
            Ok(_count) => {
                if let Some(entry) = scan_single_session(&path, &session_id) {
                    valid_ids.insert(session_id);
                    valid_sessions.push(entry);
                }
            }
        }
    }

    // 第二遍：检测孤儿 UUID 子目录（跳过 "invalid" 目录本身）
    if let Ok(entries2) = fs::read_dir(project_dir) {
        for entry in entries2.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if dir_name == "invalid" || dir_name.is_empty() {
                continue;
            }
            // 只处理 UUID 格式目录（36 字符含连字符）
            if dir_name.len() == 36
                && dir_name.chars().filter(|&c| c == '-').count() == 4
                && !valid_ids.contains(&dir_name)
            {
                invalid_items.push(InvalidItem {
                    path,
                    reason: InvalidReason::OrphanDir,
                });
            }
        }
    }

    (valid_sessions, invalid_items)
}

/// Step 3：将无效 session 移入 project_dir/invalid/。
/// 内部错误不向上传播，eprintln! 静默记录。
fn cleanup_invalid_sessions(project_dir: &Path, invalid_items: Vec<InvalidItem>) {
    if invalid_items.is_empty() {
        return;
    }

    let invalid_dir = project_dir.join("invalid");
    if let Err(e) = fs::create_dir_all(&invalid_dir) {
        eprintln!("[cleanup] Failed to create invalid dir: {}", e);
        return;
    }

    // 读取已有 manifest（追加模式）
    let manifest_path = invalid_dir.join("manifest.json");
    let mut manifest: Vec<serde_json::Value> = if manifest_path.exists() {
        fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let moved_at = chrono::Utc::now().to_rfc3339();

    for item in invalid_items {
        let file_name = match item.path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let target = invalid_dir.join(&file_name);

        // 目标已存在 → 跳过，避免覆盖
        if target.exists() {
            continue;
        }

        let reason = match item.reason {
            InvalidReason::Empty => "Empty",
            InvalidReason::NoMessages => "NoMessages",
            InvalidReason::Corrupt => "Corrupt",
            InvalidReason::OrphanDir => "OrphanDir",
        };

        match fs::rename(&item.path, &target) {
            Ok(()) => {
                manifest.push(serde_json::json!({
                    "file": file_name,
                    "reason": reason,
                    "movedAt": moved_at,
                }));
            }
            Err(e) => {
                eprintln!("[cleanup] Failed to move {:?}: {}", item.path, e);
            }
        }
    }

    // 原子写回 manifest.json
    if let Ok(json) = serde_json::to_string_pretty(&manifest) {
        let tmp_path = manifest_path.with_extension("json.tmp");
        if fs::write(&tmp_path, &json).is_ok() {
            if let Err(e) = fs::rename(&tmp_path, &manifest_path) {
                eprintln!("[cleanup] Failed to write manifest: {}", e);
            }
        }
    }
}

/// Step 2：用 sessions-index.json 的元数据补充 valid_sessions。
/// 若 index 不存在或解析失败，直接返回，不影响 valid_sessions。
fn enrich_with_index(project_dir: &Path, sessions: &mut [SessionIndexEntry]) {
    let index_path = project_dir.join("sessions-index.json");
    let content = match fs::read_to_string(&index_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let index: SessionsIndex = match serde_json::from_str(&content) {
        Ok(i) => i,
        Err(_) => return,
    };

    let original_path = index.original_path.clone();

    // 构建 index_map: session_id -> IndexEntry
    let index_map: std::collections::HashMap<&str, &SessionsIndexFileEntry> = index
        .entries
        .iter()
        .map(|e| (e.session_id.as_str(), e))
        .collect();

    for session in sessions.iter_mut() {
        if let Some(idx_entry) = index_map.get(session.session_id.as_str()) {
            // 用 index 的时间戳覆盖（更准确）
            if let Some(ref created) = idx_entry.created {
                session.created = Some(created.clone());
            }
            if let Some(ref modified) = idx_entry.modified {
                session.modified = Some(modified.clone());
            }
            // 补充 git_branch（Step 1 未提取到时）
            if session.git_branch.is_none() {
                session.git_branch = idx_entry.git_branch.clone();
            }
            // 补充 is_sidechain
            if session.is_sidechain.is_none() {
                session.is_sidechain = idx_entry.is_sidechain;
            }
            // idx_entry.project_path 优先
            if session.project_path.is_none() {
                session.project_path = idx_entry.project_path.clone();
            }
        }
        // original_path 作为最终兜底（index 中没有该 session 或 idx_entry.project_path 为空时）
        if session.project_path.is_none() {
            session.project_path = original_path.clone();
        }
    }
}

fn scan_single_session(path: &std::path::Path, session_id: &str) -> Option<SessionIndexEntry> {
    let first_prompt = claude_parser::extract_first_prompt(path);
    let alias = claude_parser::extract_custom_title(path);
    let metadata = claude_parser::extract_session_metadata(path);
    let (_, git_branch, project_path) = metadata.unwrap_or((String::new(), None, None));
    let message_count = count_messages(path);

    let file_meta = fs::metadata(path).ok();
    let modified = file_meta.as_ref().and_then(|m| {
        m.modified().ok().map(|t| {
            let d = t
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_default()
        })
    });

    let created = file_meta.as_ref().and_then(|m| {
        m.created().ok().map(|t| {
            let d = t
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default();
            chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_default()
        })
    });

    Some(SessionIndexEntry {
        source: "claude".to_string(),
        session_id: session_id.to_string(),
        file_path: path.to_string_lossy().to_string(),
        first_prompt,
        message_count,
        created,
        modified,
        git_branch,
        project_path,
        is_sidechain: Some(false),
        cwd: None,
        model_provider: None,
        cli_version: None,
        alias,
        tags: None,
    })
}

/// 删除项目目录，并根据 level 执行额外清理。
pub fn delete_project(project_id: &str, level: DeleteLevel) -> Result<DeleteResult, String> {
    // 安全检查：project_id 不能为空、"."、".."
    if project_id.is_empty() || project_id == "." || project_id == ".." {
        return Err(format!("Invalid project id: {}", project_id));
    }

    let projects_dir = get_projects_dir()
        .ok_or_else(|| "Cannot find Claude projects directory".to_string())?;
    let dir = projects_dir.join(project_id);
    if !dir.exists() {
        return Err(format!("Project not found: {}", project_id));
    }

    // 防路径遍历
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;
    let canonical_base = projects_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve projects directory: {}", e))?;
    if !canonical_dir.starts_with(&canonical_base) {
        return Err(format!("Invalid project id: {}", project_id));
    }

    // Level 2+：删除目录前先内联读取 real_path（sessions-index.json 在目录内，必须先读）
    let real_path: Option<String> = if level == DeleteLevel::WithCcConfig
        || level == DeleteLevel::WithHistory
    {
        let index_path = canonical_dir.join("sessions-index.json");
        let path_from_index = fs::read_to_string(&index_path)
            .ok()
            .and_then(|c| serde_json::from_str::<SessionsIndex>(&c).ok())
            .and_then(|idx| {
                idx.original_path
                    .or_else(|| idx.entries.iter().find_map(|e| e.project_path.clone()))
            });
        let resolved = path_from_index
            .unwrap_or_else(|| decode_project_path_validated(project_id).display_path);
        Some(resolved)
    } else {
        None
    };

    // 统计 session 文件数
    let sessions_deleted = count_jsonl_files(&canonical_dir);

    // 删除会话数据目录
    fs::remove_dir_all(&canonical_dir)
        .map_err(|e| format!("Failed to delete project: {}", e))?;

    let mut config_cleaned = false;
    let mut bookmarks_removed = 0;

    if level == DeleteLevel::WithCcConfig || level == DeleteLevel::WithHistory {
        // Level 2a：清理 ~/.claude.json
        config_cleaned = clean_claude_config(real_path.as_deref().unwrap_or(""));

        // Level 2b：清理书签
        bookmarks_removed = clean_bookmarks_for_project(project_id);
    }
    // Level 3 (WithHistory) 的 history.jsonl 清理逻辑预留此处，本次不实现具体功能。

    Ok(DeleteResult {
        sessions_deleted,
        config_cleaned,
        bookmarks_removed,
    })
}

/// 从 ~/.claude.json 中删除 projects[real_path] key。
/// real_path 反查失败时静默返回 false（不报错）。
fn clean_claude_config(real_path: &str) -> bool {
    if real_path.is_empty() {
        return false;
    }

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    let config_path = home.join(".claude.json");
    if !config_path.exists() {
        return false;
    }

    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return false,
    };

    let mut json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return false,
    };

    // 找到 projects 对象并删除对应 key
    let removed = if let Some(projects) = json.get_mut("projects").and_then(|p| p.as_object_mut()) {
        projects.remove(real_path).is_some()
    } else {
        false
    };

    if !removed {
        return false;
    }

    // 原子写回
    let new_content = match serde_json::to_string_pretty(&json) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let tmp_path = config_path.with_extension("json.tmp");
    if fs::write(&tmp_path, &new_content).is_err() {
        return false;
    }
    fs::rename(&tmp_path, &config_path).is_ok()
}

/// 从 ~/.session-viewer-bookmarks.json 删除 project_id 匹配的书签。
/// 返回删除数量，失败时返回 0（静默）。
fn clean_bookmarks_for_project(project_id: &str) -> usize {
    use crate::bookmarks::load_bookmarks;

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return 0,
    };
    let path = home.join(".session-viewer-bookmarks.json");

    let mut file = load_bookmarks();
    let before = file.bookmarks.len();
    file.bookmarks.retain(|b| b.project_id != project_id);
    let removed = before - file.bookmarks.len();

    if removed == 0 {
        return 0;
    }

    // 原子写回
    let json = match serde_json::to_string_pretty(&file) {
        Ok(j) => j,
        Err(_) => return 0,
    };
    let tmp_path = path.with_extension("json.tmp");
    if fs::write(&tmp_path, &json).is_err() {
        return 0;
    }
    if fs::rename(&tmp_path, &path).is_err() {
        return 0;
    }
    removed
}

fn count_messages(path: &std::path::Path) -> u32 {
    use std::io::{BufRead, BufReader};
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return 0,
    };
    let reader = BufReader::new(file);
    let mut count: u32 = 0;
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.contains("\"type\":\"user\"") || trimmed.contains("\"type\":\"assistant\"") {
            count += 1;
        }
    }
    count
}

fn count_messages_result(path: &Path) -> Result<u32, String> {
    use std::io::{BufRead, BufReader};
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut count: u32 = 0;
    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(v) => {
                if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                    if t == "user" || t == "assistant" {
                        count += 1;
                    }
                }
            }
            Err(_) => {
                return Err("JSON parse error".to_string());
            }
        }
    }
    Ok(count)
}

/// Count valid (non-empty) .jsonl files at the TOP LEVEL of dir only.
/// Does NOT descend into subdirectories (e.g. invalid/).
fn count_jsonl_files(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    let p = e.path();
                    p.is_file()
                        && p.extension().map(|ext| ext == "jsonl").unwrap_or(false)
                        && e.metadata().map(|m| m.len() > 0).unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}
