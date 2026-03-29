use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use session_core::cli;
use session_core::cli_config::{self, CliConfig};
use session_core::model_list::{self, ModelInfo};
use session_core::quick_chat::{self, ChatMsg};

/// State to track active chat processes.
pub struct ChatProcessState {
    pub processes: Arc<Mutex<HashMap<String, u32>>>, // session_id -> PID
}

impl ChatProcessState {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
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
pub async fn quick_chat(
    app: AppHandle,
    source: String,
    messages: Vec<ChatMsg>,
    model: String,
) -> Result<(), String> {
    let app_handle = app.clone();

    tokio::spawn(async move {
        let result = quick_chat::stream_chat(&source, messages, &model, |chunk| {
            let _ = app_handle.emit("quick-chat-chunk", chunk);
        })
        .await;

        match result {
            Ok(()) => {
                let _ = app_handle.emit(
                    "quick-chat-done",
                    serde_json::json!({ "success": true }).to_string(),
                );
            }
            Err(e) => {
                let _ = app_handle.emit("quick-chat-error", &e);
                let _ = app_handle.emit(
                    "quick-chat-done",
                    serde_json::json!({ "success": false }).to_string(),
                );
            }
        }
    });

    Ok(())
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

    let resolved_cli = if cli_path.is_empty() {
        cli::find_cli(&source)?
    } else {
        cli_path
    };
    let credentials =
        cli_config::resolve_credentials(&source, Some(&api_key), Some(&base_url))?;

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
    let resolved_cli = if cli_path.is_empty() {
        cli::find_cli(&source)?
    } else {
        cli_path
    };
    let credentials =
        cli_config::resolve_credentials(&source, Some(&api_key), Some(&base_url))?;

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
    prepend_cli_dir_to_path(&mut cmd, cli_path)?;
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

fn prepend_cli_dir_to_path(cmd: &mut Command, cli_path: &str) -> Result<(), String> {
    let Some(cli_dir) = Path::new(cli_path)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    else {
        return Ok(());
    };

    let mut paths = vec![cli_dir.to_path_buf()];
    if let Some(existing_path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing_path));
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
