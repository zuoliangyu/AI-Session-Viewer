use session_core::models::project::ProjectEntry;
use session_core::provider::{claude, codex};

#[tauri::command]
pub fn get_projects(source: String) -> Result<Vec<ProjectEntry>, String> {
    match source.as_str() {
        "claude" => claude::get_projects(),
        "codex" => codex::get_projects(),
        _ => Err(format!("Unknown source: {}", source)),
    }
}

#[tauri::command]
pub fn delete_project(
    source: String,
    project_id: String,
    delete_source: bool,
) -> Result<(), String> {
    match source.as_str() {
        "claude" => claude::delete_project(&project_id, delete_source),
        _ => Err(format!("Delete project not supported for source: {}", source)),
    }
}

#[tauri::command]
pub fn check_project_source_status(
    source: String,
    project_id: String,
) -> Result<claude::ProjectSourceStatus, String> {
    match source.as_str() {
        "claude" => claude::check_project_source_status(&project_id),
        _ => Err(format!(
            "check_project_source_status not supported for source: {}",
            source
        )),
    }
}

#[tauri::command]
pub fn set_project_alias(
    source: String,
    project_id: String,
    alias: Option<String>,
) -> Result<(), String> {
    match source.as_str() {
        "claude" => claude::set_project_alias(&project_id, alias),
        _ => Err(format!("set_project_alias not supported for source: {}", source)),
    }
}
