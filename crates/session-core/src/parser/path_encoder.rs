use std::path::{Path, PathBuf};

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

/// Simulate Claude Code's path encoding: non-ASCII-alphanumeric characters become `-`
fn encode_path_segment(segment: &str) -> String {
    segment
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Decode an encoded project directory name back to a path (best-effort fallback)
/// Prefer using originalPath from sessions-index.json when available
pub fn decode_project_path(encoded: &str) -> String {
    if cfg!(windows) {
        if encoded.len() >= 2 && encoded.chars().nth(1) == Some('-') {
            let drive = &encoded[0..1];
            let rest = &encoded[2..];
            let path_part = rest.replace('-', "\\");
            format!("{}:{}", drive, path_part)
        } else {
            encoded.replace('-', "\\")
        }
    } else {
        encoded.replace('-', "/")
    }
}

/// Result of validated path decoding
pub struct DecodedPath {
    /// The decoded display path (real filesystem path if matched, basic decode otherwise)
    pub display_path: String,
    /// Whether the decoded path actually exists on the filesystem
    pub path_exists: bool,
}

/// Decode an encoded project path with filesystem validation.
///
/// Walks the encoded segments, matching each against actual directory entries
/// by re-encoding them and comparing. This recovers the original path including
/// non-ASCII characters (Chinese, etc.), dots, and other characters that are
/// all encoded as `-` by Claude Code.
///
/// Falls back to basic `decode_project_path` if filesystem matching fails.
pub fn decode_project_path_validated(encoded: &str) -> DecodedPath {
    // Split the encoded name by `-` (the universal separator)
    // But first, handle drive prefix on Windows (e.g., "C--Users-foo")
    // and Unix root (leading `-` means `/`)

    if cfg!(windows) {
        decode_validated_windows(encoded)
    } else {
        decode_validated_unix(encoded)
    }
}

fn decode_validated_windows(encoded: &str) -> DecodedPath {
    // Windows: "C--Users-project" → "C:\Users\project"
    // The `--` after drive letter encodes `:\`
    // But within path segments, `-` could be a real `-` or a separator

    // Extract drive prefix: first char + "--"
    if encoded.len() < 3 || !encoded.as_bytes()[0].is_ascii_alphabetic() {
        let basic = decode_project_path(encoded);
        let exists = Path::new(&basic).exists();
        return DecodedPath {
            display_path: basic,
            path_exists: exists,
        };
    }

    // Check for drive pattern: "X-..." where X is a letter
    let drive_letter = encoded.chars().next().unwrap();
    let after_drive = &encoded[1..];

    // After drive letter, expect `-` (encoding of `:`)
    if !after_drive.starts_with('-') {
        let basic = decode_project_path(encoded);
        let exists = Path::new(&basic).exists();
        return DecodedPath {
            display_path: basic,
            path_exists: exists,
        };
    }

    let root = format!("{}:\\", drive_letter);
    let root_path = PathBuf::from(&root);

    if !root_path.exists() {
        let basic = decode_project_path(encoded);
        return DecodedPath {
            display_path: basic,
            path_exists: false,
        };
    }

    // The rest after "X-" contains the path segments separated by `-`
    let remaining = &after_drive[1..]; // skip the first `-` after drive letter
    match resolve_segments(&root_path, remaining) {
        Some(resolved) => {
            let display = resolved.to_string_lossy().to_string();
            DecodedPath {
                path_exists: true,
                display_path: display,
            }
        }
        None => {
            let basic = decode_project_path(encoded);
            let exists = Path::new(&basic).exists();
            DecodedPath {
                display_path: basic,
                path_exists: exists,
            }
        }
    }
}

fn decode_validated_unix(encoded: &str) -> DecodedPath {
    // Unix: "-home-user-project" → "/home/user/project"
    // Leading `-` encodes root `/`

    let root_path = PathBuf::from("/");
    let remaining = encoded.trim_start_matches('-');

    if remaining.is_empty() {
        return DecodedPath {
            display_path: "/".to_string(),
            path_exists: true,
        };
    }

    match resolve_segments(&root_path, remaining) {
        Some(resolved) => {
            let display = resolved.to_string_lossy().to_string();
            DecodedPath {
                path_exists: true,
                display_path: display,
            }
        }
        None => {
            let basic = decode_project_path(encoded);
            let exists = Path::new(&basic).exists();
            DecodedPath {
                display_path: basic,
                path_exists: exists,
            }
        }
    }
}

/// Core segment resolver: given a base directory and the remaining encoded string,
/// try to match real filesystem entries by greedily consuming encoded segments.
///
/// Strategy: try progressively longer segments (joining with `-`) and check if
/// any child of the current directory encodes to that segment.
fn resolve_segments(base: &Path, remaining: &str) -> Option<PathBuf> {
    if remaining.is_empty() {
        return Some(base.to_path_buf());
    }

    let parts: Vec<&str> = remaining.split('-').collect();
    resolve_segments_recursive(base, &parts, 0)
}

fn resolve_segments_recursive(current: &Path, parts: &[&str], start: usize) -> Option<PathBuf> {
    if start >= parts.len() {
        return Some(current.to_path_buf());
    }

    // Read directory entries (cached per call — we iterate children once)
    let dir_entries: Vec<(String, String)> = match std::fs::read_dir(current) {
        Ok(rd) => rd
            .flatten()
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let encoded = encode_path_segment(&name);
                (name, encoded)
            })
            .collect(),
        Err(_) => return None,
    };

    // Try consuming 1, 2, 3, ... parts as a single segment name
    // (because a real directory name might contain `-` which also encodes to `-`)
    let max_consume = parts.len() - start;

    // Also try `--` → `.` heuristic for hidden directories (Unix)
    // When we see an empty part (from splitting `--`), it might be a `.` prefix

    for count in 1..=max_consume {
        let candidate_encoded: String = parts[start..start + count].join("-");

        // Skip empty candidates
        if candidate_encoded.is_empty() {
            continue;
        }

        // Check: does any directory entry encode to this candidate?
        for (real_name, entry_encoded) in &dir_entries {
            if *entry_encoded == candidate_encoded {
                let child = current.join(real_name);
                if start + count >= parts.len() {
                    // We consumed all parts
                    return Some(child);
                }
                // Only recurse into directories
                if child.is_dir() {
                    if let Some(result) =
                        resolve_segments_recursive(&child, parts, start + count)
                    {
                        return Some(result);
                    }
                }
                // If not a directory or recursion failed, try consuming more parts
            }
        }

        // Unix `--` → `.` heuristic: if candidate starts with empty segment,
        // try matching with a `.` prefix (hidden directories like .claude, .config)
        if !cfg!(windows) && count >= 2 && parts[start].is_empty() {
            // The `--` split as ["", "rest"] → try ".rest"
            let dot_candidate = format!(".{}", &parts[start + 1..start + count].join("-"));
            let dot_encoded = encode_path_segment(&dot_candidate);
            for (real_name, entry_encoded) in &dir_entries {
                if *entry_encoded == dot_encoded {
                    let child = current.join(real_name);
                    if start + count >= parts.len() {
                        return Some(child);
                    }
                    if child.is_dir() {
                        if let Some(result) =
                            resolve_segments_recursive(&child, parts, start + count)
                        {
                            return Some(result);
                        }
                    }
                }
            }
        }
    }

    None
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_path_segment() {
        assert_eq!(encode_path_segment("hello"), "hello");
        assert_eq!(encode_path_segment("hello world"), "hello-world");
        assert_eq!(encode_path_segment("my.project"), "my-project");
        assert_eq!(encode_path_segment(".claude"), "-claude");
        assert_eq!(encode_path_segment("中文目录"), "----");
        assert_eq!(encode_path_segment("test-name"), "test-name");
    }

    #[test]
    fn test_basic_decode_unchanged() {
        // Basic decode should still work the same
        if cfg!(windows) {
            assert_eq!(decode_project_path("C-Users-test"), "C:\\Users\\test");
        } else {
            assert_eq!(decode_project_path("-home-user-test"), "/home/user/test");
        }
    }
}
