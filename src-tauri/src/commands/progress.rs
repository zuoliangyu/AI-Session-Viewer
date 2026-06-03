use session_core::scan_progress::{self, ScanProgress};

/// 返回当前冷启动扫描进度。前端在加载态下轮询此命令显示进度条。
#[tauri::command]
pub fn get_scan_progress() -> ScanProgress {
    scan_progress::snapshot()
}
