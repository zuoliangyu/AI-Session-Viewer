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
    for candidate in known_paths() {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    Err("Claude CLI not found. Please install it first.".to_string())
}

/// Discover installed Claude CLI.
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

    installations
}

/// Use `where` (Windows) or `which` (Unix) to find a binary.
fn which_binary(name: &str) -> Option<String> {
    #[cfg(windows)]
    let result = Command::new("where").arg(name).output();

    #[cfg(not(windows))]
    let result = Command::new("which").arg(name).output();

    if let Ok(output) = result {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // `where` on Windows may return multiple lines.
            // Filter to only accept executable extensions (.exe/.cmd),
            // since npm also creates an extensionless Unix shell script
            // that is not a valid Win32 application.
            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                #[cfg(windows)]
                {
                    let lower = trimmed.to_lowercase();
                    if lower.ends_with(".exe") || lower.ends_with(".cmd") {
                        return Some(trimmed.to_string());
                    }
                }
                #[cfg(not(windows))]
                {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

/// Known installation paths to check.
fn known_paths() -> Vec<PathBuf> {
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

        // NVM paths
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
