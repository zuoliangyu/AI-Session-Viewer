use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use session_core::cli;
use session_core::cli_config::{self, CliConfig, ResolvedCliCredentials};
use session_core::codex_app_server::{CodexAppServer, CodexNotification};
use session_core::model_list::{self, ModelInfo};

/// State to track active chat processes (Claude only) and active Codex turns.
pub struct ChatProcessState {
    /// Claude session_id -> PID of the spawned CLI process
    pub processes: Arc<Mutex<HashMap<String, u32>>>,
    /// Codex thread_id -> turn_id (for cancellation via turn/interrupt)
    pub codex_turns: Arc<Mutex<HashMap<String, String>>>,
    /// Track which session_ids are codex (for cancel routing)
    pub codex_sessions: Arc<Mutex<HashMap<String, String>>>, // pending_or_thread_id -> thread_id
}

impl ChatProcessState {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            codex_turns: Arc::new(Mutex::new(HashMap::new())),
            codex_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub async fn detect_cli() -> Result<Vec<cli::CliInstallation>, String> {
    tokio::task::spawn_blocking(cli::discover_installations)
        .await
        .map_err(|e| format!("detect_cli task failed: {}", e))
}

#[tauri::command]
pub async fn get_cli_config(source: String) -> Result<CliConfig, String> {
    tokio::task::spawn_blocking(move || cli_config::read_cli_config(&source))
        .await
        .map_err(|e| format!("get_cli_config task failed: {}", e))?
}

#[tauri::command]
pub async fn list_models(
    source: String,
    api_key: String,
    base_url: String,
) -> Result<Vec<ModelInfo>, String> {
    model_list::list_models(&source, &api_key, &base_url).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_chat(
    app: AppHandle,
    source: String,
    session_id: Option<String>,
    project_path: String,
    prompt: String,
    model: String,
    skip_permissions: bool,
    cli_path: String,
    api_key: String,
    base_url: String,
) -> Result<String, String> {
    let source = cli::normalize_source(&source)?.to_string();
    let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let credentials =
        cli_config::resolve_credentials(&source, Some(&api_key), Some(&base_url))?;

    if source == "codex" {
        return run_codex_chat(app, session_id, project_path, prompt, model, credentials, None).await;
    }

    let resolved_cli = if cli_path.is_empty() {
        cli::find_cli(&source)?
    } else {
        cli_path
    };

    let cmd = build_chat_command(BuildChatCommandParams {
        cli_path: &resolved_cli,
        source: &source,
        project_path: &project_path,
        prompt: &prompt,
        model: &model,
        skip_permissions,
        resume_session_id: None,
        credentials: &credentials,
    })?;

    spawn_and_stream(app, cmd, session_id.clone(), source)?;

    Ok(session_id)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn continue_chat(
    app: AppHandle,
    source: String,
    session_id: String,
    project_path: String,
    prompt: String,
    model: String,
    skip_permissions: bool,
    cli_path: String,
    api_key: String,
    base_url: String,
) -> Result<String, String> {
    let source = cli::normalize_source(&source)?.to_string();
    let credentials =
        cli_config::resolve_credentials(&source, Some(&api_key), Some(&base_url))?;

    if source == "codex" {
        return run_codex_chat(
            app,
            session_id.clone(),
            project_path,
            prompt,
            model,
            credentials,
            Some(session_id),
        )
        .await;
    }

    let resolved_cli = if cli_path.is_empty() {
        cli::find_cli(&source)?
    } else {
        cli_path
    };

    let cmd = build_chat_command(BuildChatCommandParams {
        cli_path: &resolved_cli,
        source: &source,
        project_path: &project_path,
        prompt: &prompt,
        model: &model,
        skip_permissions,
        resume_session_id: Some(&session_id),
        credentials: &credentials,
    })?;

    spawn_and_stream(app, cmd, session_id.clone(), source)?;

    Ok(session_id)
}

#[tauri::command]
pub async fn cancel_chat(app: AppHandle, session_id: String) -> Result<(), String> {
    let state = app.state::<ChatProcessState>();

    // Codex path: send turn/interrupt via app-server.
    let codex_target = {
        let map = state.codex_sessions.lock();
        map.get(&session_id).cloned()
    };
    if let Some(thread_id) = codex_target {
        let turn_id = state.codex_turns.lock().get(&thread_id).cloned();
        if let Some(turn_id) = turn_id {
            // Best-effort interrupt — credentials read from current config.
            if let Ok(creds) = cli_config::resolve_credentials("codex", None, None) {
                let server = CodexAppServer::global();
                let _ = server.interrupt_turn(&creds, &thread_id, &turn_id).await;
            }
        }
        let _ = app.emit(
            &format!("chat-complete:{}", session_id),
            json!({ "success": false, "cancelled": true }).to_string(),
        );
        return Ok(());
    }

    // Claude path (original): kill the spawned process by PID.
    let pid = {
        let mut processes = state.processes.lock();
        processes.remove(&session_id)
    };
    if let Some(pid) = pid {
        kill_process(pid);
        let _ = app.emit(&format!("chat-complete:{}", session_id), "cancelled");
    }

    Ok(())
}

/// Run a Codex chat turn through the app-server. The `pending_session_id` is
/// the id the frontend is listening on (`chat-output:{id}`); for new chats
/// it's a UUID the frontend generated, for resume it's the real thread_id.
/// Returns the actual thread_id (== pending for resume, new for start).
async fn run_codex_chat(
    app: AppHandle,
    pending_session_id: String,
    project_path: String,
    prompt: String,
    model: String,
    credentials: ResolvedCliCredentials,
    resume_thread_id: Option<String>,
) -> Result<String, String> {
    let server = CodexAppServer::global();
    let event_id = pending_session_id.clone();
    let model_opt = if model.is_empty() { None } else { Some(model.as_str()) };

    // Open the thread (start or resume) and capture metadata.
    let (thread_id, history_turns) = if let Some(thread_id) = resume_thread_id {
        let resp = server
            .resume_thread(&credentials, &thread_id, &project_path, model_opt)
            .await
            .map_err(|e| format!("codex thread/resume failed: {}", e))?;
        let resolved_id = resp
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or(thread_id);
        let turns = resp
            .get("thread")
            .and_then(|t| t.get("turns"))
            .cloned()
            .unwrap_or(Value::Null);
        (resolved_id, turns)
    } else {
        let resp = server
            .start_thread(&credentials, &project_path, model_opt)
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

    // Register session for cancel routing.
    {
        let state = app.state::<ChatProcessState>();
        let mut map = state.codex_sessions.lock();
        map.insert(event_id.clone(), thread_id.clone());
        if event_id != thread_id {
            map.insert(thread_id.clone(), thread_id.clone());
        }
    }

    // Stream events on `chat-output:{thread_id}`. The frontend's listener
    // re-subscribes to this channel name as soon as it sees the thread_id
    // returned by this command, so emitting here is correct for both new
    // chats (event_id != thread_id) and resume (event_id == thread_id).
    let stream_channel = thread_id.clone();

    // For new chats only: notify the frontend's *initial* listener (which is
    // still on `chat-output:{pending}`) that the session_id has changed.
    // This lets the parser update pane.sessionId, which triggers the
    // re-subscribe to the new channel.
    if event_id != thread_id {
        let _ = app.emit(
            &format!("chat-output:{}", event_id),
            json!({
                "type": "session_id",
                "data": &thread_id,
            })
            .to_string(),
        );
    }

    // Emit history (resume only) on the stream channel.
    if !history_turns.is_null() {
        let _ = app.emit(
            &format!("chat-output:{}", stream_channel),
            json!({
                "type": "history",
                "data": history_turns,
            })
            .to_string(),
        );
    }

    // Subscribe BEFORE starting the turn so we don't miss events.
    let mut rx = server
        .subscribe(&credentials, &thread_id)
        .await
        .map_err(|e| format!("codex subscribe failed: {}", e))?;

    // Kick off the turn after a short delay so the frontend has time to
    // re-subscribe to `chat-output:{thread_id}` after receiving the
    // command's return value.
    {
        let server = server.clone();
        let creds = credentials.clone();
        let tid = thread_id.clone();
        let prompt = prompt.clone();
        let model_owned = model.clone();
        let cwd = project_path.clone();
        let app_for_err = app.clone();
        let stream_channel_for_err = stream_channel.clone();
        let needs_grace = event_id != thread_id;
        tokio::spawn(async move {
            if needs_grace {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let m = if model_owned.is_empty() { None } else { Some(model_owned.as_str()) };
            if let Err(e) = server
                .start_turn(&creds, &tid, &prompt, m, Some(cwd.as_str()))
                .await
            {
                let _ = app_for_err.emit(
                    &format!("chat-error:{}", stream_channel_for_err),
                    format!("turn/start failed: {}", e),
                );
            }
        });
    }

    // Spawn the streaming task on the stream channel.
    {
        let app_stream = app.clone();
        let stream_channel_stream = stream_channel.clone();
        let thread_id_stream = thread_id.clone();
        tokio::spawn(async move {
            stream_codex_notifications(
                app_stream,
                stream_channel_stream,
                thread_id_stream,
                &mut rx,
            )
            .await;
        });
    }

    Ok(thread_id)
}

async fn stream_codex_notifications(
    app: AppHandle,
    event_id: String,
    thread_id: String,
    rx: &mut tokio::sync::mpsc::Receiver<CodexNotification>,
) {
    let mut success = true;
    while let Some(notif) = rx.recv().await {
        // Capture turn_id from turn/started for cancel support.
        if notif.method == "turn/started" {
            if let Some(tid) = notif
                .params
                .get("turn")
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())
            {
                let state = app.state::<ChatProcessState>();
                state
                    .codex_turns
                    .lock()
                    .insert(thread_id.clone(), tid.to_string());
            }
        }

        let payload = json!({
            "type": "notification",
            "method": &notif.method,
            "params": &notif.params,
        })
        .to_string();
        let _ = app.emit(&format!("chat-output:{}", event_id), &payload);

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

    // Clear active turn id so cancel won't hit a stale value.
    {
        let state = app.state::<ChatProcessState>();
        state.codex_turns.lock().remove(&thread_id);
    }

    let _ = app.emit(
        &format!("chat-complete:{}", event_id),
        json!({ "success": success }).to_string(),
    );
}

struct BuildChatCommandParams<'a> {
    cli_path: &'a str,
    source: &'a str,
    project_path: &'a str,
    prompt: &'a str,
    model: &'a str,
    skip_permissions: bool,
    resume_session_id: Option<&'a str>,
    credentials: &'a cli_config::ResolvedCliCredentials,
}

fn build_chat_command(
    params: BuildChatCommandParams<'_>,
) -> Result<Command, String> {
    let BuildChatCommandParams {
        cli_path,
        source,
        project_path,
        prompt,
        model,
        skip_permissions,
        resume_session_id,
        credentials,
    } = params;

    let mut cmd = Command::new(cli_path);

    if source == "codex" {
        // codex exec [resume <session_id>] "prompt" --json --full-auto [--model m] [--skip-git-repo-check]
        cmd.arg("exec");
        if let Some(sid) = resume_session_id {
            cmd.arg("resume").arg(sid);
        }
        cmd.arg(prompt);
        cmd.arg("--json");
        cmd.arg("--full-auto");
        if !model.is_empty() {
            cmd.arg("--model").arg(model);
        }
        // Codex requires a git repo; skip the check so it works in any directory
        cmd.arg("--skip-git-repo-check");
    } else {
        // Claude CLI arguments
        if let Some(sid) = resume_session_id {
            cmd.arg("--resume").arg(sid);
        }
        cmd.arg("-p").arg(prompt);
        if !model.is_empty() {
            // Strip "-latest" suffix — Claude CLI expects full names like
            // "claude-sonnet-4-6", not API-style "claude-sonnet-4-6-latest"
            let cli_model = model.strip_suffix("-latest").unwrap_or(model);
            cmd.arg("--model").arg(cli_model);
        }
        cmd.arg("--output-format").arg("stream-json");
        cmd.arg("--include-partial-messages");
        cmd.arg("--verbose");
        if skip_permissions {
            cmd.arg("--dangerously-skip-permissions");
        }
    }

    eprintln!("[chat] source={}, model={}, project={}", source, model, project_path);

    // Clean environment: use a whitelist approach (like opcode) to avoid
    // inheriting Claude Code session vars that cause conflicts.
    // Clear everything, then only pass essential system variables.
    cmd.env_clear();
    for key in &[
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "COMSPEC",
        "TEMP",
        "TMP",
        "HOME",
        "HOMEDRIVE",
        "HOMEPATH",
        "USERPROFILE",
        "USERNAME",
        "USER",
        "SHELL",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "NODE_PATH",
        "NVM_DIR",
        "NVM_BIN",
        "NVM_SYMLINK",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMDATA",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
    ] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }
    compose_chat_path(&mut cmd, cli_path)?;
    apply_provider_env(&mut cmd, source, credentials);

    cmd.current_dir(project_path);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Don't create a console window on Windows
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    Ok(cmd)
}

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
    credentials: &cli_config::ResolvedCliCredentials,
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

fn spawn_and_stream(
    app: AppHandle,
    mut cmd: Command,
    session_id: String,
    source: String,
) -> Result<(), String> {
    let child = cmd.spawn().map_err(|e| format!("Failed to spawn CLI process: {}", e))?;
    let pid = child.id().unwrap_or(0);

    // Register the process
    let state = app.state::<ChatProcessState>();
    state.processes.lock().insert(session_id.clone(), pid);

    let app_handle = app.clone();
    let sid = session_id.clone();

    tokio::spawn(async move {
        stream_process_output(app_handle, child, sid, source).await;
    });

    Ok(())
}

async fn stream_process_output(
    app: AppHandle,
    mut child: Child,
    session_id: String,
    _source: String,
) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_stdout = app.clone();
    let sid_stdout = session_id.clone();

    // Stream stdout
    let stdout_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let event_name = format!("chat-output:{}", sid_stdout);
                let _ = app_stdout.emit(&event_name, &line);
            }
        }
    });

    let app_stderr = app.clone();
    let sid_stderr = session_id.clone();

    // Stream stderr
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[chat stderr] {}", line);
                let event_name = format!("chat-error:{}", sid_stderr);
                let _ = app_stderr.emit(&event_name, &line);
            }
        }
    });

    // Wait for process to complete
    let exit_status = child.wait().await;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let success = exit_status.map(|s| s.success()).unwrap_or(false);

    // Clean up from process registry
    let state = app.state::<ChatProcessState>();
    state.processes.lock().remove(&session_id);

    let event_name = format!("chat-complete:{}", session_id);
    let _ = app.emit(
        &event_name,
        serde_json::json!({ "success": success }).to_string(),
    );
}

fn kill_process(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }

    #[cfg(not(windows))]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        // Give it a moment, then force kill
        std::thread::sleep(std::time::Duration::from_millis(500));
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}
