use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::parser::path_encoder::get_projects_dir;
use crate::provider::codex;

/// Per-session metadata (alias + tags)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// The metadata file structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataFile {
    pub version: u32,
    pub sessions: HashMap<String, SessionMeta>,
}

impl Default for MetadataFile {
    fn default() -> Self {
        Self {
            version: 1,
            sessions: HashMap::new(),
        }
    }
}

/// Resolve the metadata file path for a given source and project
fn metadata_path(source: &str, project_id: &str) -> Option<PathBuf> {
    match source {
        "claude" => {
            resolve_claude_project_dir(project_id).map(|dir| dir.join(".session-viewer-meta.json"))
        }
        "codex" => {
            let codex_home = codex::get_sessions_dir()?.parent()?.to_path_buf();
            Some(codex_home.join(".session-viewer-meta.json"))
        }
        _ => None,
    }
}

fn is_single_normal_component(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn resolve_claude_project_dir(project_id: &str) -> Option<PathBuf> {
    if !is_single_normal_component(project_id) {
        return None;
    }

    let projects_dir = get_projects_dir()?;
    let canonical_base = fs::canonicalize(&projects_dir).ok()?;
    let project_dir = projects_dir.join(project_id);
    if !project_dir.exists() {
        return None;
    }

    let canonical_dir = fs::canonicalize(project_dir).ok()?;
    if !canonical_dir.is_dir() {
        return None;
    }
    let relative = canonical_dir.strip_prefix(&canonical_base).ok()?;

    if relative.components().count() != 1 {
        return None;
    }

    Some(canonical_dir)
}

/// Load metadata file; returns default if not found
pub fn load_metadata(source: &str, project_id: &str) -> MetadataFile {
    let path = match metadata_path(source, project_id) {
        Some(p) => p,
        None => return MetadataFile::default(),
    };

    if !path.exists() {
        return MetadataFile::default();
    }

    fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

/// Save metadata file (atomic: write tmp + rename)
pub fn save_metadata(source: &str, project_id: &str, meta: &MetadataFile) -> Result<(), String> {
    let path = metadata_path(source, project_id)
        .ok_or_else(|| "Cannot resolve metadata path".to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create metadata directory: {}", e))?;
    }

    let content =
        serde_json::to_string_pretty(meta).map_err(|e| format!("Failed to serialize: {}", e))?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, content).map_err(|e| format!("Failed to write tmp: {}", e))?;
    fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to rename: {}", e))?;

    Ok(())
}

/// Update metadata for a single session
pub fn update_session_meta(
    source: &str,
    project_id: &str,
    session_id: &str,
    alias: Option<String>,
    tags: Vec<String>,
) -> Result<(), String> {
    let mut meta = load_metadata(source, project_id);

    // If both alias and tags are empty, remove the entry
    if alias.is_none() && tags.is_empty() {
        meta.sessions.remove(session_id);
    } else {
        meta.sessions
            .insert(session_id.to_string(), SessionMeta { alias, tags });
    }

    save_metadata(source, project_id, &meta)
}

/// Remove metadata for a single session
pub fn remove_session_meta(
    source: &str,
    project_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let mut meta = load_metadata(source, project_id);
    if meta.sessions.remove(session_id).is_some() {
        save_metadata(source, project_id, &meta)?;
    }
    Ok(())
}

/// Get all unique tags used in a project (for autocomplete)
pub fn get_all_tags(source: &str, project_id: &str) -> Vec<String> {
    let meta = load_metadata(source, project_id);
    let mut tags: Vec<String> = meta
        .sessions
        .values()
        .flat_map(|s| s.tags.iter().cloned())
        .collect::<std::collections::HashSet<String>>()
        .into_iter()
        .collect();
    tags.sort();
    tags
}

/// Get tags for all projects across the given source.
/// Returns a map: project_id (encoded_name for Claude, "" for Codex) → deduplicated sorted tags.
pub fn get_all_cross_project_tags(source: &str) -> HashMap<String, Vec<String>> {
    match source {
        "claude" => {
            let projects_dir = match get_projects_dir() {
                Some(d) if d.exists() => d,
                _ => return HashMap::new(),
            };
            let mut result = HashMap::new();
            if let Ok(entries) = fs::read_dir(&projects_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let encoded_name = match path.file_name().and_then(|n| n.to_str()) {
                        Some(name) => name.to_string(),
                        None => continue,
                    };
                    let tags = get_all_tags("claude", &encoded_name);
                    if !tags.is_empty() {
                        result.insert(encoded_name, tags);
                    }
                }
            }
            result
        }
        "codex" => {
            let tags = get_all_tags("codex", "");
            let mut result = HashMap::new();
            if !tags.is_empty() {
                result.insert(String::new(), tags);
            }
            result
        }
        _ => HashMap::new(),
    }
}
