use session_core::provider_sync::{
    self, ProviderSyncStatus, RestoreOptions, RestoreResult, SyncResult,
};

#[tauri::command]
pub async fn provider_sync_status() -> Result<ProviderSyncStatus, String> {
    tokio::task::spawn_blocking(provider_sync::get_status)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn provider_sync_run(
    provider: Option<String>,
    keep: Option<usize>,
) -> Result<SyncResult, String> {
    let keep = keep.unwrap_or(5);
    tokio::task::spawn_blocking(move || provider_sync::run_sync(provider, keep))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn provider_sync_switch(
    provider: String,
    keep: Option<usize>,
) -> Result<SyncResult, String> {
    let keep = keep.unwrap_or(5);
    tokio::task::spawn_blocking(move || provider_sync::run_switch(provider, keep))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn provider_sync_restore(
    backup_dir: String,
    options: Option<RestoreOptions>,
) -> Result<RestoreResult, String> {
    let opts = options.unwrap_or(RestoreOptions {
        include_config: true,
        include_db: true,
        include_sessions: true,
        include_global_state: true,
    });
    tokio::task::spawn_blocking(move || provider_sync::run_restore(&backup_dir, opts))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn provider_sync_prune(keep: Option<usize>) -> Result<u32, String> {
    let keep = keep.unwrap_or(5);
    tokio::task::spawn_blocking(move || provider_sync::run_prune_backups(keep))
        .await
        .map_err(|e| e.to_string())?
}
