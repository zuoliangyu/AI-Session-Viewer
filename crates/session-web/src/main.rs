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
use clap::Parser;
use config::Config;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

#[derive(Clone)]
pub(crate) struct AppToken(pub(crate) Option<String>);

/// Extra browser origins (beyond same-origin, loopback and the desktop app)
/// allowed to call the API cross-origin and open WebSockets.
#[derive(Clone)]
pub(crate) struct AllowedOrigins(pub(crate) Arc<Vec<String>>);

/// `scheme://host[:port]` → `host[:port]`.
fn origin_authority(origin: &str) -> Option<&str> {
    let (_, rest) = origin.split_once("://")?;
    Some(rest.split('/').next().unwrap_or(rest))
}

fn authority_host(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 literal: "[::1]:3000"
        return rest.split(']').next().unwrap_or(rest);
    }
    authority.rsplit_once(':').map_or(authority, |(host, _)| host)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// Origins trusted regardless of the request's Host: loopback pages (dev
/// servers), the Tauri desktop app (remote-node mode) and configured extras.
fn is_trusted_origin(origin: &str, extra: &[String]) -> bool {
    let origin = origin.trim_end_matches('/');
    if extra
        .iter()
        .any(|allowed| allowed.trim_end_matches('/').eq_ignore_ascii_case(origin))
    {
        return true;
    }
    let Some(authority) = origin_authority(origin) else {
        return false;
    };
    let host = authority_host(authority);
    is_loopback_host(host) || host.eq_ignore_ascii_case("tauri.localhost")
}

/// Reject cross-site WebSocket upgrades. Browsers don't apply CORS to
/// WebSockets, so without this any page the user visits could open
/// `/ws/chat` against a reachable server. Non-browser clients send no Origin.
pub(crate) fn check_ws_origin(
    headers: &HeaderMap,
    allowed: &AllowedOrigins,
) -> Result<(), StatusCode> {
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return Ok(());
    };
    let same_origin = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .zip(origin_authority(origin))
        .is_some_and(|(host, authority)| host.eq_ignore_ascii_case(authority));
    if same_origin || is_trusted_origin(origin, &allowed.0) {
        Ok(())
    } else {
        tracing::warn!("Rejected WebSocket upgrade from origin {origin}");
        Err(StatusCode::FORBIDDEN)
    }
}

/// Time-to-live for a freshly minted WebSocket auth ticket. Long enough for
/// a slow client to redeem, short enough that a leaked log line stops being
/// useful very quickly.
const WS_TICKET_TTL: Duration = Duration::from_secs(30);

/// Single-use, short-lived tickets used to authenticate WebSocket upgrades.
/// Browsers can't attach `Authorization: Bearer` headers to `new WebSocket`,
/// so the client mints a ticket via an authenticated POST and then includes
/// it as a query param on the upgrade request. The ticket is consumed on
/// first use, so even if it lands in a reverse-proxy access log it can't be
/// replayed.
#[derive(Clone)]
pub(crate) struct WsTicketStore {
    inner: Arc<Mutex<HashMap<String, Instant>>>,
}

impl WsTicketStore {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Mint a fresh ticket. Also opportunistically prunes expired tickets so
    /// a misbehaving client can't grow the map without bound.
    pub(crate) fn issue(&self) -> String {
        let ticket = uuid::Uuid::new_v4().to_string();
        let now = Instant::now();
        let expires = now + WS_TICKET_TTL;
        let mut guard = self.inner.lock().expect("ws ticket store poisoned");
        guard.retain(|_, exp| *exp > now);
        guard.insert(ticket.clone(), expires);
        ticket
    }

    /// Atomically consume a ticket. Returns true iff it existed and hadn't
    /// expired. Subsequent calls with the same ticket return false.
    pub(crate) fn consume(&self, ticket: &str) -> bool {
        let now = Instant::now();
        let mut guard = self.inner.lock().expect("ws ticket store poisoned");
        matches!(guard.remove(ticket), Some(exp) if exp > now)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionSource {
    Claude,
    Codex,
    Grok,
    Omp,
}

impl SessionSource {
    pub(crate) fn parse(source: &str) -> Result<Self, String> {
        match source {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "grok" => Ok(Self::Grok),
            "omp" => Ok(Self::Omp),
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

pub(crate) fn require_auth(headers: &HeaderMap, expected: &AppToken) -> Result<(), StatusCode> {
    let Some(expected_token) = expected.0.as_deref() else {
        return Ok(());
    };
    if bearer_token(headers) == Some(expected_token) {
        return Ok(());
    }
    Err(StatusCode::UNAUTHORIZED)
}

/// Authenticate a WebSocket upgrade. Either the standard Bearer header (some
/// non-browser clients can set it) or a single-use ticket (for browsers).
pub(crate) fn require_ws_auth(
    headers: &HeaderMap,
    query_ticket: Option<&str>,
    expected: &AppToken,
    tickets: &WsTicketStore,
) -> Result<(), StatusCode> {
    let Some(expected_token) = expected.0.as_deref() else {
        return Ok(());
    };

    if bearer_token(headers) == Some(expected_token) {
        return Ok(());
    }

    if let Some(ticket) = query_ticket {
        if tickets.consume(ticket) {
            return Ok(());
        }
    }

    Err(StatusCode::UNAUTHORIZED)
}

fn is_single_normal_component(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

pub(crate) fn resolve_claude_project_dir(project_id: &str) -> Result<PathBuf, String> {
    if !is_single_normal_component(project_id) {
        return Err(format!("Invalid project id: {}", project_id));
    }

    let base = session_core::parser::path_encoder::get_projects_dir()
        .ok_or_else(|| "Could not find Claude projects directory".to_string())?
        .canonicalize()
        .map_err(|e| format!("Failed to resolve Claude projects directory: {}", e))?;
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

/// Validate a session file path. Delegates to `session_core::paths` so the
/// Tauri and web codepaths share a single source of truth.
pub(crate) fn resolve_session_file_path(source: &str, file_path: &str) -> Result<PathBuf, String> {
    session_core::paths::validate_session_file(source, file_path)
}

/// Auth check middleware — reads token from AppToken extension
async fn check_auth(request: Request, next: Next) -> Result<Response, StatusCode> {
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
struct WsAuthQuery {
    /// Single-use ticket previously issued via POST /api/auth/ws-ticket.
    ticket: Option<String>,
}

#[derive(serde::Serialize)]
struct WsTicketResponse {
    ticket: String,
}

async fn issue_ws_ticket(
    axum::extract::Extension(store): axum::extract::Extension<WsTicketStore>,
) -> Json<WsTicketResponse> {
    Json(WsTicketResponse {
        ticket: store.issue(),
    })
}

async fn chat_ws_auth_handler(
    ws: axum::extract::ws::WebSocketUpgrade,
    axum::extract::Extension(app_token): axum::extract::Extension<AppToken>,
    axum::extract::Extension(tickets): axum::extract::Extension<WsTicketStore>,
    axum::extract::Extension(allowed_origins): axum::extract::Extension<AllowedOrigins>,
    axum::extract::Extension(policy): axum::extract::Extension<chat_ws::ChatPolicy>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<WsAuthQuery>,
) -> Result<Response, StatusCode> {
    check_ws_origin(&headers, &allowed_origins)?;
    require_ws_auth(&headers, query.ticket.as_deref(), &app_token, &tickets)?;
    Ok(chat_ws::chat_ws_handler(ws, policy).await)
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

/// Same-origin requests need no CORS; only trusted cross-origin callers
/// (desktop app in remote-node mode, loopback dev servers, configured extras)
/// may read API responses.
fn cors_layer(extra: Arc<Vec<String>>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin
                .to_str()
                .is_ok_and(|origin| is_trusted_origin(origin, &extra))
        }))
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers(Any)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    // 给请求处理线程留一个 CPU 核，避免冷启动并行扫描吃满 CPU。
    session_core::scan_progress::configure_rayon_pool();

    let config = Config::parse();

    let binds_loopback = is_loopback_host(config.host.trim_matches(|c| c == '[' || c == ']'));
    if !binds_loopback && config.token.is_none() && !config.allow_no_auth {
        eprintln!(
            "Refusing to listen on {} without authentication: anyone who can reach this port could read sessions and run the local CLIs.
Set --token / ASV_TOKEN, bind to 127.0.0.1, or pass --allow-no-auth to override.",
            config.host
        );
        std::process::exit(1);
    }

    // Start file watcher
    let fs_tx = ws::start_file_watcher();

    let app_token = AppToken(config.token.clone());
    let allowed_origins = AllowedOrigins(Arc::new(config.allowed_origins.clone()));
    let chat_policy = chat_ws::ChatPolicy {
        allow_skip_permissions: config.allow_skip_permissions,
        allow_client_credentials: config.allow_client_credentials,
    };
    let ws_tickets = WsTicketStore::new();

    // API routes (with auth middleware)
    let api_routes = Router::new()
        .route("/api/projects", get(routes::projects::get_projects))
        .route("/api/projects", delete(routes::projects::delete_project))
        .route(
            "/api/projects/alias",
            put(routes::projects::set_project_alias),
        )
        .route("/api/sessions", get(routes::sessions::get_sessions))
        .route("/api/sessions/fork", post(routes::sessions::fork_session))
        .route(
            "/api/sessions/invalid",
            get(routes::sessions::get_invalid_sessions),
        )
        .route("/api/sessions", delete(routes::sessions::delete_session))
        .route(
            "/api/sessions/meta",
            put(routes::sessions::update_session_meta),
        )
        .route(
            "/api/sessions/rename",
            post(routes::sessions::rename_chat_session),
        )
        .route("/api/tags", get(routes::sessions::get_all_tags))
        .route(
            "/api/cross-tags",
            get(routes::sessions::get_cross_project_tags),
        )
        .route("/api/messages", get(routes::messages::get_messages))
        .route(
            "/api/messages/range",
            get(routes::messages::get_messages_range),
        )
        .route(
            "/api/messages/questions",
            get(routes::messages::get_question_index),
        )
        .route("/api/trajectory", get(routes::trajectory::get_trajectory))
        .route("/api/export", get(routes::export::export_session))
        .route(
            "/api/scan-progress",
            get(routes::progress::get_scan_progress),
        )
        .route("/api/search", get(routes::search::global_search))
        .route("/api/skills", get(routes::skills::list_skills))
        .route("/api/skills", delete(routes::skills::delete_skill))
        .route(
            "/api/skills/content",
            get(routes::skills::get_skill_content),
        )
        .route("/api/skills/import", post(routes::skills::import_skills))
        .route(
            "/api/skills/sync-export",
            get(routes::skills::export_global_skill),
        )
        .route(
            "/api/skills/sync-apply",
            post(routes::skills::apply_global_skill),
        )
        .route(
            "/api/sync/config-manifest",
            get(routes::sync_config::get_manifest),
        )
        .route("/api/sync/mcp-apply", post(routes::sync_config::apply_mcp))
        .route("/api/stats", get(routes::stats::get_stats))
        .route("/api/stats/requests", get(routes::stats::get_request_log))
        .route("/api/stats/projects", get(routes::stats::get_project_costs))
        .route("/api/stats/session", get(routes::stats::get_session_cost))
        .route("/api/bookmarks", get(routes::bookmarks::list_bookmarks))
        .route("/api/bookmarks", post(routes::bookmarks::add_bookmark))
        .route(
            "/api/bookmarks/{id}",
            delete(routes::bookmarks::remove_bookmark),
        )
        .route("/api/recyclebin", get(routes::recyclebin::list_items))
        .route(
            "/api/recyclebin/{id}/restore",
            post(routes::recyclebin::restore_item),
        )
        .route(
            "/api/recyclebin/{id}",
            delete(routes::recyclebin::permanently_delete_item),
        )
        .route(
            "/api/recyclebin/empty",
            post(routes::recyclebin::empty_recyclebin),
        )
        .route(
            "/api/recyclebin/cleanup-orphans",
            post(routes::recyclebin::cleanup_orphan_dirs),
        )
        .route(
            "/api/provider-sync/status",
            get(routes::provider_sync::get_status),
        )
        .route("/api/provider-sync/sync", post(routes::provider_sync::sync))
        .route(
            "/api/provider-sync/switch",
            post(routes::provider_sync::switch),
        )
        .route(
            "/api/provider-sync/clone",
            post(routes::provider_sync::clone),
        )
        .route(
            "/api/provider-sync/restore",
            post(routes::provider_sync::restore),
        )
        .route(
            "/api/provider-sync/prune",
            post(routes::provider_sync::prune_backups),
        )
        // Single-use ticket endpoint — must be authenticated with the
        // standard Bearer header. Used by browsers to upgrade to WebSocket
        // without leaking the long-lived token through the URL.
        .route("/api/auth/ws-ticket", post(issue_ws_ticket))
        // Skill archive uploads can exceed the 2MB default body limit.
        .layer(axum::extract::DefaultBodyLimit::max(100 * 1024 * 1024))
        .layer(middleware::from_fn(check_auth));

    // WebSocket route (with auth via query param or header)
    let ws_routes = Router::new()
        .route("/ws", get(ws::ws_handler))
        .with_state(Arc::clone(&fs_tx));

    // Chat WebSocket route (no state needed, stateless per connection)
    let chat_ws_routes = Router::new().route("/ws/chat", get(chat_ws_auth_handler));

    // CLI detection + models + config route (with auth)
    let cli_routes = Router::new()
        .route("/api/cli/detect", get(detect_cli_handler))
        .route("/api/cli/config", get(cli_config_handler))
        .route("/api/models", post(list_models_handler))
        .layer(middleware::from_fn(check_auth));

    // Static file fallback (no auth needed)
    let static_routes = Router::new().fallback(static_files::static_handler);

    let app = Router::new()
        .merge(api_routes)
        .merge(cli_routes)
        .merge(ws_routes)
        .merge(chat_ws_routes)
        .merge(static_routes)
        .layer(cors_layer(Arc::clone(&allowed_origins.0)))
        .layer(axum::Extension(app_token))
        .layer(axum::Extension(allowed_origins))
        .layer(axum::Extension(chat_policy))
        .layer(axum::Extension(ws_tickets));

    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind address");

    tracing::info!("AI Session Viewer Web Server listening on http://{}", addr);
    if config.token.is_some() {
        tracing::info!("Authentication enabled (Bearer token required)");
    } else if binds_loopback {
        tracing::info!("No authentication (loopback only; set --token or ASV_TOKEN to enable)");
    } else {
        tracing::warn!("No authentication on a network-reachable address (--allow-no-auth)");
    }
    if config.allow_skip_permissions {
        tracing::warn!("Chat clients may request --dangerously-skip-permissions");
    }

    axum::serve(listener, app).await.expect("Server error");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(origin: Option<&str>, host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("host", host.parse().unwrap());
        if let Some(origin) = origin {
            headers.insert("origin", origin.parse().unwrap());
        }
        headers
    }

    #[test]
    fn ws_origin_allows_same_origin_trusted_and_originless() {
        let allowed = AllowedOrigins(Arc::new(vec!["https://asv.example.com/".to_string()]));
        for origin in [
            None,
            Some("http://192.168.1.5:3000"),
            Some("http://localhost:1420"),
            Some("http://127.0.0.1:5173"),
            Some("http://[::1]:3000"),
            Some("tauri://localhost"),
            Some("http://tauri.localhost"),
            Some("https://asv.example.com"),
        ] {
            assert!(
                check_ws_origin(&headers(origin, "192.168.1.5:3000"), &allowed).is_ok(),
                "{origin:?}"
            );
        }
    }

    #[test]
    fn ws_origin_rejects_cross_site_pages() {
        let allowed = AllowedOrigins(Arc::new(Vec::new()));
        for origin in [
            "https://evil.example",
            "http://localhost.evil.example",
            "http://192.168.1.6:3000",
            "null",
        ] {
            assert_eq!(
                check_ws_origin(&headers(Some(origin), "192.168.1.5:3000"), &allowed),
                Err(StatusCode::FORBIDDEN),
                "{origin}"
            );
        }
    }
}
