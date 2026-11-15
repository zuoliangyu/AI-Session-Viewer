use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootWatchAction {
    Watch,
    Unwatch,
}

#[derive(Clone, Copy, Default)]
pub struct RootWatchState {
    present: Option<bool>,
    watched: bool,
}

impl RootWatchState {
    fn sync(
        &mut self,
        present: bool,
        invalidated: bool,
        mut update: impl FnMut(RootWatchAction) -> bool,
    ) -> bool {
        let mut changed = self.present.is_some_and(|previous| previous != present) || invalidated;
        if self.watched && (!present || invalidated) {
            // Removal may already have dropped the OS watch; either way its
            // registration must be forgotten before the same path is reused.
            update(RootWatchAction::Unwatch);
            self.watched = false;
        }
        if present && !self.watched && update(RootWatchAction::Watch) {
            self.watched = true;
            // Registration after startup may have missed files written while
            // the root was absent or watch registration was failing.
            changed |= self.present.is_some();
        }
        self.present = Some(present);
        changed
    }
}

/// Reconcile only the configured provider roots. Call periodically even when
/// no filesystem events arrive; never watch a parent directory as a fallback.
/// Returned roots require a full provider refresh to cover the unwatched gap.
pub fn sync_root_watches<const N: usize>(
    roots: &[Option<PathBuf>; N],
    states: &mut [RootWatchState; N],
    invalidated: &HashSet<PathBuf>,
    mut update: impl FnMut(&Path, RootWatchAction) -> bool,
) -> HashSet<PathBuf> {
    let mut changed = HashSet::new();
    for (root, state) in roots.iter().zip(states.iter_mut()) {
        let Some(root) = root else { continue };
        if state.sync(root.is_dir(), invalidated.contains(root), |action| {
            update(root, action)
        }) {
            changed.insert(root.clone());
        }
    }
    changed
}

/// Whether a watcher event path is a session file change worth a refresh.
/// Our own `.session-viewer-meta.json` writes are excluded so saving an alias
/// or tag doesn't trigger a reload of the list it was saved from.
pub fn is_session_file_change(path: &Path) -> bool {
    if path
        .file_name()
        .is_some_and(|name| name == ".session-viewer-meta.json")
    {
        return false;
    }
    path.extension()
        .is_some_and(|ext| ext == "jsonl" || ext == "json")
}

/// Collect events until no new event arrives for a full `quiet_period`.
///
/// File watchers often emit several events for one write. A trailing debounce
/// keeps all paths in the burst while still collapsing them into one refresh.
pub fn collect_until_quiet<T, F>(
    first: T,
    quiet_period: Duration,
    max_wait: Duration,
    mut receive: F,
) -> Vec<T>
where
    F: FnMut(Duration) -> Result<T, RecvTimeoutError>,
{
    let mut events = vec![first];
    let started = Instant::now();
    loop {
        let remaining = max_wait.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        match receive(quiet_period.min(remaining)) {
            Ok(event) => events.push(event),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn initial_registration_preserves_warm_caches_and_is_not_repeated() {
        let mut state = RootWatchState::default();
        let mut actions = Vec::new();
        assert!(!state.sync(true, false, |action| {
            actions.push(action);
            true
        }));
        assert!(!state.sync(true, false, |_| panic!("root is already watched")));
        assert_eq!(actions, vec![RootWatchAction::Watch]);
    }

    #[test]
    fn late_root_requires_refresh_for_files_created_before_registration() {
        let mut state = RootWatchState::default();
        assert!(!state.sync(false, false, |_| panic!(
            "missing roots must not be watched"
        )));
        let mut actions = Vec::new();
        assert!(state.sync(true, false, |action| {
            actions.push(action);
            true
        }));
        assert_eq!(actions, vec![RootWatchAction::Watch]);
        assert!(!state.sync(true, false, |_| panic!("root is already watched")));
    }

    #[test]
    fn failed_registration_is_retried_and_refreshes_the_unwatched_gap() {
        let mut state = RootWatchState::default();
        assert!(!state.sync(true, false, |_| false));
        assert!(state.sync(true, false, |action| {
            assert_eq!(action, RootWatchAction::Watch);
            true
        }));
        assert!(!state.sync(true, false, |_| panic!("root is already watched")));
    }

    #[test]
    fn removed_root_is_forgotten_even_when_os_already_removed_the_watch() {
        let mut state = RootWatchState::default();
        state.sync(true, false, |_| true);
        assert!(state.sync(false, false, |action| {
            assert_eq!(action, RootWatchAction::Unwatch);
            false
        }));
        assert!(!state.sync(false, false, |_| panic!(
            "missing roots must not be watched"
        )));
        assert!(state.sync(true, false, |action| {
            assert_eq!(action, RootWatchAction::Watch);
            true
        }));
    }

    #[test]
    fn remove_and_recreate_before_poll_replaces_the_old_watch() {
        let mut state = RootWatchState::default();
        state.sync(true, false, |_| true);
        let mut actions = Vec::new();
        assert!(state.sync(true, true, |action| {
            actions.push(action);
            true
        }));
        assert_eq!(
            actions,
            vec![RootWatchAction::Unwatch, RootWatchAction::Watch]
        );
    }

    #[test]
    fn only_exact_configured_roots_are_registered_or_invalidated() {
        // No real watcher is created: an existing directory lets the callback
        // record the registration paths without touching the operating system.
        let root = std::env::temp_dir();
        let roots = [Some(root.clone()), None];
        let mut states = [RootWatchState::default(); 2];
        let mut actions = Vec::new();
        assert!(
            sync_root_watches(&roots, &mut states, &HashSet::new(), |path, action| {
                actions.push((path.to_path_buf(), action));
                true
            })
            .is_empty()
        );
        assert_eq!(actions, vec![(root.clone(), RootWatchAction::Watch)]);
        let unrelated = HashSet::from([root.join("removed-child.jsonl")]);
        assert!(
            sync_root_watches(&roots, &mut states, &unrelated, |_, _| panic!(
                "child deletion must not reset root"
            ))
            .is_empty()
        );
    }

    #[test]
    fn session_change_filter_skips_own_metadata() {
        assert!(is_session_file_change(Path::new("/p/a.jsonl")));
        assert!(is_session_file_change(Path::new("/p/summary.json")));
        assert!(!is_session_file_change(Path::new(
            "/p/.session-viewer-meta.json"
        )));
        assert!(!is_session_file_change(Path::new("/p/notes.txt")));
    }

    #[test]
    fn debounce_batch_keeps_every_queued_event() {
        let (sender, receiver) = mpsc::channel();
        sender.send("second").unwrap();
        sender.send("third").unwrap();
        drop(sender);

        let events = collect_until_quiet(
            "first",
            Duration::from_millis(1),
            Duration::from_millis(5),
            |timeout| receiver.recv_timeout(timeout),
        );

        assert_eq!(events, vec!["first", "second", "third"]);
    }
}
