use axum::extract::Query;
use axum::response::Json;
use axum::http::StatusCode;
use serde::Deserialize;
use session_core::models::project::ProjectEntry;
use session_core::provider::{claude, codex};

#[derive(Deserialize)]
pub struct ProjectsQuery {
    pub source: String,
}

pub async fn get_projects(
    Query(params): Query<ProjectsQuery>,
) -> Result<Json<Vec<ProjectEntry>>, (StatusCode, String)> {
    let source = params.source;
    let result = tokio::task::spawn_blocking(move || match source.as_str() {
        "claude" => claude::get_projects(),
        "codex" => codex::get_projects(),
        _ => Err(format!("Unknown source: {}", source)),
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectQuery {
    pub source: String,
    pub project_id: String,
}

pub async fn delete_project(
    Query(params): Query<DeleteProjectQuery>,
) -> Result<Json<()>, (StatusCode, String)> {
    let source = params.source;
    let project_id = params.project_id;
    let res = tokio::task::spawn_blocking(move || match source.as_str() {
        "claude" => claude::delete_project(&project_id),
        _ => Err(format!("Delete project not supported for source: {}", source)),
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match res {
        Ok(()) => Ok(Json(())),
        Err(e) if e.contains("not found") => Err((StatusCode::NOT_FOUND, e)),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAliasBody {
    pub source: String,
    pub project_id: String,
    pub alias: Option<String>,
}

pub async fn set_project_alias(
    axum::Json(body): axum::Json<SetAliasBody>,
) -> Result<axum::Json<()>, (StatusCode, String)> {
    let res = tokio::task::spawn_blocking(move || {
        match body.source.as_str() {
            "claude" => claude::set_project_alias(&body.project_id, body.alias),
            _ => Err(format!("set_project_alias not supported for source: {}", body.source)),
        }
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match res {
        Ok(()) => Ok(axum::Json(())),
        Err(e) if e.contains("not found") => Err((StatusCode::NOT_FOUND, e)),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    }
}
