use axum::http::StatusCode;
use axum::response::Json;
use serde::Deserialize;
use session_core::pricing_sync::{self, PricingStatus};

pub async fn get_status() -> Result<Json<PricingStatus>, (StatusCode, String)> {
    tokio::task::spawn_blocking(pricing_sync::status)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

#[derive(Deserialize)]
pub struct AutoUpdateBody {
    pub enabled: bool,
}

pub async fn set_auto_update(
    Json(body): Json<AutoUpdateBody>,
) -> Result<Json<PricingStatus>, (StatusCode, String)> {
    let status = tokio::task::spawn_blocking(move || pricing_sync::set_auto_update(body.enabled))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(status))
}

pub async fn refresh() -> Result<Json<PricingStatus>, (StatusCode, String)> {
    pricing_sync::refresh_now()
        .await
        .map(Json)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}
