//! 本机外壳能力（用本机程序打开 / 在资源管理器中显示）——GUI 侧能力，留在桌面。
//! 文件读写 / 列目录 / 搜索是 Host 能力，已迁入 aide-core（`crates/aide-core/src/commands/fs.rs`）。

use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[tauri::command]
pub fn file_open(window: tauri::Window, path: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("file_open");
    // Host 窗口里的路径是 Host 原生路径：跨界到本机前先翻译（SSH 如实拒绝）
    let path = crate::host_window::gui_path(&window, &path)?;
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
pub fn show_in_explorer(window: tauri::Window, path: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("show_in_explorer");
    let path = crate::host_window::gui_path(&window, &path)?;
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
