use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use session_core::models::message::PaginatedMessages;
use session_core::provider::{claude, codex};

use crate::resolve_session_file_path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesQuery {
    pub source: String,
    pub file_path: String,
    #[serde(default)]
    pub page: usize,
    #[serde(default = "default_page_size")]
    pub page_size: usize,
    #[serde(default)]
    pub from_end: bool,
}

fn default_page_size() -> usize {
    50
}

pub async fn get_messages(
    Query(params): Query<MessagesQuery>,
) -> Result<Json<PaginatedMessages>, (StatusCode, String)> {
    let source = params.source;
    let resolved_path = resolve_session_file_path(&source, &params.file_path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let page = params.page;
    let page_size = params.page_size;
    let from_end = params.from_end;

    let result = tokio::task::spawn_blocking(move || {
        match source.as_str() {
            "claude" => {
                claude::parse_session_messages(&resolved_path, page, page_size, from_end)
            }
            "codex" => codex::parse_session_messages(&resolved_path, page, page_size, from_end),
            _ => Err(format!("Unknown source: {}", source)),
        }
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(result))
}
