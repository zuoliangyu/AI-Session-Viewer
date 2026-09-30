use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use session_core::metadata;
use session_core::models::session::SessionIndexEntry;
use session_core::provider::{claude, codex, grok, omp};

use crate::{resolve_claude_project_dir, resolve_session_file_path, SessionSource};

pub async fn fork_session(
    Json(request): Json<session_core::fork::ForkRequest>,
) -> Result<Json<session_core::fork::ForkResult>, (StatusCode, String)> {
    session_core::fork::fork_session(request)
        .await
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, error))
}

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
    let source_kind = SessionSource::parse(&source).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    if source_kind == SessionSource::Claude {
        resolve_claude_project_dir(&project_id).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }

    let result = tokio::task::spawn_blocking(move || {
        let mut sessions = match source.as_str() {
            "claude" => claude::get_sessions(&project_id)?,
            "codex" => codex::get_sessions(&project_id)?,
            "grok" => grok::get_sessions(&project_id)?,
            "omp" => omp::get_sessions(&project_id)?,
            _ => return Err(format!("Unknown source: {}", source)),
        };

        metadata::merge_into_sessions(&source, &project_id, &mut sessions);

        Ok(sessions)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(result))
}

pub async fn get_invalid_sessions(
    Query(params): Query<SessionsQuery>,
) -> Result<Json<Vec<SessionIndexEntry>>, (StatusCode, String)> {
    let source = params.source;
    let project_id = params.project_id;
    let source_kind = SessionSource::parse(&source).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    if source_kind == SessionSource::Claude {
        resolve_claude_project_dir(&project_id).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    }

    let result = tokio::task::spawn_blocking(move || {
        let mut sessions = match source.as_str() {
            "claude" => claude::get_invalid_sessions(&project_id)?,
            "codex" => codex::get_invalid_sessions(&project_id)?,
            "grok" => grok::get_invalid_sessions(&project_id)?,
            "omp" => omp::get_invalid_sessions(&project_id)?,
            _ => return Err(format!("Unknown source: {}", source)),
        };

        metadata::merge_into_sessions(&source, &project_id, &mut sessions);

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
    let source_kind = SessionSource::parse(&source).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let project_id = params.project_id;
    let session_id = params.session_id;

    let resolved_path = match resolve_session_file_path(&source, &params.file_path) {
        Ok(path) => path,
        // The rollout file is already gone — e.g. the conversation was archived
        // or deleted in Codex desktop while it still lingered in our cache.
        // Treat this as an idempotent delete: purge the stale metadata + cache
        // so the ghost entry disappears from the list, then return success.
        // Any other validation failure (wrong extension, path outside the
        // allowed root) is still surfaced as a 400.
        Err(_) if !std::path::Path::new(&params.file_path).exists() => {
            if let (Some(pid), Some(sid)) = (project_id.as_ref(), session_id.as_ref()) {
                let _ = metadata::remove_session_meta(&source, pid, sid);
            }
            session_core::recyclebin::invalidate_source_cache(&source);
            return Ok(Json(()));
        }
        Err(e) => return Err((StatusCode::BAD_REQUEST, e)),
    };

    match source_kind {
        SessionSource::Claude => {
            if let Some(ref pid) = project_id {
                let project_dir =
                    resolve_claude_project_dir(pid).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
                let parent = resolved_path.parent().ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        "Invalid session file path".to_string(),
                    )
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
                        (
                            StatusCode::BAD_REQUEST,
                            "Invalid session file name".to_string(),
                        )
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
            let session_meta = codex::extract_session_meta(&resolved_path).ok_or_else(|| {
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
        SessionSource::Grok => {
            let session_meta = grok::extract_session_meta(&resolved_path).ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    "Failed to read Grok session metadata".to_string(),
                )
            })?;

            if let Some(ref pid) = project_id {
                if session_meta.cwd.as_deref().unwrap_or("<grok-unrooted>") != pid {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session file does not belong to the requested Grok project".to_string(),
                    ));
                }
            }

            if let Some(ref sid) = session_id {
                if session_meta.id != *sid {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session id does not match the requested Grok session file".to_string(),
                    ));
                }
            }
        }
        SessionSource::Omp => {
            let session_meta = omp::extract_session_meta(&resolved_path).ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    "Failed to read OMP session metadata".to_string(),
                )
            })?;
            if let Some(ref pid) = project_id {
                if session_meta.cwd != *pid {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session file does not belong to the requested OMP project".to_string(),
                    ));
                }
            }
            if let Some(ref sid) = session_id {
                if session_meta.id != *sid {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session id does not match the requested OMP session file".to_string(),
                    ));
                }
            }
        }
    }

    tokio::task::spawn_blocking(move || {
        // Match desktop behavior: recoverable recycle-bin move, not a hard delete.
        session_core::recyclebin::recycle_session(
            &source,
            &resolved_path,
            project_id.as_deref().unwrap_or(""),
        )?;

        // Clean up metadata if identifiers provided
        if let (Some(pid), Some(sid)) = (project_id, session_id) {
            let _ = metadata::remove_session_meta(&source, &pid, &sid);
        }
        session_core::recyclebin::invalidate_source_cache(&source);

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
    let source_kind =
        SessionSource::parse(&body.source).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    if source_kind == SessionSource::Claude {
        resolve_claude_project_dir(&body.project_id).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
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
                    (
                        StatusCode::BAD_REQUEST,
                        "Invalid session file path".to_string(),
                    )
                })?;
                if parent != project_dir.as_path() {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Session file does not belong to the requested project".to_string(),
                    ));
                }
                let file_stem = resolved
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .ok_or_else(|| {
                        (
                            StatusCode::BAD_REQUEST,
                            "Invalid session file name".to_string(),
                        )
                    })?;
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
pub struct RenameChatBody {
    pub source: String,
    pub project_path: String,
    pub session_id: String,
    pub alias: Option<String>,
}

pub async fn rename_chat_session(
    Json(body): Json<RenameChatBody>,
) -> Result<Json<()>, (StatusCode, String)> {
    SessionSource::parse(&body.source).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    tokio::task::spawn_blocking(move || {
        metadata::rename_chat_session(
            &body.source,
            &body.project_path,
            &body.session_id,
            body.alias.as_deref(),
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

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
    let result = tokio::task::spawn_blocking(move || metadata::get_all_cross_project_tags(&source))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(result))
}
