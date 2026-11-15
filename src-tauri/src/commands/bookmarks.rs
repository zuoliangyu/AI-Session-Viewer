use session_core::bookmarks::{self, Bookmark};

#[tauri::command]
pub fn list_bookmarks(source: Option<String>) -> Result<Vec<Bookmark>, String> {
    bookmarks::list_bookmarks(source.as_deref())
}

#[tauri::command]
pub fn add_bookmark(bookmark: Bookmark) -> Result<Bookmark, String> {
    bookmarks::add_bookmark(bookmark)
}

#[tauri::command]
pub fn remove_bookmark(id: String) -> Result<(), String> {
    bookmarks::remove_bookmark(&id)
}
