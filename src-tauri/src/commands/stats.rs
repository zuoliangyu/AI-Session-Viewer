use session_core::models::stats::{
    ProjectCostEntry, RequestLogPage, SessionCostSummary, TokenUsageSummary,
};
use session_core::stats::{self, RequestLogFilter};

#[tauri::command]
pub fn get_stats(source: String) -> Result<TokenUsageSummary, String> {
    stats::get_stats(&source)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn get_request_log(
    source: String,
    project_id: Option<String>,
    session_id: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    model: Option<String>,
    page: Option<usize>,
    page_size: Option<usize>,
) -> Result<RequestLogPage, String> {
    let filter = RequestLogFilter {
        source,
        project_id: project_id.filter(|s| !s.is_empty()),
        session_id: session_id.filter(|s| !s.is_empty()),
        start_date: start_date.filter(|s| !s.is_empty()),
        end_date: end_date.filter(|s| !s.is_empty()),
        model: model.filter(|s| !s.is_empty()),
    };
    stats::get_request_log(filter, page.unwrap_or(0), page_size.unwrap_or(200))
}

#[tauri::command]
pub fn get_project_costs(source: String) -> Result<Vec<ProjectCostEntry>, String> {
    stats::get_project_costs(&source)
}

#[tauri::command]
pub fn get_session_cost(source: String, file_path: String) -> Result<SessionCostSummary, String> {
    stats::get_session_cost(&source, &file_path)
}
