use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use session_core::metadata;
use session_core::models::session::SessionIndexEntry;
use session_core::provider::{claude, codex};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsQuery {
    pub source: String,
    pub project_id: String,
}

pub async fn get_sessions(
    Query(params): Query<SessionsQuery>,
) -> Result<Json<Vec<SessionIndexEntry>>, (StatusCode, String)> {
    let source = params.source;
    let project_id = params.project_id;
    let result = tokio::task::spawn_blocking(move || {
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

        Ok(sessions)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteQuery {
    pub file_path: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

pub async fn delete_session(
    Query(params): Query<DeleteQuery>,
) -> Result<Json<()>, (StatusCode, String)> {
    let file_path = params.file_path;
    let source = params.source;
    let project_id = params.project_id;
    let session_id = params.session_id;
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&file_path);
        if !path.exists() {
            return Err(format!("File not found: {}", file_path));
        }
        std::fs::remove_file(path).map_err(|e| format!("Failed to delete session: {}", e))?;

        // Clean up metadata if identifiers provided
        if let (Some(src), Some(pid), Some(sid)) = (source, project_id, session_id) {
            let _ = metadata::remove_session_meta(&src, &pid, &sid);
        }

        Ok(())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetaBody {
    pub source: String,
    pub project_id: String,
    pub session_id: String,
    pub alias: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub file_path: Option<String>,
}

pub async fn update_session_meta(
    Json(body): Json<UpdateMetaBody>,
) -> Result<Json<()>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || {
        if body.source == "claude" {
            if let Some(ref fp) = body.file_path {
                let path = std::path::Path::new(fp);
                if path.exists() {
                    session_core::parser::jsonl::append_custom_title(
                        path,
                        &body.session_id,
                        body.alias.as_deref(),
                    )?;
                }
            }
            metadata::update_session_meta(
                &body.source,
                &body.project_id,
                &body.session_id,
                None,
                body.tags,
            )
        } else {
            metadata::update_session_meta(
                &body.source,
                &body.project_id,
                &body.session_id,
                body.alias,
                body.tags,
            )
        }
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagsQuery {
    pub source: String,
    pub project_id: String,
}

pub async fn get_all_tags(
    Query(params): Query<TagsQuery>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let source = params.source;
    let project_id = params.project_id;
    let tags = tokio::task::spawn_blocking(move || metadata::get_all_tags(&source, &project_id))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(tags))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossTagsQuery {
    pub source: String,
}

pub async fn get_cross_project_tags(
    Query(params): Query<CrossTagsQuery>,
) -> Result<Json<std::collections::HashMap<String, Vec<String>>>, (StatusCode, String)> {
    let source = params.source;
    let result =
        tokio::task::spawn_blocking(move || metadata::get_all_cross_project_tags(&source))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(result))
}
