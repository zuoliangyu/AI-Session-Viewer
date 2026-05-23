use serde::{Deserialize, Deserializer, Serialize};

/// The sessions-index.json file structure (Claude only)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsIndex {
    pub version: Option<u32>,
    pub entries: Vec<SessionsIndexFileEntry>,
    pub original_path: Option<String>,
}

/// Deserialize file_mtime that may be u64 or f64 (truncated to u64)
fn deserialize_mtime<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let v: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    Ok(v.and_then(|val| match val {
        serde_json::Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
        _ => None,
    }))
}

/// Raw entry from sessions-index.json (Claude internal format)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsIndexFileEntry {
    pub session_id: String,
    pub full_path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_mtime")]
    pub file_mtime: Option<u64>,
    pub first_prompt: Option<String>,
    pub message_count: Option<u32>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub git_branch: Option<String>,
    pub project_path: Option<String>,
    pub is_sidechain: Option<bool>,
}

/// Scan-time classification of a session file.
///
/// - `Valid`   — has messages and the JSONL parsed cleanly.
/// - `Empty`   — file exists but has no user/assistant messages
///               (typical: CC opened a chat then closed without sending).
/// - `Corrupt` — has messages BUT a non-last line failed to parse.
///               Usually means the file has mid-file NUL bytes / sparse
///               holes left over from a SIGKILL'd / crashed CC writer.
///               Still readable in tolerant mode (broken lines silently
///               skipped by `parse_all_messages`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    #[default]
    Valid,
    Empty,
    Corrupt,
}

/// Unified session entry returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    /// "claude" or "codex"
    pub source: String,
    pub session_id: String,
    /// Full file path (both sources need this)
    pub file_path: String,
    pub first_prompt: Option<String>,
    pub message_count: u32,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub git_branch: Option<String>,
    pub project_path: Option<String>,
    // Claude-specific
    pub is_sidechain: Option<bool>,
    // Codex-specific
    pub cwd: Option<String>,
    pub model_provider: Option<String>,
    pub cli_version: Option<String>,
    // User metadata
    pub alias: Option<String>,
    pub tags: Option<Vec<String>>,
    /// Scan-time health classification. Defaulted to `Valid` so that
    /// older cache files without this field still deserialize cleanly.
    #[serde(default)]
    pub status: SessionStatus,
}
