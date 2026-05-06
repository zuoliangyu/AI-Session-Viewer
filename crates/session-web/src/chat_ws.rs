use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use serde::Deserialize;
use serde_json::Value;
use std::process::Stdio;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};

use session_core::cli;
use session_core::cli_config::{self, ResolvedCliCredentials};
use session_core::codex_app_server::CodexAppServer;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    action: String,         // "start" | "continue" | "cancel"
    source: Option<String>, // "claude" | "codex"
    project_path: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
    session_id: Option<String>,
    skip_permissions: Option<bool>,
    cli_path: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
}

pub async fn chat_ws_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_chat_socket)
}

fn canonicalize_existing_dir(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Project path is required".to_string());
    }

    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;

    if !canonical.is_dir() {
        return Err("Project path must be a directory".to_string());
    }

    Ok(canonical)
}

fn allowed_project_roots(source: &str) -> Result<Vec<PathBuf>, String> {
    let projects = if source == "codex" {
        session_core::provider::codex::get_projects()
    } else {
        session_core::provider::claude::get_projects()
    }?;

    let mut roots = Vec::new();
    for project in projects {
        let display_path = project.display_path;
        if display_path.trim().is_empty() {
            continue;
        }

        let path = PathBuf::from(&display_path);
        if !path.exists() || !path.is_dir() {
            continue;
        }

        if let Ok(canonical) = path.canonicalize() {
            roots.push(canonical);
        }
    }

    roots.sort();
    roots.dedup();

    if roots.is_empty() {
        Err(format!("No accessible {} project directories are available", source))
    } else {
        Ok(roots)
    }
}

fn path_is_within_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn resolve_project_dir(source: &str, project_path: &str) -> Result<PathBuf, String> {
    let requested = canonicalize_existing_dir(project_path)?;
    let allowed_roots = allowed_project_roots(source)?;

    if path_is_within_any_root(&requested, &allowed_roots) {
        Ok(requested)
    } else {
        Err(format!(
            "Project path is outside the allowed {} project directories",
            source
        ))
    }
}

/// Per-socket Codex turn state (thread_id + active turn_id) for cancel routing.
#[derive(Default)]
struct CodexTurnState {
    thread_id: Option<String>,
    turn_id: Option<String>,
    credentials: Option<ResolvedCliCredentials>,
}

async fn handle_chat_socket(mut socket: WebSocket) {
    // Channel for sending messages back to the client
    let (tx, mut rx) = mpsc::channel::<String>(100);

    // Track the current child process PID (Claude) for cancellation
    let cancel_tx = tokio::sync::watch::channel(false);
    let cancel_sender = cancel_tx.0;

    // Track current codex turn for the lifetime of this socket
    let codex_state: Arc<Mutex<CodexTurnState>> = Arc::new(Mutex::new(CodexTurnState::default()));

    loop {
        tokio::select! {
            // Forward queued messages to the WebSocket
            Some(msg) = rx.recv() => {
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }

            // Receive messages from the client
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let request: ChatRequest = match serde_json::from_str(&text) {
                            Ok(r) => r,
                            Err(e) => {
                                let err_msg = serde_json::json!({
                                    "type": "error",
                                    "data": format!("Invalid request: {}", e)
                                }).to_string();
                                let _ = socket.send(Message::Text(err_msg.into())).await;
                                continue;
                            }
                        };

                        match request.action.as_str() {
                            "start" | "continue" => {
                                let raw_source =
                                    request.source.unwrap_or_else(|| "claude".to_string());
                                let source = match cli::normalize_source(&raw_source) {
                                    Ok(source) => source.to_string(),
                                    Err(e) => {
                                        let err_msg = serde_json::json!({
                                            "type": "error",
                                            "data": e
                                        }).to_string();
                                        let _ = socket.send(Message::Text(err_msg.into())).await;
                                        continue;
                                    }
                                };
                                let project_path = request.project_path.unwrap_or_default();
                                let prompt = request.prompt.unwrap_or_default();
                                let model = request.model.unwrap_or_default();
                                let skip_permissions = request.skip_permissions.unwrap_or(false);
                                let cli_path = request.cli_path.unwrap_or_default();
                                let api_key = request.api_key.unwrap_or_default();
                                let base_url = request.base_url.unwrap_or_default();
                                let resume_id = if request.action == "continue" {
                                    request.session_id.clone()
                                } else {
                                    None
                                };

                                let session_id = request.session_id
                                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

                                // For Claude, send session_id immediately. For codex
                                // we send it after thread/start returns the real id.
                                if source != "codex" {
                                    let sid_msg = serde_json::json!({
                                        "type": "session_id",
                                        "data": &session_id
                                    }).to_string();
                                    let _ = socket.send(Message::Text(sid_msg.into())).await;
                                }

                                let tx_clone = tx.clone();
                                let tx_err = tx.clone();

                                if source == "codex" {
                                    let codex_state = codex_state.clone();
                                    tokio::spawn(async move {
                                        if let Err(e) = run_codex_chat_via_app_server(
                                            &project_path,
                                            &prompt,
                                            &model,
                                            resume_id,
                                            &api_key,
                                            &base_url,
                                            tx_clone,
                                            codex_state,
                                        ).await {
                                            tracing::error!("Codex app-server error: {}", e);
                                            let err_msg = serde_json::json!({
                                                "type": "error",
                                                "data": e
                                            }).to_string();
                                            let _ = tx_err.send(err_msg).await;
                                            let complete_msg = serde_json::json!({
                                                "type": "complete",
                                                "success": false
                                            }).to_string();
                                            let _ = tx_err.send(complete_msg).await;
                                        }
                                    });
                                } else {
                                    let mut cancel_rx = cancel_sender.subscribe();
                                    tokio::spawn(async move {
                                        if let Err(e) = run_cli_process(
                                            &source,
                                            &project_path,
                                            &prompt,
                                            &model,
                                            skip_permissions,
                                            resume_id.as_deref(),
                                            &cli_path,
                                            &api_key,
                                            &base_url,
                                            tx_clone,
                                            &mut cancel_rx,
                                        ).await {
                                            tracing::error!("CLI process error: {}", e);
                                            let err_msg = serde_json::json!({
                                                "type": "error",
                                                "data": e
                                            }).to_string();
                                            let _ = tx_err.send(err_msg).await;
                                            let complete_msg = serde_json::json!({
                                                "type": "complete",
                                                "success": false
                                            }).to_string();
                                            let _ = tx_err.send(complete_msg).await;
                                        }
                                    });
                                }
                            }
                            "cancel" => {
                                // Codex cancel: send turn/interrupt
                                let codex_snapshot = {
                                    let s = codex_state.lock().await;
                                    (s.thread_id.clone(), s.turn_id.clone(), s.credentials.clone())
                                };
                                if let (Some(tid), Some(turn), Some(creds)) = codex_snapshot {
                                    let server = CodexAppServer::global();
                                    if let Err(e) = server.interrupt_turn(&creds, &tid, &turn).await {
                                        tracing::warn!("turn/interrupt failed: {}", e);
                                    }
                                }
                                // Claude cancel: kill process
                                let _ = cancel_sender.send(true);
                            }
                            _ => {
                                let err_msg = serde_json::json!({
                                    "type": "error",
                                    "data": format!("Unknown action: {}", request.action)
                                }).to_string();
                                let _ = socket.send(Message::Text(err_msg.into())).await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_cli_process(
    source: &str,
    project_path: &str,
    prompt: &str,
    model: &str,
    skip_permissions: bool,
    resume_session_id: Option<&str>,
    custom_cli_path: &str,
    api_key_override: &str,
    base_url_override: &str,
    tx: mpsc::Sender<String>,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    let source = cli::normalize_source(source)?;
    if source == "codex" {
        return Err("Codex chat must go through run_codex_chat_via_app_server".to_string());
    }
    let project_dir = resolve_project_dir(source, project_path)?;
    if !custom_cli_path.trim().is_empty() {
        tracing::warn!("Ignoring client-supplied cli_path for web chat");
    }
    let cli_path = cli::find_cli(source)?;
    let credentials =
        cli_config::resolve_credentials(source, Some(api_key_override), Some(base_url_override))?;

    let mut cmd = Command::new(&cli_path);

    if let Some(sid) = resume_session_id {
        cmd.arg("--resume").arg(sid);
    }
    cmd.arg("-p").arg(prompt);
    if !model.is_empty() {
        // Claude CLI expects CLI model IDs rather than the "-latest" alias.
        let cli_model = model.strip_suffix("-latest").unwrap_or(model);
        cmd.arg("--model").arg(cli_model);
    }
    cmd.arg("--output-format").arg("stream-json");
    cmd.arg("--include-partial-messages");
    cmd.arg("--verbose");
    // Web mode has no interactive terminal for permission prompts,
    // so always skip permissions to prevent the CLI from hanging.
    let _ = skip_permissions;
    cmd.arg("--dangerously-skip-permissions");

    // Web mode: no interactive terminal, close stdin so CLI doesn't hang
    // waiting for permission confirmation or other interactive prompts
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    compose_chat_path(&mut cmd, &cli_path)?;
    apply_provider_env(&mut cmd, source, &credentials);
    cmd.current_dir(project_dir);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn CLI: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let tx_stdout = tx.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg = serde_json::json!({
                    "type": "output",
                    "data": line
                })
                .to_string();
                if tx_stdout.send(msg).await.is_err() {
                    break;
                }
            }
        }
    });

    let tx_stderr = tx.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg = serde_json::json!({
                    "type": "error",
                    "data": line
                })
                .to_string();
                if tx_stderr.send(msg).await.is_err() {
                    break;
                }
            }
        }
    });

    // Wait for completion or cancellation
    tokio::select! {
        status = child.wait() => {
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            let success = status.map(|s| s.success()).unwrap_or(false);
            let complete_msg = serde_json::json!({
                "type": "complete",
                "success": success
            }).to_string();
            let _ = tx.send(complete_msg).await;
        }
        _ = cancel_rx.changed() => {
            let _ = child.kill().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            let cancel_msg = serde_json::json!({
                "type": "complete",
                "success": false
            }).to_string();
            let _ = tx.send(cancel_msg).await;
        }
    }

    Ok(())
}

/// Run a Codex chat through the app-server. Sends events to `tx` in the same
/// envelope shape (`{"type":"output","data":"<json>"}`) used elsewhere on the
/// socket.
#[allow(clippy::too_many_arguments)]
async fn run_codex_chat_via_app_server(
    project_path: &str,
    prompt: &str,
    model: &str,
    resume_session_id: Option<String>,
    api_key_override: &str,
    base_url_override: &str,
    tx: mpsc::Sender<String>,
    state: Arc<Mutex<CodexTurnState>>,
) -> Result<(), String> {
    let project_dir = resolve_project_dir("codex", project_path)?;
    let project_dir_str = project_dir.to_string_lossy().to_string();
    let credentials = cli_config::resolve_credentials(
        "codex",
        Some(api_key_override),
        Some(base_url_override),
    )?;

    let server = CodexAppServer::global();
    let model_opt = if model.is_empty() { None } else { Some(model) };

    // Open the thread.
    let (thread_id, history_turns) = if let Some(sid) = resume_session_id.as_deref() {
        let resp = server
            .resume_thread(&credentials, sid, &project_dir_str, model_opt)
            .await
            .map_err(|e| format!("codex thread/resume failed: {}", e))?;
        let id = resp
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| sid.to_string());
        let turns = resp
            .get("thread")
            .and_then(|t| t.get("turns"))
            .cloned()
            .unwrap_or(Value::Null);
        (id, turns)
    } else {
        let resp = server
            .start_thread(&credentials, &project_dir_str, model_opt)
            .await
            .map_err(|e| format!("codex thread/start failed: {}", e))?;
        let id = resp
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "codex thread/start: missing thread.id".to_string())?;
        (id, Value::Null)
    };

    // Persist for cancel routing.
    {
        let mut s = state.lock().await;
        s.thread_id = Some(thread_id.clone());
        s.credentials = Some(credentials.clone());
    }

    // Emit session_id.
    let sid_msg = serde_json::json!({
        "type": "session_id",
        "data": &thread_id,
    })
    .to_string();
    let _ = tx.send(sid_msg).await;

    // Emit history (resume only).
    if !history_turns.is_null() {
        let hist_msg = serde_json::json!({
            "type": "history",
            "data": history_turns,
        })
        .to_string();
        let _ = tx.send(hist_msg).await;
    }

    // Subscribe before kicking off the turn.
    let mut rx = server
        .subscribe(&credentials, &thread_id)
        .await
        .map_err(|e| format!("codex subscribe failed: {}", e))?;

    // Fire turn/start in the background; events stream through `rx`.
    {
        let server = server.clone();
        let creds = credentials.clone();
        let tid = thread_id.clone();
        let prompt_owned = prompt.to_string();
        let model_owned = model.to_string();
        let cwd = project_dir_str.clone();
        let tx_err = tx.clone();
        tokio::spawn(async move {
            let m = if model_owned.is_empty() { None } else { Some(model_owned.as_str()) };
            if let Err(e) = server
                .start_turn(&creds, &tid, &prompt_owned, m, Some(cwd.as_str()))
                .await
            {
                let err = serde_json::json!({
                    "type": "error",
                    "data": format!("turn/start failed: {}", e),
                })
                .to_string();
                let _ = tx_err.send(err).await;
            }
        });
    }

    // Stream notifications until turn/completed | turn/failed | error.
    let mut success = true;
    while let Some(notif) = rx.recv().await {
        if notif.method == "turn/started" {
            if let Some(tid) = notif
                .params
                .get("turn")
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())
            {
                state.lock().await.turn_id = Some(tid.to_string());
            }
        }

        let envelope = serde_json::json!({
            "type": "output",
            "data": serde_json::json!({
                "type": "notification",
                "method": &notif.method,
                "params": &notif.params,
            }).to_string(),
        })
        .to_string();
        if tx.send(envelope).await.is_err() {
            break;
        }

        let terminal = notif.method == "turn/completed"
            || notif.method == "turn/failed"
            || notif.method == "error";
        if notif.method == "turn/failed" || notif.method == "error" {
            success = false;
        }
        if terminal {
            break;
        }
    }

    // Reset turn id (thread_id stays for the next message on this socket).
    state.lock().await.turn_id = None;

    let complete = serde_json::json!({
        "type": "complete",
        "success": success,
    })
    .to_string();
    let _ = tx.send(complete).await;

    Ok(())
}

/// Compose PATH for the spawned CLI: prepend the CLI's own directory (so it
/// can find sibling scripts) AND node's directory. The latter matters under
/// minimal PATH environments (systemd, daemons) where `#!/usr/bin/env node`
/// in the CLI entry script would otherwise fail with `node: No such file`.
fn compose_chat_path(cmd: &mut Command, cli_path: &str) -> Result<(), String> {
    let mut paths: Vec<PathBuf> = Vec::new();

    if let Some(cli_dir) = Path::new(cli_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        paths.push(cli_dir.to_path_buf());
    }

    if let Some(node_path) = cli::find_node() {
        if let Some(node_dir) = Path::new(&node_path)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
        {
            let node_dir_buf = node_dir.to_path_buf();
            if !paths.iter().any(|p| p == &node_dir_buf) {
                paths.push(node_dir_buf);
            }
        }
    }

    if let Some(existing_path) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&existing_path) {
            if !paths.iter().any(|existing| existing == &p) {
                paths.push(p);
            }
        }
    }

    if paths.is_empty() {
        return Ok(());
    }

    let joined = std::env::join_paths(paths)
        .map_err(|e| format!("Failed to compose PATH for chat CLI: {}", e))?;
    cmd.env("PATH", joined);
    Ok(())
}

fn apply_provider_env(
    cmd: &mut Command,
    source: &str,
    credentials: &ResolvedCliCredentials,
) {
    for key in &[
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "CODEX_BASE_URL",
        "OPENAI_BASE_URL",
    ] {
        cmd.env_remove(key);
    }

    if source == "codex" {
        if !credentials.api_key.is_empty() {
            cmd.env("CODEX_API_KEY", &credentials.api_key);
            cmd.env("OPENAI_API_KEY", &credentials.api_key);
        }
        if !credentials.base_url.is_empty() {
            cmd.env("CODEX_BASE_URL", &credentials.base_url);
            cmd.env("OPENAI_BASE_URL", &credentials.base_url);
        }
    } else {
        if !credentials.api_key.is_empty() {
            cmd.env("ANTHROPIC_API_KEY", &credentials.api_key);
            cmd.env("ANTHROPIC_AUTH_TOKEN", &credentials.api_key);
        }
        if !credentials.base_url.is_empty() {
            cmd.env("ANTHROPIC_BASE_URL", &credentials.base_url);
        }
    }
}
