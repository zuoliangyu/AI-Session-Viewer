use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// The encoded directory name (e.g. "C--Users-zuolan-Desktop-LB")
    pub encoded_name: String,
    /// Decoded human-readable path (e.g. "C:\Users\zuolan\Desktop\LB")
    pub display_path: String,
    /// Just the last segment for display (e.g. "LB")
    pub short_name: String,
    /// Number of session files
    pub session_count: usize,
    /// Last modified time (ISO 8601)
    pub last_modified: Option<String>,
}
