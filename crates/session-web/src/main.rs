mod chat_ws;
mod config;
mod routes;
mod static_files;
mod ws;

use axum::{
    extract::Request,
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, post, put},
    Json, Router,
};
use futures_util::StreamExt;
use clap::Parser;
use config::Config;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub(crate) struct AppToken(pub(crate) Option<String>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionSource {
    Claude,
    Codex,
}

impl SessionSource {
    pub(crate) fn parse(source: &str) -> Result<Self, String> {
        match source {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err(format!("Unknown source: {}", source)),
        }
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
}

pub(crate) fn require_auth(
    headers: &HeaderMap,
    expected: &AppToken,
) -> Result<(), StatusCode> {
    require_auth_with_query(headers, None, expected)
}

pub(crate) fn require_auth_with_query(
    headers: &HeaderMap,
    query_token: Option<&str>,
    expected: &AppToken,
) -> Result<(), StatusCode> {
    let Some(expected_token) = expected.0.as_deref() else {
        return Ok(());
    };

    if bearer_token(headers) == Some(expected_token) || query_token == Some(expected_token) {
        return Ok(());
    }

    Err(StatusCode::UNAUTHORIZED)
}

fn canonicalize_dir(path: PathBuf, label: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {}: {}", label, e))?;

    if !canonical.is_dir() {
        return Err(format!("{} is not a directory", label));
    }

    Ok(canonical)
}

fn canonical_projects_dir() -> Result<PathBuf, String> {
    let path = session_core::parser::path_encoder::get_projects_dir()
        .ok_or_else(|| "Could not find Claude projects directory".to_string())?;
    canonicalize_dir(path, "Claude projects directory")
}

fn canonical_codex_sessions_dir() -> Result<PathBuf, String> {
    let path = session_core::provider::codex::get_sessions_dir()
        .ok_or_else(|| "Could not find Codex sessions directory".to_string())?;
    canonicalize_dir(path, "Codex sessions directory")
}

fn is_single_normal_component(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

pub(crate) fn resolve_claude_project_dir(project_id: &str) -> Result<PathBuf, String> {
    if !is_single_normal_component(project_id) {
        return Err(format!("Invalid project id: {}", project_id));
    }

    let base = canonical_projects_dir()?;
    let candidate = base.join(project_id);

    if !candidate.exists() {
        return Err(format!("Project directory not found: {}", project_id));
    }

    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project directory: {}", e))?;
    if !canonical.is_dir() {
        return Err(format!("Project directory not found: {}", project_id));
    }
    let relative = canonical
        .strip_prefix(&base)
        .map_err(|_| format!("Invalid project id: {}", project_id))?;

    if relative.components().count() != 1 {
        return Err(format!("Invalid project id: {}", project_id));
    }

    Ok(canonical)
}

fn validate_claude_session_layout(path: &Path, base: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(base)
        .map_err(|_| "Session file is outside the Claude projects directory".to_string())?;

    if relative.components().count() != 2 {
        return Err("Claude session file must live directly under a project directory".to_string());
    }

    Ok(())
}

fn validate_codex_session_layout(path: &Path, base: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(base)
        .map_err(|_| "Session file is outside the Codex sessions directory".to_string())?;
    let components: Vec<_> = relative.components().collect();

    if components.len() != 4 || components.iter().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("Codex session file must live under sessions/<year>/<month>/<day>/".to_string());
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid session file name".to_string())?;
    if !file_name.starts_with("rollout-") {
        return Err("Codex session file name must start with 'rollout-'".to_string());
    }

    Ok(())
}

pub(crate) fn resolve_session_file_path(
    source: &str,
    file_path: &str,
) -> Result<PathBuf, String> {
    if file_path.trim().is_empty() {
        return Err("Session file path is required".to_string());
    }

    let source = SessionSource::parse(source)?;
    let requested = PathBuf::from(file_path);
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("Failed to resolve session file: {}", e))?;

    if !canonical.is_file() {
        return Err(format!("Session file not found: {}", file_path));
    }
    if canonical.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return Err("Session file must be a .jsonl file".to_string());
    }

    match source {
        SessionSource::Claude => {
            let base = canonical_projects_dir()?;
            validate_claude_session_layout(&canonical, &base)?;
        }
        SessionSource::Codex => {
            let base = canonical_codex_sessions_dir()?;
            validate_codex_session_layout(&canonical, &base)?;
        }
    }

    Ok(canonical)
}

/// Auth check middleware — reads token from AppToken extension
async fn check_auth(
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let expected = request
        .extensions()
        .get::<AppToken>()
        .cloned()
        .unwrap_or(AppToken(None));
    require_auth(request.headers(), &expected)?;

    Ok(next.run(request).await)
}

async fn detect_cli_handler() -> Json<Vec<session_core::cli::CliInstallation>> {
    Json(session_core::cli::discover_installations())
}

#[derive(serde::Deserialize)]
struct CliConfigQuery {
    source: String,
}

async fn cli_config_handler(
    axum::extract::Query(query): axum::extract::Query<CliConfigQuery>,
) -> Result<Json<session_core::cli_config::CliConfig>, (StatusCode, String)> {
    session_core::cli_config::read_cli_config(&query.source)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuickChatRequest {
    source: String,
    messages: Vec<session_core::quick_chat::ChatMsg>,
    model: String,
}

#[derive(serde::Deserialize)]
struct WsAuthQuery {
    token: Option<String>,
}

enum QuickChatSseMessage {
    Chunk(String),
    Error(String),
    Done,
}

async fn quick_chat_handler(
    Json(req): Json<QuickChatRequest>,
) -> axum::response::Sse<impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>>
{
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<QuickChatSseMessage>();

    tokio::spawn(async move {
        let chunk_tx = tx.clone();
        let result = session_core::quick_chat::stream_chat(
            &req.source,
            req.messages,
            &req.model,
            |chunk| {
                let _ = chunk_tx.send(QuickChatSseMessage::Chunk(chunk.to_string()));
            },
        )
        .await;

        if let Err(e) = result {
            let err_json = serde_json::json!({ "error": e }).to_string();
            let _ = tx.send(QuickChatSseMessage::Error(err_json));
        }
        let _ = tx.send(QuickChatSseMessage::Done);
    });

    let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx).map(|message| {
        match message {
            QuickChatSseMessage::Chunk(chunk) => {
                Ok(axum::response::sse::Event::default().data(chunk))
            }
            QuickChatSseMessage::Error(err) => Ok(axum::response::sse::Event::default()
                .event("error")
                .data(err)),
            QuickChatSseMessage::Done => Ok(axum::response::sse::Event::default()
                .event("done")
                .data("[DONE]")),
        }
    });

    axum::response::Sse::new(stream)
}

async fn chat_ws_auth_handler(
    ws: axum::extract::ws::WebSocketUpgrade,
    axum::extract::Extension(app_token): axum::extract::Extension<AppToken>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<WsAuthQuery>,
) -> Result<Response, StatusCode> {
    require_auth_with_query(&headers, query.token.as_deref(), &app_token)?;
    Ok(chat_ws::chat_ws_handler(ws).await)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListModelsRequest {
    source: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    base_url: String,
}

async fn list_models_handler(
    Json(req): Json<ListModelsRequest>,
) -> Result<Json<Vec<session_core::model_list::ModelInfo>>, (StatusCode, String)> {
    session_core::model_list::list_models(&req.source, &req.api_key, &req.base_url)
        .await
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let config = Config::parse();

    // Start file watcher
    let fs_tx = ws::start_file_watcher();

    let app_token = AppToken(config.token.clone());

    // API routes (with auth middleware)
    let api_routes = Router::new()
        .route("/api/projects", get(routes::projects::get_projects))
        .route("/api/projects", delete(routes::projects::delete_project))
        .route("/api/projects/alias", put(routes::projects::set_project_alias))
        .route("/api/sessions", get(routes::sessions::get_sessions))
        .route("/api/sessions/invalid", get(routes::sessions::get_invalid_sessions))
        .route("/api/sessions", delete(routes::sessions::delete_session))
        .route(
            "/api/sessions/meta",
            put(routes::sessions::update_session_meta),
        )
        .route("/api/tags", get(routes::sessions::get_all_tags))
        .route("/api/cross-tags", get(routes::sessions::get_cross_project_tags))
        .route("/api/messages", get(routes::messages::get_messages))
        .route("/api/search", get(routes::search::global_search))
        .route("/api/stats", get(routes::stats::get_stats))
        .route("/api/bookmarks", get(routes::bookmarks::list_bookmarks))
        .route("/api/bookmarks", post(routes::bookmarks::add_bookmark))
        .route("/api/bookmarks/{id}", delete(routes::bookmarks::remove_bookmark))
        .layer(middleware::from_fn(check_auth));

    // WebSocket route (with auth via query param or header)
    let ws_routes = Router::new()
        .route("/ws", get(ws::ws_handler))
        .with_state(Arc::clone(&fs_tx));

    // Chat WebSocket route (no state needed, stateless per connection)
    let chat_ws_routes = Router::new()
        .route("/ws/chat", get(chat_ws_auth_handler));

    // CLI detection + models + config route (with auth)
    let cli_routes = Router::new()
        .route("/api/cli/detect", get(detect_cli_handler))
        .route("/api/cli/config", get(cli_config_handler))
        .route("/api/models", post(list_models_handler))
        .route("/api/quick-chat", post(quick_chat_handler))
        .layer(middleware::from_fn(check_auth));

    // Static file fallback (no auth needed)
    let static_routes = Router::new().fallback(static_files::static_handler);

    let app = Router::new()
        .merge(api_routes)
        .merge(cli_routes)
        .merge(ws_routes)
        .merge(chat_ws_routes)
        .merge(static_routes)
        .layer(CorsLayer::permissive())
        .layer(axum::Extension(app_token));

    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    tracing::info!("AI Session Viewer Web Server listening on http://{}", addr);
    if config.token.is_some() {
        tracing::info!("Authentication enabled (Bearer token required)");
    } else {
        tracing::info!("No authentication (set --token or ASV_TOKEN to enable)");
    }

    axum::serve(listener, app)
        .await
        .expect("Server error");
}
