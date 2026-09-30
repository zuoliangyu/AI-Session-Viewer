//! JSON-RPC client for `codex app-server` (NDJSON over stdio).
//!
//! Keeps **one runtime per (api_key, base_url) fingerprint** so multiple
//! concurrent panes / users with different credentials never invalidate each
//! other's in-flight requests. Each runtime spawns lazily on first use and is
//! replaced only if its child dies. Each thread can have multiple subscribers
//! — notifications fan out to all of them and disconnected receivers are
//! pruned automatically.
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
use std::num::NonZeroUsize;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use lru::LruCache;

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
/// Cap the number of concurrent codex app-server runtimes per process. Each
/// runtime is a separate codex CLI child; without a cap, rotating
/// credentials (or many users with distinct keys on the web server) would
/// spawn unbounded child processes. Hitting the cap evicts the
/// least-recently-used runtime; closing its stdin makes the codex CLI exit
/// gracefully, which then drains all the helper tasks.
const MAX_RUNTIMES: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexNotification {
    pub method: String,
    pub params: Value,
}

impl CodexNotification {
    /// Turn id carried by a `turn/started` notification (needed for cancel).
    pub fn started_turn_id(&self) -> Option<&str> {
        if self.method != "turn/started" {
            return None;
        }
        self.params.get("turn")?.get("id")?.as_str()
    }

    /// `Some(success)` when this notification ends the turn.
    pub fn turn_outcome(&self) -> Option<bool> {
        match self.method.as_str() {
            "turn/completed" => Some(true),
            "turn/failed" | "error" => Some(false),
            _ => None,
        }
    }
}

/// Result of opening a thread for one chat turn.
pub struct OpenedThread {
    pub thread_id: String,
    /// Prior turns returned by `thread/resume`; `Value::Null` for a new thread.
    pub history_turns: Value,
}

type RpcResultSender = oneshot::Sender<Result<Value, String>>;
type PendingMap = Arc<PlMutex<HashMap<u64, RpcResultSender>>>;
/// Each thread can have multiple subscribers (e.g. two panes resuming the
/// same thread). Disconnected senders are pruned during dispatch.
type SubscriberMap = Arc<PlMutex<HashMap<String, Vec<mpsc::Sender<CodexNotification>>>>>;

/// One spawned app-server process plus its plumbing.
struct Runtime {
    next_id: AtomicU64,
    pending: PendingMap,
    /// thread_id -> subscribers. Notifications without a thread_id (e.g.
    /// server-wide errors) fan out to *all* current subscribers.
    subscribers: SubscriberMap,
    stdin_tx: mpsc::Sender<String>,
    #[allow(dead_code)]
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
    /// fingerprint -> runtime, capped at MAX_RUNTIMES with LRU eviction.
    /// A separate runtime is kept for every distinct (api_key, base_url)
    /// pair so cancels / new turns from one credential set never tear down
    /// another's process. When the cap is reached, the least-recently-used
    /// runtime is evicted (its stdin closes, codex CLI exits gracefully).
    inner: AsyncMutex<LruCache<String, Arc<Runtime>>>,
}

impl Default for CodexAppServer {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexAppServer {
    /// `thread/resume` when `resume_thread_id` is given, else `thread/start`.
    pub async fn open_thread(
        &self,
        creds: &ResolvedCliCredentials,
        cwd: &str,
        model: Option<&str>,
        resume_thread_id: Option<&str>,
    ) -> Result<OpenedThread, String> {
        let thread_id_of = |resp: &Value| {
            resp.get("thread")
                .and_then(|t| t.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        if let Some(thread_id) = resume_thread_id {
            let resp = self
                .resume_thread(creds, thread_id, cwd, model)
                .await
                .map_err(|e| format!("codex thread/resume failed: {e}"))?;
            Ok(OpenedThread {
                thread_id: thread_id_of(&resp).unwrap_or_else(|| thread_id.to_string()),
                history_turns: resp
                    .get("thread")
                    .and_then(|t| t.get("turns"))
                    .cloned()
                    .unwrap_or(Value::Null),
            })
        } else {
            let resp = self
                .start_thread(creds, cwd, model)
                .await
                .map_err(|e| format!("codex thread/start failed: {e}"))?;
            Ok(OpenedThread {
                thread_id: thread_id_of(&resp)
                    .ok_or_else(|| "codex thread/start: missing thread.id".to_string())?,
                history_turns: Value::Null,
            })
        }
    }

    pub fn new() -> Self {
        Self {
            inner: AsyncMutex::new(LruCache::new(
                NonZeroUsize::new(MAX_RUNTIMES).expect("MAX_RUNTIMES must be > 0"),
            )),
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

    /// Look up (or spawn) the runtime for these credentials. Other
    /// fingerprints' runtimes are untouched, except for whichever entry the
    /// LRU evicts when adding a new one beyond MAX_RUNTIMES.
    async fn ensure(&self, creds: &ResolvedCliCredentials) -> Result<Arc<Runtime>, String> {
        let fingerprint = format!("{}|{}", creds.api_key, creds.base_url);
        let mut guard = self.inner.lock().await;

        if let Some(rt) = guard.get(&fingerprint).cloned() {
            if rt.alive.load(Ordering::Relaxed) {
                return Ok(rt);
            }
            // Dead child — drop the stale entry and respawn below.
            rt.fail_pending("codex app-server exited");
            guard.pop(&fingerprint);
        }

        let cli_path = cli::find_cli("codex")?;
        let rt = spawn_runtime(&cli_path, creds, fingerprint.clone()).await?;
        // `LruCache::push` returns the entry that was bumped out (if any) so
        // we can fail its in-flight requests; otherwise their callers would
        // hang on dropped oneshots until the request timeout.
        if let Some((_evicted_key, evicted_rt)) = guard.push(fingerprint, rt.clone()) {
            evicted_rt.fail_pending("codex app-server evicted by LRU");
            // Dropping the Arc here closes stdin (via the stdin_tx mpsc
            // sender being dropped from the Runtime), which makes the codex
            // CLI exit; the watchdog task then flips `alive=false` and drains
            // any straggler pending requests.
        }
        Ok(rt)
    }

    /// Subscribe to notifications for a thread. Multiple subscribers per
    /// thread are supported; each receives every notification independently.
    /// When the returned receiver is dropped, its sender is pruned on the
    /// next dispatch to that thread.
    pub async fn subscribe(
        &self,
        creds: &ResolvedCliCredentials,
        thread_id: &str,
    ) -> Result<mpsc::Receiver<CodexNotification>, String> {
        let rt = self.ensure(creds).await?;
        let (tx, rx) = mpsc::channel(SUBSCRIBER_BUFFER);
        rt.subscribers
            .lock()
            .entry(thread_id.to_string())
            .or_default()
            .push(tx);
        Ok(rx)
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

    pub async fn read_thread(
        &self,
        creds: &ResolvedCliCredentials,
        thread_id: &str,
    ) -> Result<Value, String> {
        self.request(
            creds,
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": true }),
        )
        .await
    }

    pub async fn fork_thread(
        &self,
        creds: &ResolvedCliCredentials,
        thread_id: &str,
        last_turn_id: &str,
    ) -> Result<Value, String> {
        self.request(
            creds,
            "thread/fork",
            json!({
                "threadId": thread_id,
                "lastTurnId": last_turn_id,
                "persistExtendedHistory": true,
            }),
        )
        .await
    }

    pub async fn rollback_thread(
        &self,
        creds: &ResolvedCliCredentials,
        thread_id: &str,
        num_turns: usize,
    ) -> Result<Value, String> {
        self.request(
            creds,
            "thread/rollback",
            json!({ "threadId": thread_id, "numTurns": num_turns }),
        )
        .await
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

    crate::chat_cli::apply_cli_env(&mut cmd, "codex", cli_path, creds)?;

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

    let mut subs = subscribers.lock();
    if let Some(thread_id) = target {
        if let Some(list) = subs.get_mut(&thread_id) {
            dispatch_and_prune(list, &notification);
            // Drop the bucket entirely if its last subscriber went away.
            if list.is_empty() {
                subs.remove(&thread_id);
            }
            return;
        }
    }
    // No threadId match — broadcast to every subscriber and prune dead ones.
    let keys: Vec<String> = subs.keys().cloned().collect();
    for key in keys {
        if let Some(list) = subs.get_mut(&key) {
            dispatch_and_prune(list, &notification);
            if list.is_empty() {
                subs.remove(&key);
            }
        }
    }
}

/// Send `notification` to every sender in `list`, dropping any that the
/// receiver has already closed. A full channel is treated as "still alive"
/// so a slow consumer doesn't get silently unsubscribed.
fn dispatch_and_prune(
    list: &mut Vec<mpsc::Sender<CodexNotification>>,
    notification: &CodexNotification,
) {
    list.retain(|tx| match tx.try_send(notification.clone()) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => true,
        Err(mpsc::error::TrySendError::Closed(_)) => false,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notif(method: &str, params: Value) -> CodexNotification {
        CodexNotification {
            method: method.to_string(),
            params,
        }
    }

    #[test]
    fn notification_helpers_read_turn_lifecycle() {
        let started = notif("turn/started", json!({ "turn": { "id": "t1" } }));
        assert_eq!(started.started_turn_id(), Some("t1"));
        assert_eq!(started.turn_outcome(), None);
        assert_eq!(notif("item/started", json!({ "turn": { "id": "t1" } })).started_turn_id(), None);
        assert_eq!(notif("turn/completed", Value::Null).turn_outcome(), Some(true));
        assert_eq!(notif("turn/failed", Value::Null).turn_outcome(), Some(false));
        assert_eq!(notif("error", Value::Null).turn_outcome(), Some(false));
    }
}
