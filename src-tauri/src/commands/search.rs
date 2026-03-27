use session_core::search::{SearchResult, SearchScope};

#[tauri::command]
pub fn global_search(
    source: String,
    query: String,
    max_results: usize,
    scope: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    session_core::search::global_search(
        &source,
        &query,
        max_results,
        SearchScope::from_query(scope.as_deref().unwrap_or("all")),
    )
}
