use session_core::metadata;
use session_core::metadata::validate_session_id;
use session_core::models::session::SessionIndexEntry;
use session_core::paths::validate_session_file;
use session_core::provider::{claude, codex};
use session_core::recyclebin;

fn merge_session_metadata(source: &str, project_id: &str, sessions: &mut [SessionIndexEntry]) {
    let meta = metadata::load_metadata(source, project_id);
    for session in sessions {
        if let Some(sm) = meta.sessions.get(&session.session_id) {
            if source == "claude" {
                if !sm.tags.is_empty() {
                    session.tags = Some(sm.tags.clone());
                }
            } else {
                session.alias = sm.alias.clone();
                if !sm.tags.is_empty() {
                    session.tags = Some(sm.tags.clone());
                }
            }
        }
    }
}

#[tauri::command]
pub fn get_sessions(source: String, project_id: String) -> Result<Vec<SessionIndexEntry>, String> {
    let mut sessions = match source.as_str() {
        "claude" => claude::get_sessions(&project_id)?,
        "codex" => codex::get_sessions(&project_id)?,
        _ => return Err(format!("Unknown source: {}", source)),
    };

    merge_session_metadata(&source, &project_id, &mut sessions);

    Ok(sessions)
}

#[tauri::command]
pub fn refresh_sessions_cache(
    source: String,
    project_id: String,
) -> Result<Vec<SessionIndexEntry>, String> {
    let mut sessions = match source.as_str() {
        "claude" => claude::refresh_sessions_cache(&project_id)?,
        "codex" => codex::refresh_sessions_cache(&project_id)?,
        _ => return Err(format!("Unknown source: {}", source)),
    };

    merge_session_metadata(&source, &project_id, &mut sessions);

    Ok(sessions)
}

#[tauri::command]
pub fn get_invalid_sessions(
    source: String,
    project_id: String,
) -> Result<Vec<SessionIndexEntry>, String> {
    let mut sessions = match source.as_str() {
        "claude" => claude::get_invalid_sessions(&project_id)?,
        "codex" => codex::get_invalid_sessions(&project_id)?,
        _ => return Err(format!("Unknown source: {}", source)),
    };

    merge_session_metadata(&source, &project_id, &mut sessions);

    Ok(sessions)
}

#[tauri::command]
pub fn delete_session(
    file_path: String,
    source: String,
    project_id: String,
    session_id: String,
) -> Result<(), String> {
    // Reject paths that aren't an actual `.jsonl` under the source's
    // allowed root, plus session_ids with path-traversal characters. Without
    // this, the frontend (or anything that can talk to Tauri's IPC) could
    // hand us a path like `~/.ssh/id_rsa` and we'd happily move it to the
    // recycle bin.
    let path = validate_session_file(&source, &file_path)?;
    validate_session_id(&session_id)?;

    // 移入回收站而非直接删除
    recyclebin::move_to_recyclebin(
        &path,
        "session",
        "ManualDelete",
        &source,
        &project_id,
        None,
        None,
    )?;

    // Clean up metadata
    let _ = metadata::remove_session_meta(&source, &project_id, &session_id);
    if source == "claude" {
        claude::invalidate_cache();
    } else if source == "codex" {
        codex::invalidate_sessions_cache();
    }

    Ok(())
}

#[tauri::command]
pub fn update_session_meta(
    source: String,
    project_id: String,
    session_id: String,
    alias: Option<String>,
    tags: Vec<String>,
    file_path: Option<String>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    if source == "claude" {
        // Write alias to JSONL (same format as CC /rename). Only honor the
        // path if it resolves into the Claude projects directory, so a
        // misbehaving caller can't trick us into appending lines to e.g.
        // `~/.bashrc` via the alias write.
        if let Some(ref fp) = file_path {
            let path = validate_session_file(&source, fp)?;
            session_core::parser::jsonl::append_custom_title(
                &path,
                &session_id,
                alias.as_deref(),
            )?;
        }
        // Only persist tags to metadata (alias is now in JSONL for Claude)
        let result = metadata::update_session_meta(&source, &project_id, &session_id, None, tags);
        claude::invalidate_cache();
        result
    } else {
        let result = metadata::update_session_meta(&source, &project_id, &session_id, alias, tags);
        codex::invalidate_sessions_cache();
        result
    }
}

#[tauri::command]
pub fn rename_chat_session(
    source: String,
    project_path: String,
    session_id: String,
    alias: Option<String>,
) -> Result<(), String> {
    metadata::rename_chat_session(&source, &project_path, &session_id, alias.as_deref())?;
    if source == "claude" {
        claude::invalidate_cache();
    } else if source == "codex" {
        codex::invalidate_sessions_cache();
    }
    Ok(())
}

#[tauri::command]
pub fn get_all_tags(source: String, project_id: String) -> Result<Vec<String>, String> {
    Ok(metadata::get_all_tags(&source, &project_id))
}

#[tauri::command]
pub fn get_cross_project_tags(
    source: String,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    Ok(metadata::get_all_cross_project_tags(&source))
}
