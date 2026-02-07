use std::path::Path;

use crate::models::message::PaginatedMessages;
use crate::provider::{claude, codex};

#[tauri::command]
pub fn get_messages(
    source: String,
    file_path: String,
    page: usize,
    page_size: usize,
) -> Result<PaginatedMessages, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("Session file not found: {}", file_path));
    }

    match source.as_str() {
        "claude" => claude::parse_session_messages(path, page, page_size),
        "codex" => codex::parse_session_messages(path, page, page_size),
        _ => Err(format!("Unknown source: {}", source)),
    }
}
