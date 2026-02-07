use crate::models::project::ProjectEntry;
use crate::provider::{claude, codex};

#[tauri::command]
pub fn get_projects(source: String) -> Result<Vec<ProjectEntry>, String> {
    match source.as_str() {
        "claude" => claude::get_projects(),
        "codex" => codex::get_projects(),
        _ => Err(format!("Unknown source: {}", source)),
    }
}
