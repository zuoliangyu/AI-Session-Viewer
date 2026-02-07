mod commands;
mod models;
mod parser;
mod state;
mod watcher;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::projects::get_projects,
            commands::sessions::get_sessions,
            commands::messages::get_messages,
            commands::search::global_search,
            commands::stats::get_global_stats,
            commands::stats::get_token_summary,
            commands::terminal::resume_session,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Start file system watcher in background
            if let Err(e) = watcher::fs_watcher::start_watcher(handle) {
                eprintln!("Warning: Failed to start file watcher: {}", e);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
