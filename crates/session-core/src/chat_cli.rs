//! Shared construction of headless chat CLI processes (desktop + web).
//!
//! The desktop app, the web server and the Codex app-server runtime used to
//! carry three copies of the env whitelist / PATH / credential logic, and they
//! had drifted (web didn't clear the environment, only one copy forwarded
//! `CODEX_HOME`). Everything that decides *how* a CLI is launched lives here;
//! callers only own the transport (Tauri events vs WebSocket).

use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::cli;
use crate::cli_config::ResolvedCliCredentials;

/// Host variables forwarded to the CLI; everything else is cleared so a
/// stray `ANTHROPIC_*` / session variable from the launching shell can't leak
/// in. Kept deliberately broad on config-location and proxy variables.
const ENV_WHITELIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
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
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
];

/// Provider credential variables. Always removed first so only the resolved
/// credentials for the chosen source reach the CLI.
const PROVIDER_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_BASE_URL",
    "OPENAI_BASE_URL",
];

/// Reset `cmd`'s environment to the whitelist, prepend the CLI's and node's
/// directories to PATH (entry scripts use `#!/usr/bin/env node`), and inject
/// the resolved provider credentials for `source` ("claude" | "codex").
pub fn apply_cli_env(
    cmd: &mut Command,
    source: &str,
    cli_path: &str,
    credentials: &ResolvedCliCredentials,
) -> Result<(), String> {
    cmd.env_clear();
    for key in ENV_WHITELIST {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    if let Some(path) = compose_path(cli_path)? {
        cmd.env("PATH", path);
    }

    for key in PROVIDER_ENV {
        cmd.env_remove(key);
    }
    match source {
        "codex" => {
            if !credentials.api_key.is_empty() {
                cmd.env("CODEX_API_KEY", &credentials.api_key);
                cmd.env("OPENAI_API_KEY", &credentials.api_key);
            }
            if !credentials.base_url.is_empty() {
                cmd.env("CODEX_BASE_URL", &credentials.base_url);
                cmd.env("OPENAI_BASE_URL", &credentials.base_url);
            }
        }
        "claude" => {
            if !credentials.api_key.is_empty() {
                cmd.env("ANTHROPIC_API_KEY", &credentials.api_key);
                cmd.env("ANTHROPIC_AUTH_TOKEN", &credentials.api_key);
            }
            if !credentials.base_url.is_empty() {
                cmd.env("ANTHROPIC_BASE_URL", &credentials.base_url);
            }
        }
        _ => {}
    }
    Ok(())
}

/// CLI dir, then node's dir, then the host PATH, de-duplicated in order.
fn compose_path(cli_path: &str) -> Result<Option<std::ffi::OsString>, String> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut push = |dir: PathBuf| {
        if !paths.iter().any(|existing| existing == &dir) {
            paths.push(dir);
        }
    };
    if let Some(cli_dir) = Path::new(cli_path).parent().filter(|p| !p.as_os_str().is_empty()) {
        push(cli_dir.to_path_buf());
    }
    if let Some(node_path) = cli::find_node() {
        if let Some(node_dir) = Path::new(&node_path).parent().filter(|p| !p.as_os_str().is_empty()) {
            push(node_dir.to_path_buf());
        }
    }
    if let Some(existing) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&existing) {
            push(dir);
        }
    }
    if paths.is_empty() {
        return Ok(None);
    }
    std::env::join_paths(paths)
        .map(Some)
        .map_err(|e| format!("Failed to compose PATH for chat CLI: {e}"))
}

/// Arguments for one headless Claude turn:
/// `[--resume <id>] -p [--model m] --output-format stream-json
///  --include-partial-messages --verbose [--dangerously-skip-permissions] -- <prompt>`.
pub fn claude_print_args(
    prompt: &str,
    model: &str,
    skip_permissions: bool,
    resume_session_id: Option<&str>,
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(session_id) = resume_session_id {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    }
    args.push("-p".to_string());
    if !model.is_empty() {
        // Claude CLI expects full names like "claude-sonnet-4-6", not the
        // API-style "-latest" aliases.
        args.push("--model".to_string());
        args.push(model.strip_suffix("-latest").unwrap_or(model).to_string());
    }
    args.extend(
        ["--output-format", "stream-json", "--include-partial-messages", "--verbose"]
            .map(String::from),
    );
    if skip_permissions {
        args.push("--dangerously-skip-permissions".to_string());
    }
    // `--` ends option parsing so a prompt starting with `-` is never read as a flag.
    args.push("--".to_string());
    args.push(prompt.to_string());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_args_end_options_before_prompt() {
        let args = claude_print_args("--dangerously-skip-permissions", "claude-x-latest", false, Some("abc"));
        assert_eq!(&args[..3], ["--resume", "abc", "-p"]);
        assert!(args.contains(&"claude-x".to_string()));
        assert!(!args[..args.len() - 1].contains(&"--dangerously-skip-permissions".to_string()));
        assert_eq!(&args[args.len() - 2..], ["--", "--dangerously-skip-permissions"]);
    }
}
