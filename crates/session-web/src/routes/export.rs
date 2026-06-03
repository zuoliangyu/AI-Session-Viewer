use axum::extract::Query;
use axum::http::StatusCode;
use serde::Deserialize;
use session_core::export::{render_session, ExportFormat};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportQuery {
    pub source: String,
    pub file_path: String,
    pub format: String,
}

/// 渲染单个会话为 JSON / Markdown / HTML，正文即导出内容（text/plain）。
/// 文件名由前端决定，浏览器侧用 Blob 触发下载。
pub async fn export_session(
    Query(params): Query<ExportQuery>,
) -> Result<String, (StatusCode, String)> {
    let fmt = ExportFormat::parse(&params.format).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let source = params.source;
    let file_path = params.file_path;

    tokio::task::spawn_blocking(move || render_session(&source, &file_path, fmt))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}
