use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Utc};
use uuid::Uuid;

use super::backup::{self, BackupMetadata, SessionMetaBackupItem};
use super::config;
use super::global_state;
use super::rollout;
use super::sqlite_state;
use super::types::*;

/// Same resolution as the Codex provider (`$CODEX_HOME`, else `~/.codex`), so
/// the tool reads and repairs the data Codex actually uses.
pub fn get_codex_home() -> Result<PathBuf, String> {
    crate::provider::codex::get_codex_home()
        .ok_or_else(|| "Cannot resolve user home directory".to_string())
}

pub fn get_status() -> Result<ProviderSyncStatus, String> {
    let codex_home = get_codex_home()?;
    let config_path = codex_home.join("config.toml");
    let (current_provider, implicit) = config::read_current_provider(&config_path);
    let (configured, config_error) = match config::parse_configured_providers(&config_path) {
        Ok(list) => (list, None),
        Err(e) => (config::list_configured_providers(&config_path), Some(e)),
    };

    let sessions_dir = codex_home.join("sessions");
    let archived_dir = codex_home.join("archived_sessions");

    let mut rollout_counts: HashMap<String, u32> = HashMap::new();
    let mut archived_counts: HashMap<String, u32> = HashMap::new();
    let mut encrypted_warnings: HashMap<String, u32> = HashMap::new();
    let mut mismatched_rollouts = 0u32;
    let mut mismatched_archived = 0u32;

    for p in rollout::scan_session_dir(&sessions_dir) {
        if let Some(meta) = rollout::read_meta(&p, true) {
            *rollout_counts.entry(meta.provider.clone()).or_insert(0) += 1;
            if meta.provider != current_provider {
                mismatched_rollouts += 1;
                if meta.has_encrypted_content {
                    *encrypted_warnings.entry(meta.provider).or_insert(0) += 1;
                }
            }
        }
    }
    for p in rollout::scan_session_dir(&archived_dir) {
        if let Some(meta) = rollout::read_meta(&p, true) {
            *archived_counts.entry(meta.provider.clone()).or_insert(0) += 1;
            if meta.provider != current_provider {
                mismatched_archived += 1;
                if meta.has_encrypted_content {
                    *encrypted_warnings.entry(meta.provider).or_insert(0) += 1;
                }
            }
        }
    }

    let sqlite_path = sqlite_state::db_path(&codex_home);
    let sqlite_exists = sqlite_path.exists();
    let sqlite_stats: Vec<SqliteProviderCount> = if sqlite_exists {
        sqlite_state::read_provider_counts(&sqlite_path)
            .into_iter()
            .map(|(provider, archived, count)| SqliteProviderCount {
                provider,
                archived,
                count,
            })
            .collect()
    } else {
        Vec::new()
    };
    let mismatched_sqlite_threads = if sqlite_exists {
        sqlite_state::count_mismatched_threads(&sqlite_path, &current_provider)
    } else {
        0
    };

    let global_state_p = global_state::global_state_path(&codex_home);
    let backups = backup::list_backups(&codex_home);
    let missing_providers = find_missing_providers(
        &configured,
        &current_provider,
        &rollout_counts,
        &archived_counts,
        &sqlite_stats,
    );

    Ok(ProviderSyncStatus {
        codex_home: codex_home.to_string_lossy().into_owned(),
        current_provider,
        current_provider_implicit: implicit,
        config_toml_path: config_path.to_string_lossy().into_owned(),
        config_toml_exists: config_path.exists(),
        configured_providers: configured,
        rollout_stats: to_provider_counts(rollout_counts),
        archived_stats: to_provider_counts(archived_counts),
        sqlite_stats,
        sqlite_path: sqlite_path.to_string_lossy().into_owned(),
        sqlite_exists,
        global_state_path: global_state_p.to_string_lossy().into_owned(),
        global_state_exists: global_state_p.exists(),
        mismatched_rollouts,
        mismatched_archived,
        mismatched_sqlite_threads,
        encrypted_warnings: encrypted_warnings
            .into_iter()
            .map(|(provider, count)| EncryptedWarning { provider, count })
            .collect(),
        backups,
        missing_providers,
        config_error,
    })
}

/// Provider ids referenced by sessions (or by the root `model_provider`) that
/// Codex cannot resolve. Sessions with an empty provider are left out: Codex
/// falls back to the default provider for them.
fn find_missing_providers(
    configured: &[String],
    current_provider: &str,
    rollouts: &HashMap<String, u32>,
    archived: &HashMap<String, u32>,
    sqlite: &[SqliteProviderCount],
) -> Vec<MissingProvider> {
    fn entry<'a>(
        missing: &'a mut HashMap<String, MissingProvider>,
        configured: &[String],
        provider: &str,
    ) -> Option<&'a mut MissingProvider> {
        if provider.is_empty()
            || config::is_builtin_provider(provider)
            || configured.iter().any(|p| p == provider)
        {
            return None;
        }
        Some(
            missing
                .entry(provider.to_string())
                .or_insert_with(|| MissingProvider {
                    provider: provider.to_string(),
                    rollouts: 0,
                    archived: 0,
                    sqlite_threads: 0,
                    is_current: false,
                }),
        )
    }

    let mut missing: HashMap<String, MissingProvider> = HashMap::new();
    for (provider, count) in rollouts {
        if let Some(item) = entry(&mut missing, configured, provider) {
            item.rollouts += count;
        }
    }
    for (provider, count) in archived {
        if let Some(item) = entry(&mut missing, configured, provider) {
            item.archived += count;
        }
    }
    for row in sqlite {
        if let Some(item) = entry(&mut missing, configured, &row.provider) {
            item.sqlite_threads += row.count;
        }
    }
    if let Some(item) = entry(&mut missing, configured, current_provider) {
        item.is_current = true;
    }
    let mut list: Vec<MissingProvider> = missing.into_values().collect();
    list.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then((b.rollouts + b.archived).cmp(&(a.rollouts + a.archived)))
            .then(a.provider.cmp(&b.provider))
    });
    list
}

/// Make sessions saved under `providers` resumable again by appending
/// compatibility `[model_providers.<id>]` definitions to config.toml (see
/// [`config::append_compat_providers`]). Rollouts, SQLite and auth files are
/// not touched; config.toml is backed up first so the repair can be restored
/// from the backup list.
pub fn run_repair(
    providers: Vec<String>,
    template: Option<String>,
    keep: usize,
) -> Result<RepairResult, String> {
    let mut ids: Vec<String> = Vec::new();
    for id in providers.iter().map(|id| id.trim()) {
        if id.is_empty() {
            return Err("provider id cannot be empty".into());
        }
        if config::is_builtin_provider(id) {
            return Err(format!("「{id}」是 Codex 内置 provider，无需修复"));
        }
        if !ids.iter().any(|known| known == id) {
            ids.push(id.to_string());
        }
    }
    if ids.is_empty() {
        return Err("请至少选择一个需要修复的 provider".into());
    }
    let template = template
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if let Some(source) = &template {
        if ids.contains(source) {
            return Err(format!("不能用「{source}」自身作为模板"));
        }
    }

    let codex_home = get_codex_home()?;
    let config_path = codex_home.join("config.toml");
    let backup_dir = backup::create_backup_dir(&codex_home)?;
    let config_existed = backup::copy_existing(&config_path, &backup_dir.join("config.toml"))?;
    let metadata = BackupMetadata {
        namespace: backup::NAMESPACE.to_string(),
        codex_home: codex_home.to_string_lossy().into_owned(),
        target_provider: ids.join(", "),
        created_at: Utc::now().to_rfc3339(),
        db_files: Vec::new(),
        config_existed: Some(config_existed),
        changed_session_files: Vec::new(),
        kind: "repair".to_string(),
    };
    write_backup_metadata(&backup_dir, &metadata)?;

    if let Err(error) = config::append_compat_providers(&config_path, &ids, template.as_deref()) {
        let _ = fs::remove_dir_all(&backup_dir);
        return Err(error);
    }
    let _ = backup::prune_backups(&codex_home, keep.max(1));

    Ok(RepairResult {
        backup_dir: backup_dir.to_string_lossy().into_owned(),
        config_toml_path: config_path.to_string_lossy().into_owned(),
        added_providers: ids,
        template,
    })
}

fn to_provider_counts(map: HashMap<String, u32>) -> Vec<ProviderCount> {
    let mut v: Vec<ProviderCount> = map
        .into_iter()
        .map(|(provider, count)| ProviderCount { provider, count })
        .collect();
    v.sort_by_key(|item| std::cmp::Reverse(item.count));
    v
}

pub fn run_sync(target_override: Option<String>, keep: usize) -> Result<SyncResult, String> {
    let codex_home = get_codex_home()?;
    let config_path = codex_home.join("config.toml");
    let target = target_override.unwrap_or_else(|| config::read_current_provider(&config_path).0);
    let result = sync_to_target(&codex_home, &config_path, &target, keep, false)?;
    crate::provider::codex::invalidate_sessions_cache();
    Ok(result)
}

pub fn run_switch(new_provider: String, keep: usize) -> Result<SyncResult, String> {
    let codex_home = get_codex_home()?;
    let config_path = codex_home.join("config.toml");
    if new_provider.trim().is_empty() {
        return Err("provider id cannot be empty".into());
    }
    let result = sync_to_target(&codex_home, &config_path, &new_provider, keep, true)?;
    crate::provider::codex::invalidate_sessions_cache();
    Ok(result)
}

/// The path a clone's rollout file should take: the original filename with the
/// old session id swapped for the new one. Falls back to `rollout-<newid>.jsonl`
/// in the same directory if the old id isn't embedded in the name.
fn clone_target_path(orig: &Path, old_id: &str, new_id: &str) -> PathBuf {
    let name = orig.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let new_name = if name.contains(old_id) {
        name.replace(old_id, new_id)
    } else {
        format!("rollout-{new_id}.jsonl")
    };
    orig.with_file_name(new_name)
}

/// Non-destructive clone: for each source rollout, write a copy carrying a new
/// id + `target` provider and insert a matching `threads` row, leaving the
/// originals untouched. Backs up `state_5.sqlite` first (we INSERT into it).
pub fn run_clone(
    file_paths: Vec<String>,
    target_provider: String,
    keep: usize,
) -> Result<CloneResult, String> {
    if target_provider.trim().is_empty() {
        return Err("provider id cannot be empty".into());
    }
    let codex_home = get_codex_home()?;
    let sqlite_path = sqlite_state::db_path(&codex_home);

    // Back up the DB before inserting rows, so a bad clone is recoverable.
    let backup_dir = backup::create_backup_dir(&codex_home)?;
    let db_files = backup::copy_database(&codex_home, &backup_dir)?;
    let mut metadata = BackupMetadata {
        namespace: backup::NAMESPACE.to_string(),
        codex_home: codex_home.to_string_lossy().into_owned(),
        target_provider: target_provider.clone(),
        created_at: Utc::now().to_rfc3339(),
        db_files,
        config_existed: None,
        changed_session_files: Vec::new(),
        kind: "sync".to_string(),
    };
    // Publish a restorable DB backup before the first clone changes it.
    write_backup_metadata(&backup_dir, &metadata)?;

    let mut cloned = 0u32;
    let mut skipped: Vec<String> = Vec::new();
    let mut new_session_ids: Vec<String> = Vec::new();
    let mut encrypted_session_ids: Vec<String> = Vec::new();
    let mut created_files: Vec<String> = Vec::new();

    for fp in &file_paths {
        let path = PathBuf::from(fp);
        let Some(meta) = rollout::read_meta(&path, true) else {
            skipped.push(fp.clone());
            continue;
        };
        let Some(old_id) = meta.session_id.clone() else {
            skipped.push(fp.clone());
            continue;
        };

        let new_id = Uuid::new_v4().to_string();
        let new_path = clone_target_path(&path, &old_id, &new_id);

        if rollout::write_cloned_rollout(
            &path,
            &new_path,
            meta.session_meta_line_idx,
            &meta.original_line,
            &target_provider,
            &new_id,
            meta.mtime,
        )
        .is_err()
        {
            skipped.push(fp.clone());
            continue;
        }

        // Mirror the clone into state_5.sqlite so Codex Desktop lists it. If the
        // INSERT fails, drop the just-written rollout to avoid an orphan file.
        if sqlite_path.exists() {
            match sqlite_state::clone_thread(
                &sqlite_path,
                &old_id,
                &new_id,
                &new_path.to_string_lossy(),
                &target_provider,
            ) {
                Ok(_) => {}
                Err(_) => {
                    let _ = fs::remove_file(&new_path);
                    skipped.push(fp.clone());
                    continue;
                }
            }
        }

        if meta.has_encrypted_content {
            encrypted_session_ids.push(new_id.clone());
        }
        created_files.push(new_path.to_string_lossy().into_owned());
        new_session_ids.push(new_id);
        cloned += 1;
    }

    metadata.changed_session_files = created_files;
    let metadata_result = write_backup_metadata(&backup_dir, &metadata);

    let _ = backup::prune_backups(&codex_home, keep.max(1));
    crate::provider::codex::invalidate_sessions_cache();
    metadata_result?;

    Ok(CloneResult {
        backup_dir: backup_dir.to_string_lossy().into_owned(),
        target_provider,
        cloned,
        skipped,
        new_session_ids,
        encrypted_session_ids,
    })
}

fn write_backup_metadata(dir: &Path, metadata: &BackupMetadata) -> Result<(), String> {
    use std::io::Write;

    let json = serde_json::to_string_pretty(metadata)
        .map_err(|error| format!("序列化备份元数据失败：{error}"))?;
    let temporary = dir.join(format!("metadata-{}.tmp", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("创建备份元数据失败：{error}"))?;
    let result = file.write_all(json.as_bytes()).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| fs::rename(&temporary, dir.join("metadata.json")));
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("保存备份元数据失败：{error}"));
    }
    Ok(())
}

fn sync_to_target(
    codex_home: &Path,
    config_path: &Path,
    target: &str,
    keep: usize,
    switch_config: bool,
) -> Result<SyncResult, String> {
    let sessions_dir = codex_home.join("sessions");
    let archived_dir = codex_home.join("archived_sessions");

    let mut all_paths = rollout::scan_session_dir(&sessions_dir);
    all_paths.extend(rollout::scan_session_dir(&archived_dir));

    let mut to_rewrite: Vec<rollout::RolloutMetaInfo> = Vec::new();
    let mut thread_ids_with_user_event: Vec<String> = Vec::new();
    let mut cwd_updates: HashMap<String, String> = HashMap::new();
    let mut seen_ids: HashSet<String> = HashSet::new();

    for p in &all_paths {
        let Some(meta) = rollout::read_meta(p, false) else {
            continue;
        };
        if let Some(sid) = &meta.session_id {
            if seen_ids.insert(sid.clone()) {
                thread_ids_with_user_event.push(sid.clone());
                if let Some(cwd) = &meta.cwd {
                    let normalized = global_state::normalize_path_string(cwd);
                    cwd_updates.insert(sid.clone(), normalized);
                }
            }
        }
        if meta.provider != target {
            to_rewrite.push(meta);
        }
    }

    let backup_dir = backup::create_backup_dir(codex_home)?;
    let sqlite_path = sqlite_state::db_path(codex_home);
    let db_files = backup::copy_database(codex_home, &backup_dir)?;
    let config_existed = backup::copy_existing(config_path, &backup_dir.join("config.toml"))?;
    let global_state_p = global_state::global_state_path(codex_home);
    backup::copy_existing(&global_state_p, &backup_dir.join(".codex-global-state.json"))?;
    let global_state_bak = codex_home.join(".codex-global-state.json.bak");
    backup::copy_existing(
        &global_state_bak,
        &backup_dir.join(".codex-global-state.json.bak"),
    )?;

    let backup_items: Vec<SessionMetaBackupItem> = to_rewrite
        .iter()
        .map(|m| {
            let secs = m
                .mtime
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            SessionMetaBackupItem {
                path: m.path.to_string_lossy().into_owned(),
                original_line: m.original_line.clone(),
                line_index: m.session_meta_line_idx,
                original_mtime_secs: secs,
            }
        })
        .collect();
    let backup_json = serde_json::to_string_pretty(&backup_items)
        .map_err(|e| format!("serialize session-meta-backup: {}", e))?;
    fs::write(backup_dir.join("session-meta-backup.json"), backup_json)
        .map_err(|e| e.to_string())?;

    let now: DateTime<Utc> = Utc::now();
    let metadata = BackupMetadata {
        namespace: backup::NAMESPACE.to_string(),
        codex_home: codex_home.to_string_lossy().into_owned(),
        target_provider: target.to_string(),
        created_at: now.to_rfc3339(),
        db_files,
        config_existed: Some(config_existed),
        changed_session_files: backup_items.iter().map(|i| i.path.clone()).collect(),
        kind: "sync".to_string(),
    };
    write_backup_metadata(&backup_dir, &metadata)?;

    // Every backup must succeed before changing the provider.
    if switch_config {
        config::set_root_provider(config_path, target)?;
    }

    let updated_sqlite_rows = if sqlite_path.exists() {
        sqlite_state::update_threads(
            &sqlite_path,
            target,
            &thread_ids_with_user_event,
            &cwd_updates,
        )?
    } else {
        0
    };

    let mut updated_rollouts = 0u32;
    let mut skipped_locked: Vec<String> = Vec::new();
    for meta in &to_rewrite {
        match rollout::rewrite_session_meta_provider(
            &meta.path,
            meta.session_meta_line_idx,
            &meta.original_line,
            target,
            meta.mtime,
        ) {
            Ok(_) => updated_rollouts += 1,
            Err(_) => skipped_locked.push(meta.path.to_string_lossy().into_owned()),
        }
    }

    let global_state_updated = global_state::normalize_paths(&global_state_p).unwrap_or(false);

    let _ = backup::prune_backups(codex_home, keep.max(1));

    Ok(SyncResult {
        backup_dir: backup_dir.to_string_lossy().into_owned(),
        target_provider: target.to_string(),
        updated_rollouts,
        updated_sqlite_rows,
        global_state_updated,
        config_updated: switch_config,
        skipped_locked,
    })
}

pub fn run_restore(backup_dir: &str, opts: RestoreOptions) -> Result<RestoreResult, String> {
    let codex_home = get_codex_home()?;
    let dir = PathBuf::from(backup_dir);
    let result = restore_backup(&codex_home, &dir, opts)?;
    crate::provider::codex::invalidate_sessions_cache();
    Ok(result)
}

fn restore_backup(
    codex_home: &Path,
    dir: &Path,
    opts: RestoreOptions,
) -> Result<RestoreResult, String> {
    let meta_text = fs::read_to_string(dir.join("metadata.json"))
        .map_err(|e| format!("read metadata.json: {}", e))?;
    let metadata: BackupMetadata =
        serde_json::from_str(&meta_text).map_err(|e| format!("parse metadata: {}", e))?;
    if metadata.namespace != backup::NAMESPACE {
        return Err("not a provider-sync backup".into());
    }

    let mut restored_files = 0u32;
    let mut restored_sessions = 0u32;

    if opts.include_config {
        let src = dir.join("config.toml");
        if metadata.config_existed == Some(false) {
            match fs::remove_file(codex_home.join("config.toml")) {
                Ok(()) => restored_files += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("恢复缺省 config.toml 失败：{error}")),
            }
        } else if metadata.config_existed == Some(true) || src.exists() {
            fs::copy(&src, codex_home.join("config.toml")).map_err(|e| e.to_string())?;
            restored_files += 1;
        }
    }
    if opts.include_db {
        for name in &metadata.db_files {
            let src = dir.join("db").join(name);
            if src.exists() {
                fs::copy(&src, codex_home.join(name)).map_err(|e| e.to_string())?;
                restored_files += 1;
            }
        }
    }
    if opts.include_global_state {
        let src = dir.join(".codex-global-state.json");
        if src.exists() {
            fs::copy(&src, codex_home.join(".codex-global-state.json"))
                .map_err(|e| e.to_string())?;
            restored_files += 1;
        }
        let src_bak = dir.join(".codex-global-state.json.bak");
        if src_bak.exists() {
            let _ = fs::copy(&src_bak, codex_home.join(".codex-global-state.json.bak"));
        }
    }
    if opts.include_sessions {
        let text = fs::read_to_string(dir.join("session-meta-backup.json")).unwrap_or_default();
        if !text.is_empty() {
            let items: Vec<SessionMetaBackupItem> = serde_json::from_str(&text)
                .map_err(|e| format!("parse session-meta-backup: {}", e))?;
            for item in items {
                let path = PathBuf::from(&item.path);
                if !path.exists() {
                    continue;
                }
                if rollout::restore_session_meta(
                    &path,
                    item.line_index,
                    &item.original_line,
                    item.original_mtime_secs,
                )
                .is_ok()
                {
                    restored_sessions += 1;
                }
            }
        }
    }

    Ok(RestoreResult {
        restored_files,
        restored_sessions,
    })
}

pub fn run_prune_backups(keep: usize) -> Result<u32, String> {
    let codex_home = get_codex_home()?;
    backup::prune_backups(&codex_home, keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestHome(PathBuf);

    impl TestHome {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("asv-provider-backup-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn config_only() -> RestoreOptions {
        RestoreOptions {
            include_config: true,
            include_db: false,
            include_sessions: false,
            include_global_state: false,
        }
    }

    #[test]
    fn switch_backup_restores_original_config_bytes() {
        let home = TestHome::new();
        let config_path = home.0.join("config.toml");
        let original = "# Keep this comment\nmodel_provider = \"old\"\nmodel = \"gpt-5\"\n";
        fs::write(&config_path, original).unwrap();

        let result = sync_to_target(&home.0, &config_path, "new", 5, true).unwrap();
        assert_eq!(config::read_current_provider(&config_path).0, "new");
        assert_eq!(
            fs::read_to_string(Path::new(&result.backup_dir).join("config.toml")).unwrap(),
            original
        );
        restore_backup(&home.0, Path::new(&result.backup_dir), config_only()).unwrap();
        assert_eq!(fs::read_to_string(&config_path).unwrap(), original);
    }

    #[test]
    fn switch_backup_restores_absent_config() {
        let home = TestHome::new();
        let config_path = home.0.join("config.toml");

        let result = sync_to_target(&home.0, &config_path, "new", 5, true).unwrap();
        assert!(config_path.is_file());
        restore_backup(&home.0, Path::new(&result.backup_dir), config_only()).unwrap();
        assert!(!config_path.exists());
        assert_eq!(config::read_current_provider(&config_path), ("openai".to_string(), true));
    }

    #[test]
    fn failed_backup_leaves_config_database_and_rollout_unchanged() {
        let home = TestHome::new();
        let config_path = home.0.join("config.toml");
        let config = "model_provider = \"old\"\n";
        fs::write(&config_path, config).unwrap();
        let database = home.0.join("state_5.sqlite");
        fs::write(&database, b"unchanged database").unwrap();
        let sessions = home.0.join("sessions");
        fs::create_dir(&sessions).unwrap();
        let rollout_path = sessions.join("rollout-test.jsonl");
        let rollout = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"test\",\"model_provider\":\"old\",\"cwd\":\"/project\"}}\n";
        fs::write(&rollout_path, rollout).unwrap();
        // A directory cannot be copied as the global-state backup file.
        fs::create_dir(home.0.join(".codex-global-state.json")).unwrap();

        let error = sync_to_target(&home.0, &config_path, "new", 5, true).unwrap_err();
        assert!(error.contains("备份"));
        assert_eq!(fs::read_to_string(&config_path).unwrap(), config);
        assert_eq!(fs::read(&database).unwrap(), b"unchanged database");
        assert_eq!(fs::read_to_string(&rollout_path).unwrap(), rollout);
        assert!(backup::list_backups(&home.0).is_empty());
    }

    #[test]
    fn database_backup_failure_is_not_ignored() {
        let home = TestHome::new();
        fs::write(home.0.join("state_5.sqlite"), b"database").unwrap();
        fs::create_dir(home.0.join("state_5.sqlite-wal")).unwrap();
        let dir = backup::create_backup_dir(&home.0).unwrap();
        assert!(backup::copy_database(&home.0, &dir).is_err());
    }

    #[test]
    fn old_backup_metadata_remains_readable() {
        let metadata: BackupMetadata = serde_json::from_value(serde_json::json!({
            "namespace": "provider-sync", "codexHome": "/codex",
            "targetProvider": "old", "createdAt": "2026-01-01T00:00:00Z",
            "dbFiles": [], "changedSessionFiles": []
        }))
        .unwrap();
        assert_eq!(metadata.config_existed, None);
    }
}
