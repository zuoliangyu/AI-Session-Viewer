use std::fs;

use session_core::metadata;
use session_core::models::session::SessionIndexEntry;
use session_core::provider::{claude, codex};

#[tauri::command]
pub fn get_sessions(source: String, project_id: String) -> Result<Vec<SessionIndexEntry>, String> {
    let mut sessions = match source.as_str() {
        "claude" => claude::get_sessions(&project_id)?,
        "codex" => codex::get_sessions(&project_id)?,
        _ => return Err(format!("Unknown source: {}", source)),
    };

    // Merge tags from metadata; alias comes from JSONL (Claude) or metadata (Codex)
    let meta = metadata::load_metadata(&source, &project_id);
    for session in &mut sessions {
        if let Some(sm) = meta.sessions.get(&session.session_id) {
            if source == "claude" {
                // For Claude: alias is in JSONL (loaded in provider), only merge tags
                if !sm.tags.is_empty() {
                    session.tags = Some(sm.tags.clone());
                }
            } else {
                // For Codex: keep alias+tags from metadata
                session.alias = sm.alias.clone();
                if !sm.tags.is_empty() {
                    session.tags = Some(sm.tags.clone());
                }
            }
        }
    }

    Ok(sessions)
}

#[tauri::command]
pub fn delete_session(
    file_path: String,
    source: String,
    project_id: String,
    session_id: String,
) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    fs::remove_file(path).map_err(|e| format!("Failed to delete session: {}", e))?;

    // Clean up metadata
    let _ = metadata::remove_session_meta(&source, &project_id, &session_id);

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
    if source == "claude" {
        // Write alias to JSONL (same format as CC /rename)
        if let Some(ref fp) = file_path {
            let path = std::path::Path::new(fp);
            if path.exists() {
                session_core::parser::jsonl::append_custom_title(
                    path,
                    &session_id,
                    alias.as_deref(),
                )?;
            }
        }
        // Only persist tags to metadata (alias is now in JSONL for Claude)
        metadata::update_session_meta(&source, &project_id, &session_id, None, tags)
    } else {
        metadata::update_session_meta(&source, &project_id, &session_id, alias, tags)
    }
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
