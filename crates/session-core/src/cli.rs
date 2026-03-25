use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallation {
    pub path: String,
    pub version: Option<String>,
    pub cli_type: String, // "claude"
}

/// Find the Claude CLI binary path.
pub fn find_cli(_cli_type: &str) -> Result<String, String> {
    // Try system lookup first (which/where)
    // On Windows, search without extension so `where` uses PATHEXT
    // to find .exe, .cmd, .bat etc.
    if let Some(path) = which_binary("claude") {
        return Ok(path);
    }

    // Try known paths
    for candidate in claude_known_paths() {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err("Claude CLI not found. Please install it first.".to_string())
}

/// Find the Codex CLI binary path (npm/nvm only).
fn find_codex() -> Option<String> {
    if let Some(path) = which_binary("codex") {
        return Some(path);
    }
    for candidate in codex_npm_nvm_paths() {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// Discover installed CLIs (Claude + Codex).
pub fn discover_installations() -> Vec<CliInstallation> {
    let mut installations = Vec::new();

    if let Ok(path) = find_cli("claude") {
        let version = get_cli_version(&path);
        installations.push(CliInstallation {
            path,
            version,
            cli_type: "claude".to_string(),
        });
    }

    if let Some(path) = find_codex() {
        let version = get_cli_version(&path);
        installations.push(CliInstallation {
            path,
            version,
            cli_type: "codex".to_string(),
        });
    }

    installations
}

/// Use `where` (Windows) or `which` (Unix) to find a binary.
fn which_binary(name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let result = Command::new("where").arg(name).output();
        if let Ok(output) = result {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let lower = trimmed.to_lowercase();
                    if lower.ends_with(".exe") || lower.ends_with(".cmd") {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        // First try direct which
        if let Ok(output) = Command::new("which").arg(name).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
        // Fallback: run via login shell to inherit nvm / asdf PATH
        for shell in &["zsh", "bash"] {
            let cmd = format!("which {name}");
            if let Ok(output) = Command::new(shell).args(["-l", "-c", &cmd]).output() {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !path.is_empty() && !path.contains("not found") {
                        return Some(path);
                    }
                }
            }
        }
    }

    None
}

/// Known installation paths for Claude CLI.
fn claude_known_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let home = dirs::home_dir();

    if let Some(ref home) = home {
        // npm global (Windows: .cmd shim; Unix: plain binary)
        if cfg!(windows) {
            paths.push(home.join("AppData/Roaming/npm/claude.cmd"));
            paths.push(home.join("AppData/Roaming/npm/claude.exe"));
        } else {
            paths.push(home.join(".npm-global/bin/claude"));
        }

        // NVM (Unix/Mac): ~/.nvm/versions/node/{version}/bin/claude
        let nvm_dir = home.join(".nvm/versions/node");
        if nvm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                for entry in entries.flatten() {
                    let bin_dir = entry.path().join("bin");
                    if cfg!(windows) {
                        paths.push(bin_dir.join("claude.cmd"));
                        paths.push(bin_dir.join("claude.exe"));
                    } else {
                        paths.push(bin_dir.join("claude"));
                    }
                }
            }
        }

        // nvm-windows: %APPDATA%\nvm\{version}\claude.cmd
        #[cfg(windows)]
        if let Ok(appdata) = std::env::var("APPDATA") {
            let nvm_win_dir = PathBuf::from(&appdata).join("nvm");
            if nvm_win_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_win_dir) {
                    for entry in entries.flatten() {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            paths.push(entry.path().join("claude.cmd"));
                            paths.push(entry.path().join("claude.exe"));
                        }
                    }
                }
            }
        }

        // NVM_DIR env var (nvm sets this; works even if not in ~/.nvm)
        #[cfg(not(windows))]
        if let Ok(nvm_dir_env) = std::env::var("NVM_DIR") {
            let nvm_versions = PathBuf::from(&nvm_dir_env).join("versions/node");
            if nvm_versions.exists() && nvm_versions != nvm_dir {
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    for entry in entries.flatten() {
                        paths.push(entry.path().join("bin").join("claude"));
                    }
                }
            }
        }

        // Local bin (Unix)
        if !cfg!(windows) {
            paths.push(home.join(".local/bin/claude"));
        }

        // Bun global
        if cfg!(windows) {
            paths.push(home.join(".bun/bin/claude.exe"));
        } else {
            paths.push(home.join(".bun/bin/claude"));
        }
    }

    // System paths (Unix)
    #[cfg(not(windows))]
    {
        paths.push(PathBuf::from("/usr/local/bin/claude"));
        paths.push(PathBuf::from("/opt/homebrew/bin/claude"));
    }

    paths
}

/// Known npm/nvm-only paths for Codex CLI (codex is npm-only, no bun/brew support).
fn codex_npm_nvm_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let home = dirs::home_dir();

    if let Some(ref home) = home {
        // npm global
        if cfg!(windows) {
            paths.push(home.join("AppData/Roaming/npm/codex.cmd"));
            paths.push(home.join("AppData/Roaming/npm/codex.exe"));
        } else {
            paths.push(home.join(".npm-global/bin/codex"));
        }

        // NVM (Unix/Mac): ~/.nvm/versions/node/{version}/bin/codex
        let nvm_dir = home.join(".nvm/versions/node");
        if nvm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                for entry in entries.flatten() {
                    let bin_dir = entry.path().join("bin");
                    if cfg!(windows) {
                        paths.push(bin_dir.join("codex.cmd"));
                        paths.push(bin_dir.join("codex.exe"));
                    } else {
                        paths.push(bin_dir.join("codex"));
                    }
                }
            }
        }

        // nvm-windows: %APPDATA%\nvm\{version}\codex.cmd
        #[cfg(windows)]
        if let Ok(appdata) = std::env::var("APPDATA") {
            let nvm_win_dir = PathBuf::from(&appdata).join("nvm");
            if nvm_win_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_win_dir) {
                    for entry in entries.flatten() {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            paths.push(entry.path().join("codex.cmd"));
                            paths.push(entry.path().join("codex.exe"));
                        }
                    }
                }
            }
        }

        // NVM_DIR env var (Unix/Mac)
        #[cfg(not(windows))]
        if let Ok(nvm_dir_env) = std::env::var("NVM_DIR") {
            let nvm_versions = PathBuf::from(&nvm_dir_env).join("versions/node");
            if nvm_versions.exists() && nvm_versions != nvm_dir {
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    for entry in entries.flatten() {
                        paths.push(entry.path().join("bin").join("codex"));
                    }
                }
            }
        }
    }

    paths
}

/// Get CLI version by running `<cli> --version`.
fn get_cli_version(path: &str) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let version = stdout.trim().to_string();
        if version.is_empty() {
            None
        } else {
            Some(version)
        }
    } else {
        None
    }
}
