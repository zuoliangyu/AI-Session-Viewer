use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use session_core::metadata;
use session_core::models::session::SessionIndexEntry;
use session_core::provider::{claude, codex};

use crate::{resolve_claude_project_dir, resolve_session_file_path, SessionSource};

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
    let source_kind = SessionSource::parse(&source)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    if source_kind == SessionSource::Claude {
        resolve_claude_project_dir(&project_id)
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }

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
    let source = params
        .source
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "source is required".to_string()))?;
    let source_kind = SessionSource::parse(&source)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let resolved_path = resolve_session_file_path(&source, &params.file_path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let project_id = params.project_id;
    let session_id = params.session_id;

    match source_kind {
        SessionSource::Claude => {
            if let Some(ref pid) = project_id {
                let project_dir = resolve_claude_project_dir(pid)
                    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
                let parent = resolved_path
                    .parent()
                    .ok_or_else(|| {
                        (StatusCode::BAD_REQUEST, "Invalid session file path".to_string())
                    })?;
                if parent != project_dir.as_path() {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session file does not belong to the requested project".to_string(),
                    ));
                }
            }

            if let Some(ref sid) = session_id {
                let file_stem = resolved_path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .ok_or_else(|| {
                        (StatusCode::BAD_REQUEST, "Invalid session file name".to_string())
                    })?;
                if file_stem != sid {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session id does not match the requested Claude session file".to_string(),
                    ));
                }
            }
        }
        SessionSource::Codex => {
            let session_meta = codex::extract_session_meta(&resolved_path)
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        "Failed to read Codex session metadata".to_string(),
                    )
                })?;

            if let Some(ref pid) = project_id {
                if session_meta.cwd != *pid {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session file does not belong to the requested Codex project".to_string(),
                    ));
                }
            }

            if let Some(ref sid) = session_id {
                if session_meta.id != *sid {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session id does not match the requested Codex session file".to_string(),
                    ));
                }
            }
        }
    }

    tokio::task::spawn_blocking(move || {
        std::fs::remove_file(&resolved_path)
            .map_err(|e| format!("Failed to delete session: {}", e))?;

        // Clean up metadata if identifiers provided
        if let (Some(pid), Some(sid)) = (project_id, session_id) {
            let _ = metadata::remove_session_meta(&source, &pid, &sid);
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
    let source_kind = SessionSource::parse(&body.source)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    if source_kind == SessionSource::Claude {
        resolve_claude_project_dir(&body.project_id)
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }

    let validated_file_path = if source_kind == SessionSource::Claude {
        body.file_path
            .as_deref()
            .map(|file_path| {
                let resolved = resolve_session_file_path(&body.source, file_path)
                    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
                let project_dir = resolve_claude_project_dir(&body.project_id)
                    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
                let parent = resolved.parent().ok_or_else(|| {
                    (StatusCode::BAD_REQUEST, "Invalid session file path".to_string())
                })?;
                if parent != project_dir.as_path() {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session file does not belong to the requested project".to_string(),
                    ));
                }
                let file_stem = resolved.file_stem().and_then(|stem| stem.to_str()).ok_or_else(
                    || (StatusCode::BAD_REQUEST, "Invalid session file name".to_string()),
                )?;
                if file_stem != body.session_id {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session id does not match the requested Claude session file".to_string(),
                    ));
                }
                Ok(resolved)
            })
            .transpose()?
    } else {
        None
    };

    tokio::task::spawn_blocking(move || {
        if body.source == "claude" {
            if let Some(path) = validated_file_path.as_deref() {
                session_core::parser::jsonl::append_custom_title(
                    path,
                    &body.session_id,
                    body.alias.as_deref(),
                )?;
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
