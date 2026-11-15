use crate::persistence::{self, StateLock};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarksFile {
    pub version: u32,
    pub bookmarks: Vec<Bookmark>,
}

impl Default for BookmarksFile {
    fn default() -> Self {
        Self {
            version: 1,
            bookmarks: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub source: String,
    pub project_id: String,
    pub session_id: String,
    pub file_path: String,
    pub message_id: Option<String>,
    pub preview: String,
    pub session_title: String,
    pub project_name: String,
    pub created_at: String,
}

fn bookmarks_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    Ok(home.join(".session-viewer-bookmarks.json"))
}

pub fn load_bookmarks() -> Result<BookmarksFile, String> {
    persistence::read_json(&bookmarks_path()?)
}

fn save_bookmarks(lock: &StateLock, file: &BookmarksFile) -> Result<(), String> {
    lock.write_json(&bookmarks_path()?, file)
}

fn generate_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", ts)
}

pub fn add_bookmark(bookmark: Bookmark) -> Result<Bookmark, String> {
    let lock = StateLock::acquire()?;
    let mut file = load_bookmarks()?;

    // Deduplicate: same session + message_id
    let exists = file.bookmarks.iter().any(|b| {
        b.source == bookmark.source
            && b.session_id == bookmark.session_id
            && b.message_id == bookmark.message_id
    });
    if exists {
        return Err("Bookmark already exists".to_string());
    }

    let mut bm = bookmark;
    if bm.id.is_empty() {
        bm.id = generate_id();
    }
    if bm.created_at.is_empty() {
        bm.created_at = chrono::Utc::now().to_rfc3339();
    }

    file.bookmarks.push(bm.clone());
    save_bookmarks(&lock, &file)?;
    Ok(bm)
}

/// Append bookmarks carried over from another machine, skipping ones that
/// already exist (same id, or same session + message). Returns how many were added.
pub fn import_bookmarks(bookmarks: Vec<Bookmark>) -> Result<usize, String> {
    if bookmarks.is_empty() {
        return Ok(0);
    }
    let lock = StateLock::acquire()?;
    let mut file = load_bookmarks()?;
    let mut added = 0;
    for bookmark in bookmarks {
        let exists = file.bookmarks.iter().any(|b| {
            b.id == bookmark.id
                || (b.source == bookmark.source
                    && b.session_id == bookmark.session_id
                    && b.message_id == bookmark.message_id)
        });
        if !exists {
            file.bookmarks.push(bookmark);
            added += 1;
        }
    }
    if added > 0 {
        save_bookmarks(&lock, &file)?;
    }
    Ok(added)
}

/// Edit bookmarks in place (e.g. after their sessions moved); `edit` returns
/// whether it changed the bookmark. Returns how many changed.
pub fn update_bookmarks(mut edit: impl FnMut(&mut Bookmark) -> bool) -> Result<usize, String> {
    let lock = StateLock::acquire()?;
    let mut file = load_bookmarks()?;
    let mut changed = 0;
    for bookmark in &mut file.bookmarks {
        if edit(bookmark) {
            changed += 1;
        }
    }
    if changed > 0 {
        save_bookmarks(&lock, &file)?;
    }
    Ok(changed)
}

pub fn remove_bookmark(id: &str) -> Result<(), String> {
    let lock = StateLock::acquire()?;
    let mut file = load_bookmarks()?;
    let len_before = file.bookmarks.len();
    file.bookmarks.retain(|b| b.id != id);
    if file.bookmarks.len() == len_before {
        return Err("Bookmark not found".to_string());
    }
    save_bookmarks(&lock, &file)?;
    Ok(())
}

pub fn remove_project_bookmarks(source: &str, project_id: &str) -> Result<usize, String> {
    let lock = StateLock::acquire()?;
    let mut file = load_bookmarks()?;
    let before = file.bookmarks.len();
    file.bookmarks
        .retain(|bookmark| bookmark.source != source || bookmark.project_id != project_id);
    let removed = before - file.bookmarks.len();
    if removed > 0 {
        save_bookmarks(&lock, &file)?;
    }
    Ok(removed)
}

pub fn list_bookmarks(source: Option<&str>) -> Result<Vec<Bookmark>, String> {
    let file = load_bookmarks()?;
    Ok(match source {
        Some(s) => file
            .bookmarks
            .into_iter()
            .filter(|b| b.source == s)
            .collect(),
        None => file.bookmarks,
    })
}
