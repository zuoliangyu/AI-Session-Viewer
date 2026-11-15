use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch, Mutex};

use session_core::chat_cli;
use session_core::cli;
use session_core::cli_config;
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

/// Server-side switches for what a chat client may request. Both are off by
/// default so a reachable server can't be driven into running an agent without
/// permission prompts or against an attacker-chosen API endpoint.
#[derive(Clone, Copy, Debug, Default)]
pub struct ChatPolicy {
    pub allow_skip_permissions: bool,
    pub allow_client_credentials: bool,
}

impl ChatPolicy {
    fn check(&self, skip_permissions: bool, api_key: &str, base_url: &str) -> Result<(), String> {
        if skip_permissions && !self.allow_skip_permissions {
            return Err(
                "服务器未开启跳过权限（启动时需加 --allow-skip-permissions 或 ASV_ALLOW_SKIP_PERMISSIONS=true）"
                    .to_string(),
            );
        }
        if (!api_key.trim().is_empty() || !base_url.trim().is_empty())
            && !self.allow_client_credentials
        {
            return Err(
                "服务器不接受客户端传入的 API Key / Base URL（启动时需加 --allow-client-credentials 或 ASV_ALLOW_CLIENT_CREDENTIALS=true）"
                    .to_string(),
            );
        }
        Ok(())
    }
}

pub async fn chat_ws_handler(ws: WebSocketUpgrade, policy: ChatPolicy) -> Response {
    ws.on_upgrade(move |socket| handle_chat_socket(socket, policy))
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
        Err(format!(
            "No accessible {} project directories are available",
            source
        ))
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

async fn handle_chat_socket(mut socket: WebSocket, policy: ChatPolicy) {
    let (tx, mut rx) = mpsc::channel::<String>(100);
    let cancellations = Arc::new(Mutex::new(HashMap::<String, watch::Sender<bool>>::new()));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            Some(message) = rx.recv() => {
                match tokio::time::timeout(std::time::Duration::from_secs(10), socket.send(Message::Text(message.into()))).await {
                    Ok(Ok(())) => {},
                    _ => break,
                }
            }
            Some(finished) = tasks.join_next() => {
                if let Err(error) = finished { tracing::warn!("Chat task failed: {error}"); }
            }
            message = socket.recv() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => continue,
                };
                let request: ChatRequest = match serde_json::from_str(&text) {
                    Ok(request) => request,
                    Err(error) => {
                        if tx.try_send(chat_error(None, format!("Invalid request: {error}"))).is_err() { break; }
                        continue;
                    }
                };
                if request.action == "cancel" {
                    let sender = {
                        let tasks = cancellations.lock().await;
                        request.session_id.as_ref().and_then(|id| tasks.get(id).cloned())
                    };
                    if let Some(sender) = sender {
                        sender.send_replace(true);
                    }
                    continue;
                }
                let routing_id = request.session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let duplicate = cancellations.lock().await.contains_key(&routing_id);
                let validation = (|| {
                    if !matches!(request.action.as_str(), "start" | "continue") {
                        return Err(format!("Unknown action: {}", request.action));
                    }
                    if duplicate {
                        return Err("Chat session already has an active task".to_string());
                    }
                    let source = cli::normalize_chat_source(request.source.as_deref().unwrap_or("claude"))?;
                    policy.check(request.skip_permissions.unwrap_or(false), request.api_key.as_deref().unwrap_or(""), request.base_url.as_deref().unwrap_or(""))?;
                    Ok(source.to_string())
                })();
                let source = match validation {
                    Ok(source) => source,
                    Err(error) => {
                        if tx.try_send(chat_error(Some(&routing_id), error)).is_err() { break; }
                        continue;
                    }
                };
                let (cancel_tx, mut cancel_rx) = watch::channel(false);
                cancellations.lock().await.insert(routing_id.clone(), cancel_tx);
                let cancellations = cancellations.clone();
                let tx = tx.clone();
                tasks.spawn(async move {
                    let project_path = request.project_path.unwrap_or_default();
                    let prompt = request.prompt.unwrap_or_default();
                    let model = request.model.unwrap_or_default();
                    let api_key = request.api_key.unwrap_or_default();
                    let base_url = request.base_url.unwrap_or_default();
                    let resume_id = (request.action == "continue").then_some(routing_id.clone());
                    let outcome = if source == "codex" {
                        run_codex_chat_via_app_server(&routing_id, &project_path, &prompt, &model,
                            resume_id.as_deref(), &api_key, &base_url, &tx, &mut cancel_rx).await
                    } else {
                        let acknowledgement = serde_json::json!({ "type": "session_id", "data": routing_id, "sessionId": routing_id }).to_string();
                        if tx.send(acknowledgement).await.is_err() { return routing_id; }
                        run_cli_process(&source, &project_path, &prompt, &model,
                            request.skip_permissions.unwrap_or(false), resume_id.as_deref(),
                            request.cli_path.as_deref().unwrap_or(""), &api_key, &base_url,
                            routing_id.clone(), tx.clone(), &mut cancel_rx).await
                    };
                    let success = match outcome {
                        Ok(success) => success,
                        Err(error) => { let _ = tx.send(chat_error(Some(&routing_id), error)).await; false }
                    };
                    cancellations.lock().await.remove(&routing_id);
                    let _ = tx.send(serde_json::json!({ "type": "complete", "success": success, "sessionId": routing_id }).to_string()).await;
                    routing_id
                });
            }
        }
    }
    // These tasks belong to this connection. Unblock output senders first,
    // then cancel and join every task so no CLI or turn is left detached.
    drop(rx);
    drop(tx);
    let senders: Vec<_> = cancellations.lock().await.values().cloned().collect();
    cancel_connection_tasks(&senders, &mut tasks).await;
}

async fn cancel_connection_tasks(
    cancellations: &[watch::Sender<bool>],
    tasks: &mut tokio::task::JoinSet<String>,
) {
    for sender in cancellations {
        sender.send_replace(true);
    }
    while tasks.join_next().await.is_some() {}
}

fn chat_error(routing_id: Option<&str>, error: String) -> String {
    serde_json::json!({ "type": "error", "data": error, "sessionId": routing_id }).to_string()
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
    routing_id: String,
    tx: mpsc::Sender<String>,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<bool, String> {
    if *cancel_rx.borrow() {
        return Ok(false);
    }
    let source = cli::normalize_chat_source(source)?;
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
    cmd.args(chat_cli::claude_print_args(
        prompt,
        model,
        skip_permissions,
        resume_session_id,
    ));

    // Web mode: no interactive terminal, close stdin so CLI doesn't hang
    // waiting for permission confirmation or other interactive prompts
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    // Same whitelist as the desktop app (the web copy used to inherit the
    // whole server environment).
    chat_cli::apply_cli_env(&mut cmd, source, &cli_path, &credentials)?;
    cmd.current_dir(project_dir);

    if *cancel_rx.borrow() {
        return Ok(false);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn CLI: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let tx_stdout = tx.clone();
    let routing_stdout = routing_id.clone();
    let mut stdout_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg = serde_json::json!({
                    "type": "output",
                    "data": line,
                    "sessionId": &routing_stdout,
                })
                .to_string();
                if tx_stdout.send(msg).await.is_err() {
                    break;
                }
            }
        }
    });

    let tx_stderr = tx.clone();
    let routing_stderr = routing_id.clone();
    let mut stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg = serde_json::json!({
                    "type": "error",
                    "data": line,
                    "sessionId": &routing_stderr,
                })
                .to_string();
                if tx_stderr.send(msg).await.is_err() {
                    break;
                }
            }
        }
    });

    let success = tokio::select! {
        status = child.wait() => status.map(|status| status.success()).unwrap_or(false),
        _ = cancel_rx.changed() => {
            terminate_cli_tree(&mut child).await;
            false
        }
    };
    for task in [&mut stdout_task, &mut stderr_task] {
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut *task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
    }
    Ok(success)
}

async fn terminate_cli_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let mut command = Command::new("taskkill");
            command.args(["/PID", &pid.to_string(), "/T", "/F"]);
            command.creation_flags(0x0800_0000);
            let _ = command.status().await;
        }
        #[cfg(unix)]
        {
            let group = format!("-{pid}");
            let _ = Command::new("kill")
                .args(["-TERM", "--", &group])
                .status()
                .await;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let _ = Command::new("kill")
                .args(["-KILL", "--", &group])
                .status()
                .await;
        }
    }
    let _ = child.kill().await;
}

#[allow(clippy::too_many_arguments)]
async fn run_codex_chat_via_app_server(
    routing_id: &str,
    project_path: &str,
    prompt: &str,
    model: &str,
    resume_session_id: Option<&str>,
    api_key_override: &str,
    base_url_override: &str,
    tx: &mpsc::Sender<String>,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<bool, String> {
    if *cancel_rx.borrow() {
        return Ok(false);
    }
    let project_dir = resolve_project_dir("codex", project_path)?;
    let project_dir_str = project_dir.to_string_lossy().to_string();
    let credentials =
        cli_config::resolve_credentials("codex", Some(api_key_override), Some(base_url_override))?;
    let server = CodexAppServer::global();
    let model = (!model.is_empty()).then_some(model);
    let opened = server
        .open_thread(&credentials, &project_dir_str, model, resume_session_id)
        .await?;
    if *cancel_rx.borrow() {
        return Ok(false);
    }
    let thread_id = opened.thread_id;
    if tx
        .send(
            serde_json::json!({ "type": "session_id", "data": thread_id, "sessionId": routing_id })
                .to_string(),
        )
        .await
        .is_err()
    {
        return Ok(false);
    }
    if !opened.history_turns.is_null()
        && tx
            .send(
                serde_json::json!({
                    "type": "history", "data": opened.history_turns, "sessionId": routing_id,
                })
                .to_string(),
            )
            .await
            .is_err()
    {
        return Ok(false);
    }
    let Some(mut turn) = server
        .start_turn(
            &credentials,
            &thread_id,
            prompt,
            model,
            Some(&project_dir_str),
            cancel_rx,
        )
        .await?
    else {
        return Ok(false);
    };
    if *cancel_rx.borrow() {
        turn.interrupt().await?;
        return Ok(false);
    }
    loop {
        let notification = tokio::select! {
            result = turn.recv() => match result {
                Ok(notification) => notification,
                Err(error) => { let _ = turn.interrupt().await; return Err(error); }
            },
            _ = cancel_rx.changed() => {
                turn.interrupt().await?;
                return Ok(false);
            }
        };
        let envelope = serde_json::json!({
            "type": "output", "data": serde_json::json!({
                "type": "notification", "method": notification.method, "params": notification.params,
            }).to_string(), "sessionId": routing_id,
        }).to_string();
        if tx.send(envelope).await.is_err() {
            turn.interrupt().await?;
            return Ok(false);
        }
        if let Some(success) = notification.turn_outcome() {
            return Ok(success);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connection_shutdown_cancels_and_joins_only_its_own_tasks() {
        let mut cancellations = Vec::new();
        let mut tasks = tokio::task::JoinSet::new();
        let (_unrelated_sender, unrelated) = watch::channel(false);
        for id in ["first", "second"] {
            let (sender, mut receiver) = watch::channel(false);
            cancellations.push(sender);
            tasks.spawn(async move {
                receiver.changed().await.unwrap();
                assert!(*receiver.borrow());
                id.to_string()
            });
        }
        cancel_connection_tasks(&cancellations, &mut tasks).await;
        assert!(tasks.is_empty());
        assert!(!*unrelated.borrow());
    }
}
