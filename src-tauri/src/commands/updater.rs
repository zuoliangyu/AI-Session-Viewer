use tauri::command;

/// Detect whether the app is running as an installed version or portable
/// version. The choice routes the in-app updater (installed → MSI/NSIS
/// auto-update; portable → just open the GitHub release page), so being
/// wrong here breaks updates.
///
/// - Windows: confirm via **both** signals before claiming "installed":
///   1. the NSIS-managed registry uninstall key exists for our identifier,
///   2. there's an `uninstall.exe` next to the running exe.
///   Either signal alone is too easy to forge by dropping a stub file.
/// - macOS / Linux: always "installed" (no portable distribution shipped).
#[command]
pub fn get_install_type() -> String {
    #[cfg(target_os = "windows")]
    {
        if windows_is_installed() {
            "installed".to_string()
        } else {
            "portable".to_string()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        "installed".to_string()
    }
}

#[cfg(target_os = "windows")]
fn windows_is_installed() -> bool {
    // Signal 1: uninstall.exe sibling. Necessary but easy to forge.
    let exe_dir = match std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
        Some(dir) => dir,
        None => return false,
    };
    if !exe_dir.join("uninstall.exe").is_file() {
        return false;
    }

    // Signal 2: NSIS writes an uninstall key under
    //   HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<identifier>
    // (and HKLM for per-machine installs). Drop a portable build into
    // a directory with a fake uninstall.exe and this lookup still returns
    // false, so we don't misroute the in-app updater.
    const IDENTIFIER: &str = "com.zuolan.ai-session-viewer";
    let subkey = format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
        IDENTIFIER
    );
    registry_key_exists(winreg::enums::HKEY_CURRENT_USER, &subkey)
        || registry_key_exists(winreg::enums::HKEY_LOCAL_MACHINE, &subkey)
}

#[cfg(target_os = "windows")]
fn registry_key_exists(hive: winreg::HKEY, subkey: &str) -> bool {
    use winreg::RegKey;
    RegKey::predef(hive).open_subkey(subkey).is_ok()
}
