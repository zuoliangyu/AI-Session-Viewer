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
pub fn delete_project(source: String, project_id: String) -> Result<(), String> {
    match source.as_str() {
        "claude" => claude::delete_project(&project_id),
        _ => Err(format!("Delete project not supported for source: {}", source)),
    }
}
