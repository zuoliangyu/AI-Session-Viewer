use std::process::Command;

#[tauri::command]
pub fn resume_session(session_id: String, project_path: String) -> Result<(), String> {
    // Normalize path: replace forward slashes with backslashes on Windows
    let project_path = normalize_path(&project_path);

    // Validate path exists
    if !std::path::Path::new(&project_path).exists() {
        return Err(format!("项目路径不存在: {}", project_path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // "cmd /c start /d <dir> cmd /k <command>" launches a fully independent terminal.
        // - "cmd /c" exits immediately after running "start", breaking the parent-child link
        // - "start /d" sets the working directory without needing cd && chaining
        // - CREATE_NO_WINDOW hides the brief intermediate cmd flash
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let resume_arg = format!("claude --resume {}", session_id);
        Command::new("cmd")
            .args(["/c", "start", "", "/d", &project_path, "cmd", "/k", &resume_arg])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        // osascript tells Terminal.app to run the script — the process is owned by
        // Terminal.app, not by our app, so it already survives app exit.
        let script = format!(
            "tell application \"Terminal\" to do script \"cd '{}' && claude --resume {}\"",
            project_path, session_id
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;

        let cmd_str = format!(
            "cd '{}' && claude --resume {}",
            project_path, session_id
        );

        // Try various terminal emulators
        let bash_cmd = format!("bash -c '{}'", cmd_str);
        let xfce_arg = format!("bash -c '{}'", cmd_str);
        let xterm_arg = format!("bash -c '{}'", cmd_str);
        let terminals: [(&str, &[&str]); 4] = [
            ("gnome-terminal", &["--", "bash", "-c", &cmd_str]),
            ("konsole", &["-e", "bash", "-c", &cmd_str]),
            ("xfce4-terminal", &["-e", &xfce_arg]),
            ("xterm", &["-e", &xterm_arg]),
        ];

        let mut launched = false;
        for (terminal, args) in &terminals {
            // process_group(0) puts the child in its own process group (calls setsid),
            // so it won't be killed when our app exits.
            if Command::new(terminal)
                .args(*args)
                .process_group(0)
                .spawn()
                .is_ok()
            {
                launched = true;
                break;
            }
        }

        if !launched {
            return Err("No supported terminal emulator found".to_string());
        }
    }

    Ok(())
}

/// Normalize path for the current OS
fn normalize_path(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.replace('\\', "/")
    }
}
