use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;

/// CLI configuration info returned to the frontend (API key is masked).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfig {
    pub source: String,
    pub api_key_masked: String,
    pub has_api_key: bool,
    pub base_url: String,
    pub default_model: String,
    pub config_path: String,
}

// ── Internal deserialization structures ──

/// Claude's `~/.claude/settings.json`
#[derive(Debug, Deserialize, Default)]
struct ClaudeSettings {
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    model: Option<String>,
}

// ── Public interface ──

/// Read Claude CLI configuration and return a masked version for the frontend.
pub fn read_cli_config(source: &str) -> Result<CliConfig, String> {
    // For chat features, always use Claude config regardless of source
    let _ = source;
    let (api_key, base_url, default_model, config_path) = read_claude_config()?;

    Ok(CliConfig {
        source: "claude".to_string(),
        api_key_masked: mask_key(&api_key),
        has_api_key: !api_key.is_empty(),
        base_url,
        default_model,
        config_path,
    })
}

/// Get real credentials for internal use (e.g. model_list, quick_chat).
pub(crate) fn get_credentials(_source: &str) -> (String, String) {
    match read_claude_config() {
        Ok((api_key, base_url, _, _)) if !api_key.is_empty() => (api_key, base_url),
        _ => (
            String::new(),
            "https://api.anthropic.com".to_string(),
        ),
    }
}

// ── Internal helpers ──

/// Returns (api_key, base_url, default_model, config_path).
fn read_claude_config() -> Result<(String, String, String, String), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let settings_path = home.join(".claude").join("settings.json");
    let config_path_str = settings_path.display().to_string();

    let settings = read_json_file::<ClaudeSettings>(&settings_path).unwrap_or_default();

    // API key priority: settings.json env → environment variable
    let api_key = settings
        .env
        .get("ANTHROPIC_AUTH_TOKEN")
        .filter(|s| !s.is_empty())
        .or_else(|| settings.env.get("ANTHROPIC_API_KEY").filter(|s| !s.is_empty()))
        .cloned()
        .or_else(|| env::var("ANTHROPIC_AUTH_TOKEN").ok().filter(|s| !s.is_empty()))
        .or_else(|| env::var("ANTHROPIC_API_KEY").ok().filter(|s| !s.is_empty()))
        .unwrap_or_default();

    // Base URL: settings.json env → environment variable → default
    let base_url = settings
        .env
        .get("ANTHROPIC_BASE_URL")
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| env::var("ANTHROPIC_BASE_URL").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());

    let default_model = settings.model.unwrap_or_default();

    Ok((api_key, base_url, default_model, config_path_str))
}

fn mask_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let len = key.len();
    if len <= 8 {
        return "*".repeat(len);
    }
    let prefix = &key[..3];
    let suffix = &key[len - 4..];
    format!("{}...{}", prefix, suffix)
}

fn read_json_file<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Option<T> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}
