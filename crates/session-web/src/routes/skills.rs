use axum::body::Bytes;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use session_core::models::skill::{ImportResult, SkillsResult};
use session_core::skills;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsQuery {
    #[serde(default)]
    pub project_path: Option<String>,
}

pub async fn list_skills(
    Query(params): Query<SkillsQuery>,
) -> Result<Json<SkillsResult>, (StatusCode, String)> {
    let project_path = params.project_path;
    let result = tokio::task::spawn_blocking(move || skills::scan_skills(project_path))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct SkillContentQuery {
    pub path: String,
}

pub async fn get_skill_content(
    Query(params): Query<SkillContentQuery>,
) -> Result<String, (StatusCode, String)> {
    let path = params.path;
    let result = tokio::task::spawn_blocking(move || skills::read_skill_content(&path))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match result {
        Ok(content) => Ok(content),
        Err(e) if e.contains("not found") => Err((StatusCode::NOT_FOUND, e)),
        Err(e) => Err((StatusCode::BAD_REQUEST, e)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkillQuery {
    pub scope: String,
    #[serde(default)]
    pub project_path: Option<String>,
    pub slug: String,
}

pub async fn delete_skill(
    Query(params): Query<DeleteSkillQuery>,
) -> Result<Json<()>, (StatusCode, String)> {
    let res = tokio::task::spawn_blocking(move || {
        skills::delete_skill(&params.scope, params.project_path.as_deref(), &params.slug)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match res {
        Ok(()) => Ok(Json(())),
        Err(e) if e.contains("不存在") => Err((StatusCode::NOT_FOUND, e)),
        Err(e) => Err((StatusCode::BAD_REQUEST, e)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillsQuery {
    pub scope: String,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub archive_name: Option<String>,
}

/// Raw zip bytes are sent as the request body (Content-Type
/// application/octet-stream); metadata travels in the query string. `Bytes`
/// must be the final extractor since it consumes the body.
pub async fn import_skills(
    Query(params): Query<ImportSkillsQuery>,
    body: Bytes,
) -> Result<Json<ImportResult>, (StatusCode, String)> {
    let res = tokio::task::spawn_blocking(move || {
        skills::import_skills_from_bytes(
            &body,
            &params.scope,
            params.project_path.as_deref(),
            params.overwrite,
            params.archive_name.as_deref(),
        )
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    res.map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}
