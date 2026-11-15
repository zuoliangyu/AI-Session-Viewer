use std::collections::HashMap;
use std::process::Stdio;

use parking_lot::Mutex;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use session_core::chat_cli;
use session_core::cli;
use session_core::cli_config::{self, CliConfig, ResolvedCliCredentials};
use session_core::codex_app_server::CodexAppServer;
use session_core::model_list::{self, ModelInfo};

/// Cancellation is registered before any asynchronous startup work. The task
/// owns its process/turn and removes this entry only after it has stopped.
pub struct ChatProcessState {
    cancellations: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl ChatProcessState {
    pub fn new() -> Self {
        Self {
            cancellations: Mutex::new(HashMap::new()),
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
    let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    spawn_chat_task(
        app,
        source,
        session_id,
        project_path,
        prompt,
        model,
        skip_permissions,
        cli_path,
        api_key,
        base_url,
        false,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    spawn_chat_task(
        app,
        source,
        session_id,
        project_path,
        prompt,
        model,
        skip_permissions,
        cli_path,
        api_key,
        base_url,
        true,
    )
}

#[tauri::command]
pub async fn cancel_chat(app: AppHandle, session_id: String) -> Result<(), String> {
    if let Some(sender) = app
        .state::<ChatProcessState>()
        .cancellations
        .lock()
        .get(&session_id)
    {
        sender.send_replace(true);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn spawn_chat_task(
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
    resume: bool,
) -> Result<String, String> {
    let source = cli::normalize_chat_source(&source)?.to_string();
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    {
        let state = app.state::<ChatProcessState>();
        let mut tasks = state.cancellations.lock();
        if tasks.contains_key(&session_id) {
            return Err("Chat session already has an active task".into());
        }
        tasks.insert(session_id.clone(), cancel_tx);
    }
    let routing_id = session_id.clone();
    tokio::spawn(async move {
        let outcome = async {
            if *cancel_rx.borrow() {
                return Ok(false);
            }
            let credentials =
                cli_config::resolve_credentials(&source, Some(&api_key), Some(&base_url))?;
            if source == "codex" {
                return run_codex_chat(
                    &app,
                    &routing_id,
                    &project_path,
                    &prompt,
                    &model,
                    &credentials,
                    resume,
                    &mut cancel_rx,
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
                resume_session_id: resume.then_some(routing_id.as_str()),
                credentials: &credentials,
            })?;
            if *cancel_rx.borrow() {
                return Ok(false);
            }
            stream_process_output(app.clone(), cmd, &routing_id, &mut cancel_rx).await
        }
        .await;
        let success = match outcome {
            Ok(success) => success,
            Err(error) => {
                let _ = app.emit(&format!("chat-error:{}", routing_id), error);
                false
            }
        };
        app.state::<ChatProcessState>()
            .cancellations
            .lock()
            .remove(&routing_id);
        let _ = app.emit(
            &format!("chat-complete:{}", routing_id),
            json!({ "success": success }).to_string(),
        );
    });
    Ok(session_id)
}

#[allow(clippy::too_many_arguments)]
async fn run_codex_chat(
    app: &AppHandle,
    routing_id: &str,
    project_path: &str,
    prompt: &str,
    model: &str,
    credentials: &ResolvedCliCredentials,
    resume: bool,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<bool, String> {
    let server = CodexAppServer::global();
    let model = (!model.is_empty()).then_some(model);
    let opened = server
        .open_thread(
            credentials,
            project_path,
            model,
            resume.then_some(routing_id),
        )
        .await?;
    if *cancel_rx.borrow() {
        return Ok(false);
    }
    let thread_id = opened.thread_id;
    let channel = format!("chat-output:{}", routing_id);
    let _ = app.emit(
        &channel,
        json!({ "type": "session_id", "data": thread_id }).to_string(),
    );
    if !opened.history_turns.is_null() {
        let _ = app.emit(
            &channel,
            json!({ "type": "history", "data": opened.history_turns }).to_string(),
        );
    }
    let Some(mut turn) = server
        .start_turn(
            credentials,
            &thread_id,
            prompt,
            model,
            Some(project_path),
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
                Err(error) => {
                    let _ = turn.interrupt().await;
                    return Err(error);
                }
            },
            _ = cancel_rx.changed() => {
                turn.interrupt().await?;
                return Ok(false);
            }
        };
        let _ = app.emit(&channel, json!({
            "type": "notification", "method": notification.method, "params": notification.params,
        }).to_string());
        if let Some(success) = notification.turn_outcome() {
            return Ok(success);
        }
    }
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

fn build_chat_command(params: BuildChatCommandParams<'_>) -> Result<Command, String> {
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

    // Only Claude is spawned per turn; Codex goes through `codex app-server`.
    let mut cmd = Command::new(cli_path);

    cmd.args(chat_cli::claude_print_args(
        prompt,
        model,
        skip_permissions,
        resume_session_id,
    ));

    eprintln!(
        "[chat] source={}, model={}, project={}",
        source, model, project_path
    );

    chat_cli::apply_cli_env(&mut cmd, source, cli_path, credentials)?;

    cmd.current_dir(project_path);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    // Don't create a console window on Windows
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    Ok(cmd)
}

async fn stream_process_output(
    app: AppHandle,
    mut cmd: Command,
    session_id: &str,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<bool, String> {
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Failed to spawn CLI process: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_stdout = app.clone();
    let sid_stdout = session_id.to_string();
    let mut stdout_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_stdout.emit(&format!("chat-output:{}", sid_stdout), line);
            }
        }
    });
    let sid_stderr = session_id.to_string();
    let mut stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(&format!("chat-error:{}", sid_stderr), line);
            }
        }
    });
    let success = tokio::select! {
        status = child.wait() => status.map(|status| status.success()).unwrap_or(false),
        _ = cancel_rx.changed() => {
            if let Some(pid) = child.id() {
                let _ = tokio::task::spawn_blocking(move || kill_process(pid)).await;
            }
            let _ = child.kill().await;
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
fn kill_process(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    #[cfg(not(windows))]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        // Give it a moment, then force kill
        std::thread::sleep(std::time::Duration::from_millis(500));
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}
