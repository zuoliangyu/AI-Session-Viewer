use notify::{
    event::ModifyKind, Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use session_core::parser::path_encoder::get_projects_dir;
use session_core::provider::{claude, codex, grok, omp};
use session_core::watcher_batch::{
    collect_until_quiet, is_session_file_change, sync_root_watches, RootWatchAction, RootWatchState,
};

/// Minimum interval between emitting fs-change events to the frontend.
const DEBOUNCE_DURATION: Duration = Duration::from_millis(300);
const MAX_BATCH_DURATION: Duration = Duration::from_secs(1);
const WATCH_REFRESH_INTERVAL: Duration = Duration::from_secs(5);

/// Start watching Claude, Codex, Grok and OMP session directories for changes.
/// Emits "fs-change" events to the frontend when files are modified.
/// Events are debounced to avoid flooding the frontend during batch operations.
pub fn start_watcher(app_handle: AppHandle) -> Result<(), String> {
    let claude_dir = get_projects_dir();
    let codex_dir = codex::get_sessions_dir();
    let grok_dir = grok::get_sessions_dir();
    let omp_dir = omp::get_sessions_dir();

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("Failed to create watcher: {}", e);
                return;
            }
        };

        let directories = [claude_dir, codex_dir, grok_dir, omp_dir];
        let [claude_dir, codex_dir, grok_dir, omp_dir] = &directories;
        let mut watched = [RootWatchState::default(); 4];
        let mut changed = HashSet::new();
        let mut invalidated = HashSet::new();

        loop {
            // A provider may create its session root after the application
            // starts. Retry missing roots periodically instead of giving up
            // at startup when the user has no sessions yet.
            let changed_roots =
                sync_watches(&mut watcher, &directories, &mut watched, &invalidated);
            invalidated.clear();
            changed.extend(changed_roots.iter().cloned());

            if !changed.is_empty() {
                let paths: Vec<PathBuf> = changed.drain().collect();
                let is_claude_change = claude_dir
                    .as_ref()
                    .map(|dir| paths.iter().any(|path| path.starts_with(dir)))
                    .unwrap_or(false);
                let is_codex_change = codex_dir
                    .as_ref()
                    .map(|dir| paths.iter().any(|path| path.starts_with(dir)))
                    .unwrap_or(false);
                let is_grok_change = grok_dir
                    .as_ref()
                    .map(|dir| paths.iter().any(|path| path.starts_with(dir)))
                    .unwrap_or(false);
                let is_omp_change = omp_dir
                    .as_ref()
                    .map(|dir| paths.iter().any(|path| path.starts_with(dir)))
                    .unwrap_or(false);

                // Hand each provider only the paths under its own
                // directory, so it can surgically update just the
                // affected projects/files instead of wiping everything.
                if is_claude_change {
                    if let Some(ref dir) = claude_dir {
                        let provider_paths: Vec<PathBuf> = paths
                            .iter()
                            .filter(|p| p.starts_with(dir))
                            .cloned()
                            .collect();
                        if changed_roots.contains(dir) {
                            claude::invalidate_cache();
                        } else if !provider_paths.is_empty() {
                            claude::invalidate_paths(&provider_paths);
                        }
                    }
                }
                if is_codex_change {
                    if let Some(ref dir) = codex_dir {
                        let provider_paths: Vec<PathBuf> = paths
                            .iter()
                            .filter(|p| p.starts_with(dir))
                            .cloned()
                            .collect();
                        if changed_roots.contains(dir) {
                            codex::invalidate_sessions_cache();
                        } else if !provider_paths.is_empty() {
                            codex::invalidate_paths(&provider_paths);
                        }
                    }
                }
                if is_grok_change {
                    if let Some(ref dir) = grok_dir {
                        let provider_paths: Vec<PathBuf> = paths
                            .iter()
                            .filter(|p| p.starts_with(dir))
                            .cloned()
                            .collect();
                        if changed_roots.contains(dir) {
                            grok::invalidate_sessions_cache();
                        } else if !provider_paths.is_empty() {
                            grok::invalidate_paths(&provider_paths);
                        }
                    }
                }
                if is_omp_change {
                    if let Some(ref dir) = omp_dir {
                        let provider_paths: Vec<PathBuf> = paths
                            .iter()
                            .filter(|path| path.starts_with(dir))
                            .cloned()
                            .collect();
                        if changed_roots.contains(dir) {
                            omp::invalidate_sessions_cache();
                        } else if !provider_paths.is_empty() {
                            omp::invalidate_paths(&provider_paths);
                        }
                    }
                }

                let paths: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();

                let _ = app_handle.emit("fs-change", paths);
            }

            let first = match rx.recv_timeout(WATCH_REFRESH_INTERVAL) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let events =
                collect_until_quiet(first, DEBOUNCE_DURATION, MAX_BATCH_DURATION, |timeout| {
                    rx.recv_timeout(timeout)
                });
            for event in events {
                match event {
                    Ok(event) => {
                        if matches!(
                            event.kind,
                            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
                        ) {
                            invalidated.extend(event.paths.iter().cloned());
                        }
                        changed.extend(
                            event
                                .paths
                                .into_iter()
                                .filter(|path| is_session_file_change(path)),
                        );
                    }
                    Err(error) => eprintln!("Watch error: {error}"),
                }
            }
        }
    });

    Ok(())
}

fn sync_watches(
    watcher: &mut RecommendedWatcher,
    directories: &[Option<PathBuf>; 4],
    watched: &mut [RootWatchState; 4],
    invalidated: &HashSet<PathBuf>,
) -> HashSet<PathBuf> {
    sync_root_watches(
        directories,
        watched,
        invalidated,
        |path, action| match action {
            RootWatchAction::Watch => match watcher.watch(path, RecursiveMode::Recursive) {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("Failed to watch {:?}: {}", path, error);
                    false
                }
            },
            RootWatchAction::Unwatch => watcher.unwatch(path).is_ok(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn watches_provider_root_created_after_startup() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ai-session-viewer-watch-late-root-{}-{unique}",
            std::process::id()
        ));
        let directories = [Some(directory.clone()), None, None, None];
        let mut watched = [RootWatchState::default(); 4];
        let (tx, _rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(tx, Config::default()).unwrap();

        assert!(sync_watches(&mut watcher, &directories, &mut watched, &HashSet::new()).is_empty());

        fs::create_dir_all(&directory).unwrap();
        assert_eq!(
            sync_watches(&mut watcher, &directories, &mut watched, &HashSet::new()),
            HashSet::from([directory.clone()])
        );
        assert!(sync_watches(&mut watcher, &directories, &mut watched, &HashSet::new()).is_empty());

        drop(watcher);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rewatches_provider_root_recreated_before_refresh() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ai-session-viewer-watch-recreated-root-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let directories = [Some(directory.clone()), None, None, None];
        let mut watched = [RootWatchState::default(); 4];
        let (tx, _rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(tx, Config::default()).unwrap();

        assert!(sync_watches(&mut watcher, &directories, &mut watched, &HashSet::new()).is_empty());

        fs::remove_dir_all(&directory).unwrap();
        fs::create_dir_all(&directory).unwrap();
        let changed = sync_watches(
            &mut watcher,
            &directories,
            &mut watched,
            &HashSet::from([directory.clone()]),
        );
        assert_eq!(changed, HashSet::from([directory.clone()]));
        assert!(sync_watches(&mut watcher, &directories, &mut watched, &HashSet::new()).is_empty());

        drop(watcher);
        fs::remove_dir_all(directory).unwrap();
    }
}
