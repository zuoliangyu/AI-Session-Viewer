use crate::models::message::PaginatedMessages;
use crate::parser::jsonl::parse_session_messages;
use crate::parser::path_encoder::get_projects_dir;

#[tauri::command]
pub fn get_messages(
    encoded_name: String,
    session_id: String,
    page: usize,
    page_size: usize,
) -> Result<PaginatedMessages, String> {
    let projects_dir = get_projects_dir().ok_or("Could not find Claude projects directory")?;
    let session_path = projects_dir
        .join(&encoded_name)
        .join(format!("{}.jsonl", session_id));

    if !session_path.exists() {
        return Err(format!("Session file not found: {}", session_id));
    }

    parse_session_messages(&session_path, page, page_size)
}
