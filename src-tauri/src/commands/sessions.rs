use std::fs;
use std::path::PathBuf;

use crate::models::session::{SessionIndexEntry, SessionsIndex};
use crate::parser::jsonl::{extract_first_prompt, extract_session_metadata};
use crate::parser::path_encoder::get_projects_dir;

#[tauri::command]
pub fn get_sessions(encoded_name: String) -> Result<Vec<SessionIndexEntry>, String> {
    let projects_dir = get_projects_dir().ok_or("Could not find Claude projects directory")?;
    let project_dir = projects_dir.join(&encoded_name);

    if !project_dir.exists() {
        return Err(format!("Project directory not found: {}", encoded_name));
    }

    // Try reading sessions-index.json first
    let index_path = project_dir.join("sessions-index.json");
    if index_path.exists() {
        let content = fs::read_to_string(&index_path)
            .map_err(|e| format!("Failed to read sessions index: {}", e))?;
        let index: SessionsIndex = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse sessions index: {}", e))?;

        if !index.entries.is_empty() {
            let mut entries = index.entries;
            // Sort by modified time, most recent first
            entries.sort_by(|a, b| b.modified.cmp(&a.modified));
            return Ok(entries);
        }
    }

    // Fallback: scan JSONL files directly
    let mut entries: Vec<SessionIndexEntry> = Vec::new();

    let dir_entries =
        fs::read_dir(&project_dir).map_err(|e| format!("Failed to read project dir: {}", e))?;

    for entry in dir_entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            let session_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            if session_id.is_empty() {
                continue;
            }

            let first_prompt = extract_first_prompt(&path);
            let metadata = extract_session_metadata(&path);
            let (_, git_branch, project_path) = metadata.unwrap_or((String::new(), None, None));

            // Count lines as approximate message count
            let message_count = count_messages(&path);

            let file_meta = fs::metadata(&path).ok();
            let modified = file_meta.as_ref().and_then(|m| {
                m.modified().ok().map(|t| {
                    let d = t
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default();
                    chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
            });

            let created = file_meta.as_ref().and_then(|m| {
                m.created().ok().map(|t| {
                    let d = t
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default();
                    chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
            });

            entries.push(SessionIndexEntry {
                session_id,
                full_path: Some(path.to_string_lossy().to_string()),
                file_mtime: file_meta.and_then(|m| {
                    m.modified().ok().map(|t| {
                        t.duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64
                    })
                }),
                first_prompt,
                message_count: Some(message_count),
                created,
                modified,
                git_branch,
                project_path,
                is_sidechain: Some(false),
            });
        }
    }

    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(entries)
}

fn count_messages(path: &PathBuf) -> u32 {
    use std::io::{BufRead, BufReader};
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return 0,
    };
    let reader = BufReader::new(file);
    let mut count: u32 = 0;
    for line in reader.lines().flatten() {
        let trimmed = line.trim();
        if trimmed.contains("\"type\":\"user\"") || trimmed.contains("\"type\":\"assistant\"") {
            count += 1;
        }
    }
    count
}
