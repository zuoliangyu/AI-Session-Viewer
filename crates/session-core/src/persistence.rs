//! Serialize viewer-owned JSON mutations across desktop and web processes.
//! SQLite is already a dependency and provides crash-released file locks on
//! every supported platform without raising the documented Rust requirement.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use serde::{de::DeserializeOwned, Serialize};

pub(crate) struct StateLock {
    connection: Connection,
}

impl StateLock {
    /// Keep this guard for the entire read/modify/write operation, including
    /// associated file moves. Helpers must reuse it, never acquire recursively.
    pub(crate) fn acquire() -> Result<Self, String> {
        let root =
            crate::app_dir::get_app_dir().ok_or("Cannot determine viewer state directory")?;
        Self::acquire_at(
            &root.join("state-write-lock.sqlite"),
            Duration::from_secs(5),
        )
    }

    fn acquire_at(path: &Path, timeout: Duration) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(timeout)
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| format!("等待本地数据写入锁失败，请稍后重试：{error}"))?;
        Ok(Self { connection })
    }

    pub(crate) fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        let parent = path.parent().ok_or("Missing JSON parent directory")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = parent.join(format!(".asv-write-{}.tmp", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("创建临时文件失败：{error}"))?;
        let result = (|| {
            // Keep private-file permissions when replacing existing state.
            match fs::metadata(path) {
                Ok(metadata) => file.set_permissions(metadata.permissions())?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            file.write_all(&bytes)?;
            file.sync_all()
        })();
        drop(file);
        if let Err(error) = result.and_then(|_| fs::rename(&temporary, path)) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("保存 {} 失败：{error}", path.display()));
        }
        Ok(())
    }
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = self.connection.execute_batch("ROLLBACK");
        // Never unlink the lock database: another process may be waiting on it.
    }
}

/// Only absence is an empty store. Invalid/unreadable data must never be
/// mistaken for empty state by a writer and overwritten on its next update.
pub(crate) fn read_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("读取 {} 失败：{error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("asv-persistence-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn independent_connections_serialize_updates() {
        let dir = TestDir::new();
        let mut workers = Vec::new();
        for _ in 0..8 {
            let root = dir.0.clone();
            workers.push(std::thread::spawn(move || {
                for _ in 0..10 {
                    let guard =
                        StateLock::acquire_at(&root.join("lock.sqlite"), Duration::from_secs(5))
                            .unwrap();
                    let path = root.join("counter.json");
                    let current: u64 = read_json(&path).unwrap();
                    std::thread::yield_now();
                    guard.write_json(&path, &(current + 1)).unwrap();
                }
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(read_json::<u64>(&dir.0.join("counter.json")).unwrap(), 80);
    }

    #[test]
    fn separate_processes_serialize_updates() {
        let dir = TestDir::new();
        let executable = std::env::current_exe().unwrap();
        let mut children = Vec::new();
        for _ in 0..4 {
            children.push(
                std::process::Command::new(&executable)
                    .args([
                        "--exact",
                        "persistence::tests::process_writer",
                        "--nocapture",
                    ])
                    .env("ASV_PERSISTENCE_TEST_ROOT", &dir.0)
                    .spawn()
                    .unwrap(),
            );
        }
        for mut child in children {
            assert!(child.wait().unwrap().success());
        }
        assert_eq!(read_json::<u64>(&dir.0.join("counter.json")).unwrap(), 40);
    }

    #[test]
    fn process_writer() {
        let Some(root) = std::env::var_os("ASV_PERSISTENCE_TEST_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        for _ in 0..10 {
            let guard =
                StateLock::acquire_at(&root.join("lock.sqlite"), Duration::from_secs(5)).unwrap();
            let path = root.join("counter.json");
            let current: u64 = read_json(&path).unwrap();
            std::thread::yield_now();
            guard.write_json(&path, &(current + 1)).unwrap();
        }
    }

    #[test]
    fn lock_timeout_and_unwind_release_do_not_delete_lock_file() {
        let dir = TestDir::new();
        let path = dir.0.join("lock.sqlite");
        let _ = std::panic::catch_unwind(|| {
            let _guard = StateLock::acquire_at(&path, Duration::from_millis(100)).unwrap();
            assert!(StateLock::acquire_at(&path, Duration::from_millis(20)).is_err());
            panic!("simulated failed operation");
        });
        assert!(path.exists());
        assert!(StateLock::acquire_at(&path, Duration::from_millis(100)).is_ok());
    }

    #[test]
    fn corrupted_json_is_not_treated_as_an_empty_store() {
        let dir = TestDir::new();
        let path = dir.0.join("state.json");
        fs::write(&path, b"{broken").unwrap();
        let guard =
            StateLock::acquire_at(&dir.0.join("lock.sqlite"), Duration::from_secs(1)).unwrap();
        let result = read_json::<Vec<String>>(&path).and_then(|mut items| {
            items.push("new".to_string());
            guard.write_json(&path, &items)
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
    }

    #[test]
    fn failed_replace_preserves_destination_and_removes_temporary_file() {
        let dir = TestDir::new();
        let path = dir.0.join("state.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), b"original").unwrap();
        let guard =
            StateLock::acquire_at(&dir.0.join("lock.sqlite"), Duration::from_secs(1)).unwrap();

        assert!(guard.write_json(&path, &vec!["new"]).is_err());
        assert_eq!(fs::read(path.join("keep")).unwrap(), b"original");
        assert!(!fs::read_dir(&dir.0).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".asv-write-")));
    }
}
