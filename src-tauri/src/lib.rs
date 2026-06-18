mod commands;
mod pty;

use commands::WorkspaceState;
use pty::PtyManager;

fn init_logging() {
    let log_dir = commands::our_config_dir().join("log");
    let _ = std::fs::create_dir_all(&log_dir);
    let file_appender = tracing_appender::rolling::daily(&log_dir, "aide");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    // Leak the guard so the writer lives for the lifetime of the app
    std::mem::forget(_guard);
    tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

    // Log panics before the crash dialog appears
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("PANIC: {}", info);
        if let Some(loc) = info.location() {
            tracing::error!("  at {}:{}", loc.file(), loc.line());
        }
        default_hook(info);
    }));

    let manager = PtyManager::new();
    let saved_key = commands::load_workspace_config();
    let workspace_state = WorkspaceState::new();
    if let Some(key) = saved_key {
        // Resolve the encoded key back to a filesystem path
        if let Some(path) = commands::resolve_path_from_key(&key) {
            *workspace_state.path.lock().unwrap() = Some(std::path::PathBuf::from(&path));
        }
        *workspace_state.key.lock().unwrap() = Some(key);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(manager)
        .manage(workspace_state)
        .setup(|app| {
            #[cfg(target_os = "windows")]
            apply_window_theme(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_spawn_claude,
            commands::pty::pty_kill,
            commands::pty::pty_has_session,
            commands::pty::pty_rename_session,
            commands::pty::poll_pty_output,
            commands::pty::pty_spawn_shell,
            commands::filesystem::get_project_info,
            commands::filesystem::list_directory,
            commands::filesystem::file_open,
            commands::filesystem::read_file_content,
            commands::filesystem::write_file_content,
            commands::filesystem::delete_file,
            commands::filesystem::create_file,
            commands::filesystem::create_dir,
            commands::session::list_sessions,
            commands::session::list_sessions_for_workspace,
            commands::session::create_session,
            commands::session::delete_session,
            commands::session::rename_session,
            commands::session::load_messages,
            commands::session::session_last_event,
            commands::session::load_session_changes,
            commands::session::save_session_changes,
            commands::workspace::list_workspaces,
            commands::workspace::set_workspace,
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::settings::notify_send,
            commands::settings::get_pending_notification,
            commands::git::git_diff_files,
            commands::git::git_stage_all,
            commands::git::git_stage_file,
            commands::git::git_unstage_file,
            commands::git::git_has_file,
            commands::git::git_revert_file,
            commands::git::log_frontend_error,
            commands::git::git_remote_url,
            commands::git::git_log,
            commands::git::git_show,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_diff_content,
            commands::git::git_status,
            commands::git::git_commit,
            // Customization commands
            commands::customizations::list_agents,
            commands::customizations::get_agent,
            commands::customizations::create_agent,
            commands::customizations::update_agent,
            commands::customizations::delete_agent,
            commands::customizations::toggle_agent,
            commands::customizations::list_skills,
            commands::customizations::get_skill,
            commands::customizations::create_skill,
            commands::customizations::update_skill,
            commands::customizations::delete_skill,
            commands::customizations::toggle_skill,
            commands::customizations::get_global_instructions,
            commands::customizations::save_global_instructions,
            commands::customizations::get_project_instructions,
            commands::customizations::save_project_instructions,
            commands::customizations::list_hooks,
            commands::customizations::create_hook,
            commands::customizations::update_hook,
            commands::customizations::delete_hook,
            commands::customizations::toggle_hook,
            commands::customizations::list_mcp_servers,
            commands::customizations::create_mcp_server,
            commands::customizations::update_mcp_server,
            commands::customizations::delete_mcp_server,
            commands::customizations::toggle_mcp_server,
            // Marketplace commands
            commands::marketplace::fetch_marketplace,
            commands::marketplace::install_plugin,
            commands::marketplace::uninstall_plugin,
            commands::marketplace::list_installed_plugins,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Apply Catppuccin Mocha dark theme to the Windows title bar via DWM.
///
/// 1. Sets the window theme to Dark (→ `DWMWA_USE_IMMERSIVE_DARK_MODE` on Windows).
/// 2. Sets `DWMWA_CAPTION_COLOR` (Win 11) so the title bar matches the app's
///    background (#1e1e2e) instead of generic dark gray.
#[cfg(target_os = "windows")]
fn apply_window_theme(app: &mut tauri::App) {
    use tauri::Manager;

    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    // Enable dark title bar (DWMWA_USE_IMMERSIVE_DARK_MODE under the hood)
    let _ = window.set_theme(Some(tauri::Theme::Dark));

    // HWND is a newtype struct from the `windows` crate; extract the raw handle
    let hwnd_raw: *mut std::ffi::c_void = match window.hwnd() {
        Ok(h) => h.0,
        Err(_) => return,
    };

    // DWMWA_CAPTION_COLOR = 35 — available since Windows 11 22H2.
    // On older Windows, the call fails silently and we keep the default dark title bar.
    // COLORREF: 0x00BBGGRR → Catppuccin Mocha base #1e1e2e = 0x002e1e1e
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const CATPPUCCIN_BASE: u32 = 0x002e1e1e;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut std::ffi::c_void,
            dw_attribute: u32,
            pv_attribute: *const std::ffi::c_void,
            cb_attribute: u32,
        ) -> i32;
    }

    unsafe {
        let _hr = DwmSetWindowAttribute(
            hwnd_raw,
            DWMWA_CAPTION_COLOR,
            &CATPPUCCIN_BASE as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}
