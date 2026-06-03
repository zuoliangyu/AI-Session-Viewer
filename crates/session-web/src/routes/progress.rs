use axum::response::Json;
use session_core::scan_progress::{self, ScanProgress};

/// 返回当前冷启动扫描进度。前端在加载态下轮询此接口显示进度条。
pub async fn get_scan_progress() -> Json<ScanProgress> {
    Json(scan_progress::snapshot())
}
