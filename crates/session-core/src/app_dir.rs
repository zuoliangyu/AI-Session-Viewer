use std::path::PathBuf;

pub fn get_app_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude-code-viewer"))
}

pub fn get_recyclebin_dir() -> Option<PathBuf> {
    get_app_dir().map(|d| d.join("recyclebin"))
}

pub fn get_recyclebin_items_dir() -> Option<PathBuf> {
    get_recyclebin_dir().map(|d| d.join("items"))
}

pub fn get_recyclebin_manifest_path() -> Option<PathBuf> {
    get_recyclebin_dir().map(|d| d.join("manifest.json"))
}
