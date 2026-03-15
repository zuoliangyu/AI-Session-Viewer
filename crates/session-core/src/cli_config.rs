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

    // Shell rc fallback: useful when the process is launched without sourcing shell init files
    // (e.g. Tauri desktop shortcut, systemd service running session-web binary)
    let shell_env = read_shell_env(&home);

    // API key priority: settings.json env → process env → shell rc files
    let api_key = settings
        .env
        .get("ANTHROPIC_AUTH_TOKEN")
        .filter(|s| !s.is_empty())
        .or_else(|| settings.env.get("ANTHROPIC_API_KEY").filter(|s| !s.is_empty()))
        .cloned()
        .or_else(|| env::var("ANTHROPIC_AUTH_TOKEN").ok().filter(|s| !s.is_empty()))
        .or_else(|| env::var("ANTHROPIC_API_KEY").ok().filter(|s| !s.is_empty()))
        .or_else(|| shell_env.get("ANTHROPIC_AUTH_TOKEN").filter(|s| !s.is_empty()).cloned())
        .or_else(|| shell_env.get("ANTHROPIC_API_KEY").filter(|s| !s.is_empty()).cloned())
        .unwrap_or_default();

    // Base URL: settings.json env → process env → shell rc files → default
    let base_url = settings
        .env
        .get("ANTHROPIC_BASE_URL")
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| env::var("ANTHROPIC_BASE_URL").ok().filter(|s| !s.is_empty()))
        .or_else(|| shell_env.get("ANTHROPIC_BASE_URL").filter(|s| !s.is_empty()).cloned())
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());

    let default_model = settings.model.unwrap_or_default();

    Ok((api_key, base_url, default_model, config_path_str))
}

/// Parse common shell rc files and extract `export KEY=value` assignments.
/// Only runs on Unix-like systems; returns empty map on Windows.
fn read_shell_env(home: &std::path::Path) -> HashMap<String, String> {
    #[cfg(not(unix))]
    {
        let _ = home;
        HashMap::new()
    }

    #[cfg(unix)]
    {
        let candidates = [
            ".bashrc",
            ".bash_profile",
            ".profile",
            ".zshrc",
            ".zprofile",
        ];

        let mut map = HashMap::new();
        for name in &candidates {
            let path = home.join(name);
            if let Ok(content) = std::fs::read_to_string(&path) {
                parse_shell_exports(&content, &mut map);
            }
        }
        map
    }
}

/// Extract `export KEY=value` (and bare `KEY=value`) lines from shell script content.
/// Handles single-quoted, double-quoted, and unquoted values.
/// Does not evaluate variable references or subshells — purely static parsing.
#[cfg(unix)]
fn parse_shell_exports(content: &str, map: &mut HashMap<String, String>) {
    for line in content.lines() {
        let trimmed = line.trim();
        // Skip comments and empty lines
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Strip optional leading `export `
        let assignment = if let Some(rest) = trimmed.strip_prefix("export ") {
            rest.trim_start()
        } else {
            trimmed
        };
        // Must contain `=`
        let Some(eq_pos) = assignment.find('=') else {
            continue;
        };
        let key = assignment[..eq_pos].trim();
        // Key must be a valid identifier (letters, digits, underscores, no spaces)
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let raw_value = &assignment[eq_pos + 1..];
        let value = unquote(raw_value);
        // Only keep the first occurrence (earlier rc files take precedence)
        map.entry(key.to_string()).or_insert(value);
    }
}

/// Remove surrounding single or double quotes from a shell value string.
#[cfg(unix)]
fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        s[1..s.len() - 1].to_string()
    } else {
        // Strip inline comment: `value # comment`
        if let Some(idx) = s.find(" #") {
            s[..idx].trim().to_string()
        } else {
            s.to_string()
        }
    }
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
