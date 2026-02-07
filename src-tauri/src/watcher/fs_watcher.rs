use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::mpsc;
use tauri::{AppHandle, Emitter};

use crate::parser::path_encoder::get_projects_dir;

/// Start watching the Claude projects directory for changes.
/// Emits "fs-change" events to the frontend when files are modified.
pub fn start_watcher(app_handle: AppHandle) -> Result<(), String> {
    let projects_dir = get_projects_dir().ok_or("Could not find Claude projects directory")?;

    if !projects_dir.exists() {
        return Err("Projects directory does not exist".to_string());
    }

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("Failed to create watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&projects_dir, RecursiveMode::Recursive) {
            eprintln!("Failed to watch directory: {}", e);
            return;
        }

        for event in rx {
            match event {
                Ok(event) => {
                    // Only emit for relevant file changes
                    let dominated_by_jsonl = event.paths.iter().any(|p| {
                        p.extension()
                            .map(|e| e == "jsonl" || e == "json")
                            .unwrap_or(false)
                    });

                    if dominated_by_jsonl {
                        let paths: Vec<String> = event
                            .paths
                            .iter()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect();

                        let _ = app_handle.emit("fs-change", paths);
                    }
                }
                Err(e) => {
                    eprintln!("Watch error: {}", e);
                }
            }
        }
    });

    Ok(())
}
