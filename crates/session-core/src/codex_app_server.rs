//! JSON-RPC client for `codex app-server` (NDJSON over stdio).
//!
//! Maintains a singleton process keyed by (api_key, base_url) credentials so
//! every Codex chat shares one long-running app-server. Spawns lazily on
//! first use, restarts if credentials change or the child dies.
//!
//! Higher layers (`commands::chat`, `chat_ws`) call:
//!   1. `subscribe(thread_id)` → mpsc::Receiver<Notification>
//!   2. `start_thread()` / `resume_thread()` → thread metadata (incl. id + history)
//!   3. `start_turn()` to send a user prompt; events stream on the subscription
//!   4. `interrupt_turn()` to cancel
//!
//! Notifications are passed through verbatim as serde_json::Value — the
//! frontend parses them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex as PlMutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use crate::cli;
use crate::cli_config::ResolvedCliCredentials;

const SUBSCRIBER_BUFFER: usize = 512;
const STDIN_BUFFER: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexNotification {
    pub method: String,
    pub params: Value,
}

type RpcResultSender = oneshot::Sender<Result<Value, String>>;
type PendingMap = Arc<PlMutex<HashMap<u64, RpcResultSender>>>;
type SubscriberMap = Arc<PlMutex<HashMap<String, mpsc::Sender<CodexNotification>>>>;

/// One spawned app-server process plus its plumbing.
struct Runtime {
    next_id: AtomicU64,
    pending: PendingMap,
    /// thread_id -> subscriber. Notifications without a thread_id (e.g. server-wide
    /// errors) fan out to *all* current subscribers.
    subscribers: SubscriberMap,
    stdin_tx: mpsc::Sender<String>,
    creds_fingerprint: String,
    alive: Arc<AtomicBool>,
}

impl Runtime {
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn fail_pending(&self, reason: &str) {
        let mut pending = self.pending.lock();
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(reason.to_string()));
        }
    }
}

/// Public manager. One instance per process; share via `Arc`.
pub struct CodexAppServer {
    inner: AsyncMutex<Option<Arc<Runtime>>>,
}

impl Default for CodexAppServer {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexAppServer {
    pub fn new() -> Self {
        Self {
            inner: AsyncMutex::new(None),
        }
    }

    /// Process-wide singleton. Both `commands::chat` (Tauri) and `chat_ws`
    /// (web) use the same instance so one app-server serves everything.
    pub fn global() -> Arc<CodexAppServer> {
        static INSTANCE: OnceLock<Arc<CodexAppServer>> = OnceLock::new();
        INSTANCE
            .get_or_init(|| Arc::new(CodexAppServer::new()))
            .clone()
    }

    /// Spawn (or reuse) the runtime for these credentials.
    async fn ensure(&self, creds: &ResolvedCliCredentials) -> Result<Arc<Runtime>, String> {
        let fingerprint = format!("{}|{}", creds.api_key, creds.base_url);
        let mut guard = self.inner.lock().await;

        if let Some(rt) = guard.as_ref() {
            if rt.creds_fingerprint == fingerprint && rt.alive.load(Ordering::Relaxed) {
                return Ok(rt.clone());
            }
            // Stale: kill + replace.
            rt.fail_pending("codex app-server replaced");
            *guard = None;
        }

        let cli_path = cli::find_cli("codex")?;
        let rt = spawn_runtime(&cli_path, creds, fingerprint).await?;
        *guard = Some(rt.clone());
        Ok(rt)
    }

    /// Subscribe to notifications for a thread. Replacing an existing
    /// subscription drops the old receiver.
    pub async fn subscribe(
        &self,
        creds: &ResolvedCliCredentials,
        thread_id: &str,
    ) -> Result<mpsc::Receiver<CodexNotification>, String> {
        let rt = self.ensure(creds).await?;
        let (tx, rx) = mpsc::channel(SUBSCRIBER_BUFFER);
        rt.subscribers.lock().insert(thread_id.to_string(), tx);
        Ok(rx)
    }

    pub async fn unsubscribe(&self, thread_id: &str) {
        if let Some(rt) = self.inner.lock().await.as_ref() {
            rt.subscribers.lock().remove(thread_id);
        }
    }

    /// Send a request and await its result. Returns the raw `result` value.
    async fn request(
        &self,
        creds: &ResolvedCliCredentials,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let rt = self.ensure(creds).await?;
        send_request(&rt, method, params).await
    }

    pub async fn start_thread(
        &self,
        creds: &ResolvedCliCredentials,
        cwd: &str,
        model: Option<&str>,
    ) -> Result<Value, String> {
        let mut params = json!({
            "cwd": cwd,
            "sandbox": "workspace-write",
            "approvalPolicy": "never",
            "experimentalRawEvents": false,
            "persistExtendedHistory": false,
        });
        if let Some(m) = model.filter(|s| !s.is_empty()) {
            params["model"] = json!(m);
        }
        self.request(creds, "thread/start", params).await
    }

    pub async fn resume_thread(
        &self,
        creds: &ResolvedCliCredentials,
        thread_id: &str,
        cwd: &str,
        model: Option<&str>,
    ) -> Result<Value, String> {
        let mut params = json!({
            "threadId": thread_id,
            "cwd": cwd,
            "persistExtendedHistory": false,
        });
        if let Some(m) = model.filter(|s| !s.is_empty()) {
            params["model"] = json!(m);
        }
        self.request(creds, "thread/resume", params).await
    }

    pub async fn start_turn(
        &self,
        creds: &ResolvedCliCredentials,
        thread_id: &str,
        prompt: &str,
        model: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<Value, String> {
        let mut params = json!({
            "threadId": thread_id,
            "input": [{
                "type": "text",
                "text": prompt,
                "text_elements": [],
            }],
        });
        if let Some(m) = model.filter(|s| !s.is_empty()) {
            params["model"] = json!(m);
        }
        if let Some(c) = cwd.filter(|s| !s.is_empty()) {
            params["cwd"] = json!(c);
        }
        self.request(creds, "turn/start", params).await
    }

    pub async fn interrupt_turn(
        &self,
        creds: &ResolvedCliCredentials,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Value, String> {
        let params = json!({ "threadId": thread_id, "turnId": turn_id });
        self.request(creds, "turn/interrupt", params).await
    }
}

// ───────────────────────── helpers ─────────────────────────

async fn send_request(rt: &Runtime, method: &str, params: Value) -> Result<Value, String> {
    let id = rt.next_id();
    let (tx, rx) = oneshot::channel();
    rt.pending.lock().insert(id, tx);

    let frame = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string();

    if rt.stdin_tx.send(frame).await.is_err() {
        rt.pending.lock().remove(&id);
        return Err("codex app-server stdin closed".to_string());
    }

    match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("codex app-server response dropped".to_string()),
        Err(_) => {
            rt.pending.lock().remove(&id);
            Err(format!("codex app-server request '{}' timed out", method))
        }
    }
}

async fn spawn_runtime(
    cli_path: &str,
    creds: &ResolvedCliCredentials,
    fingerprint: String,
) -> Result<Arc<Runtime>, String> {
    let mut cmd = Command::new(cli_path);
    cmd.arg("app-server");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    apply_path_and_env(&mut cmd, cli_path, creds);

    #[cfg(windows)]
    {
        // Don't open a console window
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex app-server: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "codex app-server stdin not captured".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "codex app-server stdout not captured".to_string())?;
    let stderr = child.stderr.take();

    let pending: PendingMap = Arc::new(PlMutex::new(HashMap::new()));
    let subscribers: SubscriberMap = Arc::new(PlMutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));

    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(STDIN_BUFFER);

    // Writer task — drains stdin_rx into the child's stdin.
    {
        let alive = alive.clone();
        tokio::spawn(async move {
            let mut writer: ChildStdin = stdin;
            while let Some(line) = stdin_rx.recv().await {
                if writer.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if writer.write_all(b"\n").await.is_err() {
                    break;
                }
                if writer.flush().await.is_err() {
                    break;
                }
            }
            alive.store(false, Ordering::Relaxed);
        });
    }

    // Reader task — parses NDJSON and dispatches.
    {
        let pending = pending.clone();
        let subscribers = subscribers.clone();
        let alive = alive.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                handle_inbound_line(&line, &pending, &subscribers);
            }
            alive.store(false, Ordering::Relaxed);
            // Drain any pending requests so callers don't hang.
            let mut p = pending.lock();
            for (_, sender) in p.drain() {
                let _ = sender.send(Err("codex app-server exited".to_string()));
            }
        });
    }

    // Stderr task — log only; useful when something goes wrong server-side.
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[codex app-server] {}", line);
            }
        });
    }

    // Handshake: initialize + initialized.
    let init_payload = json!({
        "clientInfo": {
            "name": "ai-session-viewer",
            "title": "AI Session Viewer",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {
            "experimentalApi": true,
        },
    });

    // Build runtime first so send_request can use it
    let next_id = AtomicU64::new(1);
    let rt = Arc::new(Runtime {
        next_id,
        pending,
        subscribers,
        stdin_tx,
        creds_fingerprint: fingerprint,
        alive,
    });

    // initialize request
    send_request(&rt, "initialize", init_payload)
        .await
        .map_err(|e| format!("codex app-server initialize failed: {}", e))?;

    // initialized notification (no id, no response)
    let init_notif = json!({
        "jsonrpc": "2.0",
        "method": "initialized",
    })
    .to_string();
    if rt.stdin_tx.send(init_notif).await.is_err() {
        return Err("codex app-server stdin closed during handshake".to_string());
    }

    // Watchdog — when child exits, drop runtime so next call respawns.
    {
        let alive = rt.alive.clone();
        tokio::spawn(async move {
            let _ = child.wait().await;
            alive.store(false, Ordering::Relaxed);
        });
    }

    Ok(rt)
}

fn handle_inbound_line(line: &str, pending: &PendingMap, subscribers: &SubscriberMap) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("[codex app-server] non-JSON line: {}", trimmed);
            return;
        }
    };

    // Response: has `id` (u64) and either `result` or `error`.
    if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
        let mut p = pending.lock();
        if let Some(sender) = p.remove(&id) {
            if let Some(err) = value.get("error") {
                let msg = err
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("codex app-server error")
                    .to_string();
                let _ = sender.send(Err(msg));
            } else {
                let result = value.get("result").cloned().unwrap_or(Value::Null);
                let _ = sender.send(Ok(result));
            }
            return;
        }
        // Unknown id — could be a server request (we don't handle those yet).
        // Fallthrough to notification handling below.
    }

    // Notification: has `method` (string).
    let Some(method) = value.get("method").and_then(|v| v.as_str()) else {
        return;
    };
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let notification = CodexNotification {
        method: method.to_string(),
        params: params.clone(),
    };

    // Route by threadId in params if present, else broadcast to all.
    let target = params
        .get("threadId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            params
                .get("thread")
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });

    let subs = subscribers.lock();
    if let Some(thread_id) = target {
        if let Some(tx) = subs.get(&thread_id) {
            let _ = tx.try_send(notification);
            return;
        }
    }
    // No threadId match — broadcast.
    for tx in subs.values() {
        let _ = tx.try_send(notification.clone());
    }
}

fn apply_path_and_env(cmd: &mut Command, cli_path: &str, creds: &ResolvedCliCredentials) {
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
        "CODEX_HOME",
    ] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    // PATH: prepend the codex CLI dir + node dir so #!/usr/bin/env node works.
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
            let dir = node_dir.to_path_buf();
            if !paths.iter().any(|p| p == &dir) {
                paths.push(dir);
            }
        }
    }
    if let Some(existing) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&existing) {
            if !paths.iter().any(|x| x == &p) {
                paths.push(p);
            }
        }
    }
    if !paths.is_empty() {
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }

    // Provider creds — codex reads OPENAI_API_KEY / CODEX_API_KEY,
    // OPENAI_BASE_URL / CODEX_BASE_URL.
    for k in &[
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "OPENAI_BASE_URL",
        "CODEX_BASE_URL",
    ] {
        cmd.env_remove(k);
    }
    if !creds.api_key.is_empty() {
        cmd.env("CODEX_API_KEY", &creds.api_key);
        cmd.env("OPENAI_API_KEY", &creds.api_key);
    }
    if !creds.base_url.is_empty() {
        cmd.env("CODEX_BASE_URL", &creds.base_url);
        cmd.env("OPENAI_BASE_URL", &creds.base_url);
    }
}

