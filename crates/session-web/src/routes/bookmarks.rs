use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use session_core::bookmarks::{self, Bookmark};

#[derive(Deserialize)]
pub struct ListQuery {
    pub source: Option<String>,
}

pub async fn list_bookmarks(Query(params): Query<ListQuery>) -> Result<Json<Vec<Bookmark>>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || bookmarks::list_bookmarks(params.source.as_deref()))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error))
}

pub async fn add_bookmark(
    Json(bookmark): Json<Bookmark>,
) -> Result<Json<Bookmark>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || bookmarks::add_bookmark(bookmark))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))
}

pub async fn remove_bookmark(Path(id): Path<String>) -> Result<Json<()>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || bookmarks::remove_bookmark(&id))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .map_err(|e| (StatusCode::NOT_FOUND, e))
}
