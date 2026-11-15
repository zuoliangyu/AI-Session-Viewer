//! Per-rollout usage cache, shared by every Codex statistics entry point.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use parking_lot::Mutex;

use super::{parse_usage_file, UsageFile};

#[derive(Clone, Copy, PartialEq, Eq)]
struct Signature {
    modified: SystemTime,
    length: u64,
}

fn signature(path: &Path) -> Result<Signature, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(Signature {
        modified: metadata.modified().map_err(|error| error.to_string())?,
        length: metadata.len(),
    })
}

struct CachedUsage {
    signature: Signature,
    usage: Arc<UsageFile>,
}

type Slot = Arc<Mutex<Option<CachedUsage>>>;

#[derive(Default)]
struct UsageCache {
    files: Mutex<HashMap<PathBuf, Slot>>,
}

impl UsageCache {
    fn get_with(
        &self,
        path: &Path,
        mut parse: impl FnMut(&Path) -> Result<UsageFile, String>,
    ) -> Result<Arc<UsageFile>, String> {
        // IPC paths are canonical, while directory scans can return ordinary
        // Windows paths. Normalize both so they reuse the very same entry.
        let path = path.canonicalize().map_err(|error| error.to_string())?;
        let slot = self.files.lock().entry(path.clone()).or_default().clone();
        let mut cached = slot.lock();
        for _ in 0..2 {
            let before = signature(&path)?;
            if let Some(entry) = cached.as_ref() {
                if entry.signature == before {
                    return Ok(entry.usage.clone());
                }
            }
            let usage = parse(&path)?;
            // A writer may append while scanning. Never label an incomplete
            // snapshot with the newer signature and keep it indefinitely.
            if signature(&path)? != before {
                continue;
            }
            let usage = Arc::new(usage);
            *cached = Some(CachedUsage {
                signature: before,
                usage: usage.clone(),
            });
            return Ok(usage);
        }
        Err("Codex 会话正在变化，请稍后重试统计请求".to_string())
    }

    fn invalidate(&self, path: &Path) {
        if let Ok(path) = path.canonicalize() {
            self.files.lock().remove(&path);
        } else {
            // Deleted paths cannot be canonicalized (notably Windows verbatim
            // paths), so remove missing entries by their saved canonical key.
            self.prune_missing();
        }
    }

    fn prune_missing(&self) {
        let snapshot: Vec<_> = self
            .files
            .lock()
            .iter()
            .map(|(path, slot)| (path.clone(), slot.clone()))
            .collect();
        // Do filesystem IO outside the map lock so a large census cannot
        // prevent another session from accessing its already-warm slot.
        let missing: Vec<_> = snapshot
            .into_iter()
            .filter(|(path, _)| matches!(path.try_exists(), Ok(false)))
            .collect();
        let mut files = self.files.lock();
        for (path, previous_slot) in missing {
            if files
                .get(&path)
                .is_some_and(|slot| Arc::ptr_eq(slot, &previous_slot))
            {
                files.remove(&path);
            }
        }
    }
}

fn cache() -> &'static UsageCache {
    static CACHE: OnceLock<UsageCache> = OnceLock::new();
    CACHE.get_or_init(UsageCache::default)
}

pub(super) fn get(path: &Path) -> Result<Arc<UsageFile>, String> {
    cache().get_with(path, parse_usage_file)
}

pub(super) fn invalidate(path: &Path) {
    cache().invalidate(path);
}

pub(super) fn prune_missing() {
    cache().prune_missing();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("asv-codex-usage-{}.jsonl", uuid::Uuid::new_v4()));
            std::fs::write(&path, "initial\n").unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn empty_usage() -> UsageFile {
        UsageFile {
            session_id: String::new(),
            project_id: String::new(),
            events: Vec::new(),
        }
    }

    #[test]
    fn concurrent_readers_share_one_build_and_canonical_paths() {
        let fixture = Fixture::new();
        let cache = UsageCache::default();
        let builds = AtomicUsize::new(0);
        let start = Barrier::new(4);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        start.wait();
                        cache
                            .get_with(&fixture.0, |_| {
                                builds.fetch_add(1, Ordering::SeqCst);
                                Ok(empty_usage())
                            })
                            .unwrap()
                    })
                })
                .collect();
            let entries: Vec<_> = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect();
            assert!(entries.iter().all(|entry| Arc::ptr_eq(entry, &entries[0])));
        });
        cache
            .get_with(&fixture.0.canonicalize().unwrap(), |_| {
                panic!("unchanged file was reparsed")
            })
            .unwrap();
        assert_eq!(builds.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn changed_file_rebuilds_without_reparsing_its_neighbor_and_deletion_is_pruned() {
        let first = Fixture::new();
        let second = Fixture::new();
        let cache = UsageCache::default();
        let before = cache.get_with(&first.0, |_| Ok(empty_usage())).unwrap();
        let neighbor = cache.get_with(&second.0, |_| Ok(empty_usage())).unwrap();
        std::fs::write(&first.0, "appended content\n").unwrap();
        let after = cache.get_with(&first.0, |_| Ok(empty_usage())).unwrap();
        assert!(!Arc::ptr_eq(&before, &after));
        assert!(Arc::ptr_eq(
            &neighbor,
            &cache
                .get_with(&second.0, |_| panic!("neighbor reparsed"))
                .unwrap()
        ));
        std::fs::remove_file(&first.0).unwrap();
        cache.invalidate(&first.0);
        assert_eq!(cache.files.lock().len(), 1);
        assert!(cache
            .get_with(&first.0, |_| panic!("deleted file parsed"))
            .is_err());
    }

    #[test]
    fn changed_during_scan_is_retried_and_failed_reads_are_not_cached() {
        let fixture = Fixture::new();
        let cache = UsageCache::default();
        assert!(cache
            .get_with(&fixture.0, |_| Err("read failed".to_string()))
            .is_err());
        let mut attempts = 0;
        cache
            .get_with(&fixture.0, |path| {
                attempts += 1;
                if attempts == 1 {
                    std::fs::write(path, "changed while reading\n").unwrap();
                }
                Ok(empty_usage())
            })
            .unwrap();
        assert_eq!(attempts, 2);
        cache
            .get_with(&fixture.0, |_| panic!("stable snapshot not reused"))
            .unwrap();
    }
}
