use session_core::pricing_sync::{self, PricingStatus};

#[tauri::command]
pub async fn get_pricing_status() -> Result<PricingStatus, String> {
    tauri::async_runtime::spawn_blocking(pricing_sync::status)
        .await
        .map_err(|error| format!("价格状态读取任务失败: {error}"))
}

#[tauri::command]
pub async fn set_pricing_auto_update(enabled: bool) -> Result<PricingStatus, String> {
    tauri::async_runtime::spawn_blocking(move || pricing_sync::set_auto_update(enabled))
        .await
        .map_err(|error| format!("价格设置保存任务失败: {error}"))?
}

#[tauri::command]
pub async fn refresh_pricing() -> Result<PricingStatus, String> {
    pricing_sync::refresh_now().await
}
