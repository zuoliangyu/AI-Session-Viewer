use std::path::PathBuf;

/// Get the Claude home directory (~/.claude)
pub fn get_claude_home() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// Get the Claude projects directory (~/.claude/projects)
pub fn get_projects_dir() -> Option<PathBuf> {
    get_claude_home().map(|h| h.join("projects"))
}

/// Get the stats cache file path (~/.claude/stats-cache.json)
pub fn get_stats_cache_path() -> Option<PathBuf> {
    get_claude_home().map(|h| h.join("stats-cache.json"))
}

/// Decode an encoded project directory name back to a path
/// e.g. "C--Users-zuolan-Desktop-LB" -> "C:\Users\zuolan\Desktop\LB" (on Windows)
/// The encoding replaces path separators with '-' and ':' with '-'
pub fn decode_project_path(encoded: &str) -> String {
    // The encoding scheme used by Claude:
    // - Path separators (/ or \) are replaced with '-'
    // - Drive colon (C:) becomes "C-"
    // So "C--Users-zuolan-Desktop-LB" means "C:\Users\zuolan\Desktop\LB" on Windows
    // And "-Users-zuolan-Desktop-LB" means "/Users/zuolan/Desktop/LB" on Unix

    if cfg!(windows) {
        // On Windows, the pattern is like "C--Users-foo-bar"
        // First char + '-' is drive letter + ':'
        // Then each '-' is a path separator
        if encoded.len() >= 2 && encoded.chars().nth(1) == Some('-') {
            let drive = &encoded[0..1];
            let rest = &encoded[2..]; // skip "C-"
            let path_part = rest.replace('-', "\\");
            format!("{}:{}", drive, path_part)
        } else {
            encoded.replace('-', "\\")
        }
    } else {
        // On Unix, pattern is like "-Users-zuolan-Desktop-LB" -> "/Users/zuolan/Desktop/LB"
        if encoded.starts_with('-') {
            encoded.replace('-', "/")
        } else {
            encoded.replace('-', "/")
        }
    }
}

/// Extract the last path segment as a short name
pub fn short_name_from_path(path: &str) -> String {
    let path = path.trim_end_matches(['/', '\\']);
    if let Some(pos) = path.rfind(['/', '\\']) {
        path[pos + 1..].to_string()
    } else {
        path.to_string()
    }
}
