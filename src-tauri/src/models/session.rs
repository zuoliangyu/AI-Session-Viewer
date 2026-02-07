use serde::{Deserialize, Serialize};

/// The sessions-index.json file structure
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsIndex {
    pub version: Option<u32>,
    pub entries: Vec<SessionIndexEntry>,
    pub original_path: Option<String>,
}

/// A single entry in sessions-index.json
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub session_id: String,
    pub full_path: Option<String>,
    pub file_mtime: Option<u64>,
    pub first_prompt: Option<String>,
    pub message_count: Option<u32>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub git_branch: Option<String>,
    pub project_path: Option<String>,
    pub is_sidechain: Option<bool>,
}

/// Session info derived from scanning JSONL files when no index is available
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub first_prompt: Option<String>,
    pub message_count: u32,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub git_branch: Option<String>,
    pub project_path: Option<String>,
}
