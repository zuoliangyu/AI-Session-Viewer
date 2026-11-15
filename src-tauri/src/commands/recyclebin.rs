use session_core::provider::claude;
use session_core::recyclebin::{self, RecycledItem};

#[tauri::command]
pub async fn list_recycled_items() -> Result<Vec<RecycledItem>, String> {
    tauri::async_runtime::spawn_blocking(recyclebin::list_items)
        .await
        .map_err(|error| format!("Failed to list recycle bin items: {error}"))?
}

#[tauri::command]
pub async fn restore_recycled_item(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || recyclebin::restore_item(&id))
        .await
        .map_err(|error| format!("Recycle bin restore task failed: {error}"))?
}

#[tauri::command]
pub async fn permanently_delete_recycled_item(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || recyclebin::permanently_delete_item(&id))
        .await
        .map_err(|error| format!("Recycle bin delete task failed: {error}"))?
}

#[tauri::command]
pub async fn empty_recyclebin() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(recyclebin::empty_recyclebin)
        .await
        .map_err(|error| format!("Recycle bin cleanup task failed: {error}"))?
}

#[tauri::command]
pub async fn cleanup_orphan_dirs(source: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || match source.as_str() {
        "claude" => claude::cleanup_all_orphan_dirs(),
        "codex" => session_core::provider::codex::cleanup_all_orphan_dirs(),
        _ => Err(format!(
            "Orphan dir cleanup not supported for source: {}",
            source
        )),
    })
    .await
    .map_err(|error| format!("Orphan directory scan task failed: {error}"))?
}
