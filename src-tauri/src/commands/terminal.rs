use std::process::Command;

#[tauri::command]
pub fn resume_session(source: String, session_id: String, project_path: String) -> Result<(), String> {
    let project_path = normalize_path(&project_path);

    if !std::path::Path::new(&project_path).exists() {
        return Err(format!("项目路径不存在: {}", project_path));
    }

    let cli_cmd = match source.as_str() {
        "claude" => format!("claude --resume {}", session_id),
        "codex" => format!("codex resume {}", session_id),
        _ => return Err(format!("Unknown source: {}", source)),
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        Command::new("cmd")
            .args(["/c", "start", "", "/d", &project_path, "cmd", "/k", &cli_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\" to do script \"cd '{}' && {}\"",
            project_path, cli_cmd
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;

        let cmd_str = format!("cd '{}' && {}", project_path, cli_cmd);

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

fn normalize_path(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.replace('\\', "/")
    }
}
