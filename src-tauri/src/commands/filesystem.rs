//! 本机外壳能力（用本机程序打开 / 在资源管理器中显示）与运行命令探测。
//! 文件读写 / 列目录 / 搜索是 Host 能力，已迁入 aide-core（`crates/aide-core/src/commands/fs.rs`）。

use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[tauri::command]
pub fn file_open(path: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("file_open");
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "start", "", &path]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.spawn().map_err(|e| format!("Failed to open: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_in_explorer(path: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("show_in_explorer");
    let p = PathBuf::from(&path);
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        if p.is_dir() {
            cmd.arg(&path);
        } else {
            cmd.arg(format!("/select,{}", path));
        };
        cmd.creation_flags(0x08000000);
        cmd.spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let target = if p.is_dir() {
            path.clone()
        } else {
            p.parent()
                .map(|pa| pa.to_string_lossy().into_owned())
                .unwrap_or(path)
        };
        Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open: {}", e))?;
    }
    Ok(())
}

// ── Project run-command detection ──────────────────────────────────────────

#[tauri::command]
pub async fn detect_run_command(cwd: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(super::detectors::detect_command_for_path(Path::new(&cwd)))
    })
    .await
    .map_err(|e| format!("detect_run_command task panicked: {}", e))?
}
