use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::types::BackupSummary;

pub const NAMESPACE: &str = "provider-sync";

pub fn backups_root(codex_home: &Path) -> PathBuf {
    codex_home.join("backups_state").join(NAMESPACE)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackupMetadata {
    pub namespace: String,
    pub codex_home: String,
    pub target_provider: String,
    pub created_at: String,
    pub db_files: Vec<String>,
    pub changed_session_files: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaBackupItem {
    pub path: String,
    pub original_line: String,
    pub line_index: usize,
    pub original_mtime_secs: i64,
}

pub fn create_backup_dir(codex_home: &Path) -> Result<PathBuf, String> {
    let now: DateTime<Utc> = Utc::now();
    let slug = now.format("%Y%m%dT%H%M%SZ").to_string();
    let root = backups_root(codex_home);
    let mut dir = root.join(&slug);
    let mut suffix = 0u32;
    while dir.exists() {
        suffix += 1;
        dir = root.join(format!("{}-{}", slug, suffix));
    }
    fs::create_dir_all(dir.join("db")).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn list_backups(codex_home: &Path) -> Vec<BackupSummary> {
    let Ok(read) = fs::read_dir(backups_root(codex_home)) else {
        return Vec::new();
    };
    let mut out: Vec<BackupSummary> = read
        .flatten()
        .filter(|e| e.file_type().ok().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let path = entry.path();
            let text = fs::read_to_string(path.join("metadata.json")).ok()?;
            let meta: BackupMetadata = serde_json::from_str(&text).ok()?;
            if meta.namespace != NAMESPACE {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().into_owned();
            Some(BackupSummary {
                name,
                path: path.to_string_lossy().into_owned(),
                created_at: meta.created_at,
                target_provider: meta.target_provider,
                changed_session_count: meta.changed_session_files.len() as u32,
            })
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

pub fn prune_backups(codex_home: &Path, keep: usize) -> Result<u32, String> {
    let backups = list_backups(codex_home);
    if backups.len() <= keep {
        return Ok(0);
    }
    let mut removed = 0u32;
    for old in &backups[keep..] {
        if fs::remove_dir_all(&old.path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}
