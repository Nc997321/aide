//! 打开随包分发的 LSP 安装向导——GUI 能力（系统浏览器），留在桌面。

/// 打开随包分发的 LSP 安装向导 HTML（resource_dir/lsp-install-guide.html），系统默认浏览器。
/// 同步命令（spawn start/xdg-open/open 是轻子进程），照 show_in_explorer 模式埋 trace_command。
#[tauri::command]
pub fn open_lsp_install_guide(app: tauri::AppHandle) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("open_lsp_install_guide");
    use tauri::Manager;
    let res_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let html = res_dir.join("lsp-install-guide.html");
    let html = if html.exists() {
        html
    } else {
        // dev：bundle resources 不拷进 resource_dir（打包才生效），回落源码目录
        let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/lsp-install-guide.html");
        if dev.exists() {
            dev
        } else {
            return Err(format!(
                "lsp-install-guide.html not found (release: {:?}, dev: {:?})",
                html, dev
            ));
        }
    };
    // Windows 上 resource_dir 是 \\?\ verbatim 路径，传给外部进程前必须 dunce 剥前缀（CLAUDE.md 红线）
    let html = dunce::simplified(&html);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        // start 的第一个引号参数是窗口标题（空串），路径带空格也没问题
        cmd.arg("/C").arg("start").arg("").arg(&html);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW：不弹控制台
        cmd.spawn()
            .map_err(|e| format!("Failed to open guide: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&html)
            .spawn()
            .map_err(|e| format!("Failed to open guide: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&html)
            .spawn()
            .map_err(|e| format!("Failed to open guide: {e}"))?;
    }
    Ok(())
}
