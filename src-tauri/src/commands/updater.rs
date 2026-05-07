use tauri::command;

/// Detect whether the app is running as an installed version or portable
/// version. The choice routes the in-app updater (installed → MSI/NSIS
/// auto-update; portable → just open the GitHub release page), so being
/// wrong here breaks updates.
///
/// - Windows: check if an NSIS uninstaller exists next to the exe →
///   "installed", otherwise "portable".
/// - macOS / Linux: always "installed" (no portable distribution shipped).
///
/// History: v2.12.0 tried to additionally cross-check a registry uninstall
/// key under the bundle identifier. That broke real NSIS-installed users
/// because Tauri's NSIS template doesn't write the key under exactly that
/// name across all Tauri versions, so the check returned `false` for
/// genuine installs and silently downgraded everyone to the
/// "open GitHub Release page" path. Reverted in v2.12.2 — the
/// hypothetical "drop a fake uninstall.exe to fool the updater" attack
/// is not worth breaking the working majority.
#[command]
pub fn get_install_type() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(dir) = exe_path.parent() {
                let uninstaller = dir.join("uninstall.exe");
                if uninstaller.exists() {
                    return "installed".to_string();
                }
            }
        }
        "portable".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "installed".to_string()
    }
}
