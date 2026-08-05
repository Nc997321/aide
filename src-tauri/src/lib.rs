mod codegraph;
mod commands;
mod diagnostics;
mod ignore_dirs;
mod lsp;
mod shell;
mod runtime;
mod conversation;
mod skills;
mod policy;
mod settings;

use std::path::PathBuf;

use commands::file_assoc::PendingOpenFile;
use commands::WorkspaceState;
use tauri::{Emitter, Manager};

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
    // 数据目录改名（~/.claude-code-desktop/ → ~/.aide/，原子 rename）必须在
    // init_logging / load_workspace_state 之前——它们都会触碰 ~/.aide/（建 log/、读
    // state.json），先 rename 才不会把 ~/.aide/ 提前建出来导致老数据卡住迁不过来。
    // 失败（杀软锁等）用 eprintln（此时 tracing 还没 init），下次启动重试。
    if let Err(e) = crate::commands::migration::ensure_aide_data_dir_migrated() {
        eprintln!("[aide] aide data dir migration failed: {e}");
    }

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

    let shell_manager = shell::ShellManager::new();
    // state.json 播种（legacy config.json → state.json 一次性 key 搬迁）必须在
    // load_workspace_state 之前——它读的就是 state.json。幂等；失败保留 legacy
    // 文件，设置迁移清理时会重试。
    if let Err(e) = commands::settings::seed_state_from_legacy(
        &commands::config_path(),
        &commands::state_path(),
    ) {
        eprintln!("[aide] state.json seeding failed: {e}");
    }
    let saved_key = commands::load_workspace_state();
    let workspace_state = WorkspaceState::new();
    if let Some(key) = saved_key {
        // Resolve the encoded key back to a filesystem path
        if let Some(path) = commands::resolve_path_from_key(&key) {
            *workspace_state.path.lock().unwrap() = Some(std::path::PathBuf::from(&path));
        }
        *workspace_state.key.lock().unwrap() = Some(key);
    }

    let builder = tauri::Builder::default();
    // 聚合二次启动：资源管理器「打开方式 → Aide」以 `aide.exe <path>` 唤起，
    // 由首个实例接收 argv 并 emit 事件给前端预览。
    //
    // 仅 release 启用：dev/debug 构建与已安装的 release 共用同一 identifier
    // （com.aide.app），若 debug 也注册单实例，`pnpm tauri dev` 的新实例会被
    // 转发给正在运行的安装版并立即退出，开发期无法与安装版并存。
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        if let Some(p) = argv.get(1) {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            let _ = app.emit("open-file-preview", p.clone());
        }
    }));

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                    // Exclude DECORATIONS — let tauri.conf.json be authoritative
                )
                .build(),
        )
        .manage(shell_manager)
        .manage(diagnostics::DiagnosticsState::new())
        .manage(std::sync::Arc::new(settings::SettingsService::new(
            settings::SettingsPaths::new().expect("settings paths"),
            std::sync::Arc::new(settings::KeyringSecretStore::new()),
        )))
        .manage(runtime::AgentRuntimeManager::new())
        .manage(std::sync::Arc::new(skills::SkillRegistry::new()))
        .manage(workspace_state)
        .manage(PendingOpenFile(std::sync::Mutex::new(None)))
        .manage(std::sync::Arc::new(codegraph::CodeGraphState::new()))
        .manage(std::sync::Arc::new(lsp::LspState::new()))
        .setup(|app| {
            app.state::<std::sync::Arc<settings::SettingsService>>()
                .initialize_blocking()
                .map_err(|error| std::io::Error::other(error.to_string()))?;

            // Create the main window programmatically so we can set file_drop_enabled = false.
            // On Windows, Tauri's built-in OLE Drop Target intercepts all drag-and-drop messages
            // at the Win32 level before WebView2 sees them, which prevents HTML5 dragover /
            // drop events from firing inside the WebView.  Disabling it lets WebView2 handle
            // drag-and-drop natively.  This setting cannot be applied via tauri.conf.json in
            // Tauri v2, so we must use the builder API.
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Aide")
            .inner_size(1400.0, 900.0)
            .min_inner_size(900.0, 600.0)
            .center()
            .decorations(false)
            .disable_drag_drop_handler()
            .build()?;

            #[cfg(target_os = "windows")]
            apply_window_theme(app);

            // 卡死诊断黑匣子 watchdog（须在主窗口创建之后：要解析 HWND）
            diagnostics::start(app.handle());

            // 注入 release 资源目录给 provider catalog 加载器（dev 走 CARGO_MANIFEST_DIR）
            #[cfg(not(debug_assertions))]
            {
                use tauri::Manager;
                if let Ok(res_dir) = app.path().resource_dir() {
                    let catalog_dir = res_dir.join("agent-runtime");
                    crate::runtime::provider::catalog::set_resource_dir(catalog_dir);
                    // CodeGraph embedding model bundled as a resource (release).
                    // dev mode resolves via CARGO_MANIFEST_DIR in embed::resolve_model_dir.
                    crate::codegraph::embed::set_model_resource_dir(res_dir);
                }
            }

            // 迁移老 provider schema（idempotent）——必须在 spawn_runtime 取 env 之前
            if let Err(e) = crate::runtime::provider::ensure_migrated() {
                tracing::error!("provider schema migration failed: {e}（继续用旧配置）");
            }

            // 启动持久 Agent Runtime（single persistent process，所有会话共享）
            // tokio::process::Command 需要 reactor——必须跑在 Tokio runtime 上，
            // setup 闭包是同步的，不能直接调 spawn_runtime。
            let handle1 = app.handle().clone();
            let handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(rt) = handle1.try_state::<runtime::AgentRuntimeManager>() {
                    use crate::runtime::env::build_runtime_env_vars;
                    let settings_service = handle1.state::<std::sync::Arc<settings::SettingsService>>().inner().clone();
                    let resolved = tokio::task::spawn_blocking(move || {
                        let active = settings_service.resolve_active_runtime_provider().map_err(|error| error.to_string())?;
                        let proxy = crate::commands::settings::public_settings(&settings_service)?.proxy;
                        Ok::<_, String>((active, proxy))
                    }).await;
                    let Ok(Ok((active, proxy))) = resolved else {
                        eprintln!("[aide] unable to resolve initial provider settings");
                        return;
                    };
                    let env_vars = build_runtime_env_vars(&active, &proxy);
                    if let Err(e) = rt.ensure_runtime(handle2, env_vars).await {
                        eprintln!("[aide] Agent Runtime 启动失败: {e}");
                    }
                }
            });

            // 冷启动带参：首次即被 `aide.exe <path>` 唤起时，single-instance 回调
            // 不会触发（首个实例），这里把路径暂存到 PendingOpenFile，前端 mount
            // 时通过 consume_pending_open_file 取走兜底；同时 emit 一份，若前端
            // 已就绪也能直接收到。
            if let Some(p) = std::env::args().nth(1) {
                if PathBuf::from(&p).is_file() {
                    if let Ok(mut g) = app.state::<PendingOpenFile>().0.lock() {
                        *g = Some(p.clone());
                    }
                    let _ = app.emit("open-file-preview", p);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::shell::pty_write,
            commands::shell::pty_resize,
            commands::shell::pty_kill,
            commands::shell::poll_pty_output,
            commands::shell::pty_spawn_shell,
            commands::filesystem::get_project_info,
            commands::filesystem::list_directory,
            commands::filesystem::list_fs_roots,
            commands::filesystem::file_open,
            commands::filesystem::read_file_content,
            commands::filesystem::read_file_base64,
            commands::filesystem::read_file_binary,
            commands::filesystem::write_file_content,
            commands::file_assoc::consume_pending_open_file,
            commands::file_assoc::register_open_with,
            commands::file_assoc::unregister_open_with,
            commands::file_assoc::set_open_with_extensions,
            commands::filesystem::delete_file,
            commands::filesystem::create_file,
            commands::filesystem::create_dir,
            commands::filesystem::show_in_explorer,
            commands::filesystem::detect_run_command,
            commands::filesystem::grep_symbol,
            commands::filesystem::file_exists,
            commands::filesystem::path_types,
            commands::filesystem::find_files_by_name,
            commands::filesystem::copy_file,
            commands::filesystem::move_file,
            commands::session::list_sessions,
            commands::session::list_sessions_for_workspace,
            commands::session::create_session,
            commands::session::delete_session,
            commands::session::rename_session,
            commands::session::auto_rename_session,
            commands::session::set_session_model,
            commands::session::session_model,
            commands::session::set_session_effort,
            commands::session::session_effort,
            commands::session::load_messages,
            commands::session::session_last_event,
            commands::session::load_session_changes,
            commands::session::save_session_changes,
            commands::session::session_jsonl_size,
            commands::session::session_truncate_jsonl,
            commands::session::find_sessions_since,
            commands::workspace::list_workspaces,
            commands::workspace::set_workspace,
            commands::workspace::create_workspace,
            commands::workspace::remove_workspace,
            commands::workspace::unhide_workspace,
            // 工作区信任（Trusted Workspace）
            commands::workspace::is_workspace_trusted,
            commands::workspace::trust_workspace,
            commands::workspace::untrust_workspace,
            commands::settings::get_settings,
            commands::settings::set_settings,
            commands::settings::notify_send,
            commands::settings::get_pending_notification,
            commands::permissions::get_permission_settings,
            commands::permissions::create_permission_rule,
            commands::permissions::update_permission_rule,
            commands::permissions::delete_permission_rule,
            commands::permissions::explain_permission_decision,
            commands::git::git_diff_files,
            commands::git::git_stage_all,
            commands::git::git_stage_file,
            commands::git::git_unstage_file,
            commands::git::git_revert_file,
            commands::git::log_frontend_error,
            commands::git::git_remote_url,
            commands::git::git_log,
            commands::git::git_show,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_stash,
            commands::git::git_stash_pop,
            commands::git::git_stash_list,
            commands::git::git_stash_apply,
            commands::git::git_stash_drop,
            commands::git::git_fetch,
            commands::git::git_ahead_behind,
            commands::git::git_discard_all,
            commands::git::git_unstage_all,
            commands::git::git_create_branch,
            commands::git::git_pull,
            commands::git::git_delete_branch,
            commands::git::git_diff_pair,
            commands::git::git_status,
            commands::git::git_unpushed_commits,
            commands::git::git_push,
            commands::git::git_fingerprint,
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
            commands::customizations::list_instructions,
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
            // Provider commands
            commands::provider::get_providers,
            commands::provider::set_providers,
            commands::provider::get_active_provider_id,
            commands::provider::set_active_provider_id,
            commands::provider::test_provider_connection,
            commands::provider::cpa_probe_port,
            commands::provider::cpa_open_management,
            commands::provider::cpa_login_status,
            commands::provider::view_anthropic_quota,
            commands::provider::refresh_models,
            commands::provider::refresh_system_default_models,
            commands::provider::get_provider_catalog,
            // Marketplace commands
            commands::marketplace::install::fetch_marketplace,
            commands::marketplace::install::install_plugin,
            commands::marketplace::install::uninstall_plugin,
            commands::marketplace::install::list_installed_plugins,
            commands::marketplace::install::refresh_marketplace,
            commands::marketplace::install::update_plugin,
            commands::marketplace::list_marketplace_sources,
            commands::marketplace::set_marketplace_enabled,
            commands::marketplace::set_plugin_enabled,
            // Run configuration commands
            commands::run_configs::list_run_configs,
            commands::run_configs::save_run_configs,
            commands::run_configs::detect_run_targets,
            // JDK registry (scan / resolve) — per-project JDK injection
            commands::jdk::scan_jdks,
            commands::jdk::resolve_jdk,
            // Run process lifecycle commands
            commands::run_process::run_process_start,
            commands::run_process::run_process_stop,
            // Clipboard paste (files / images) into the Claude TUI
            commands::clipboard::clipboard_read_files,
            commands::clipboard::clipboard_read_image,
            // Stage an externally-dropped OS file to temp (drop-handler fallback
            // when WebView2 doesn't expose File.path)
            commands::clipboard::stage_dropped_file,
            // Recent access
            commands::recent::record_recent_session,
            commands::recent::record_recent_file,
            commands::recent::list_recent,
            commands::recent::remove_recent_session,
            commands::recent::clear_recent,
            // Chat (Agent SDK)
            commands::chat::send_message,
            commands::chat::probe_image_input,
            commands::chat::permission_response,
            commands::chat::interrupt_session,
            commands::chat::stop_bg_task,
            commands::chat::set_model,
            commands::chat::set_effort,
            commands::chat::set_permission_mode,
            commands::chat::get_default_models,
            commands::chat::get_default_permission_modes,
            commands::chat::stop_chat_session,
            commands::chat::start_btw_session,
            // Plugin skills scanning
            commands::shell::scan_plugin_skills,
            // Code graph
            codegraph::build::codegraph_build_index,
            codegraph::commands::codegraph_goto_definition,
            codegraph::commands::codegraph_close,
            codegraph::commands::codegraph_reindex_file,
            codegraph::commands::codegraph_rescan,
            codegraph::commands::codegraph_build_progress,
            // 卡死诊断黑匣子
            diagnostics::diag_heartbeat,
            diagnostics::diag_freeze_supplement,
            // 通知中心持久化
            commands::notifications::load_notifications,
            commands::notifications::save_notifications,
            // 一次性迁移：从用户系统 ~/.claude/ 拷到 Aide 自管理目录
            commands::migration::check_claude_migration,
            commands::migration::migrate_claude_data,
            commands::migration::dismiss_claude_migration,
            // LSP built-in
            commands::workspace::workspace_set_lsp_enabled,
            commands::workspace::workspace_set_lsp_excludes,
            commands::workspace::workspace_get_lsp_excludes,
            lsp::lsp_detect_languages,
            lsp::lsp_ensure_server,
            lsp::lsp_did_open,
            lsp::lsp_did_change,
            lsp::lsp_did_close,
            lsp::lsp_definition,
            lsp::lsp_completion,
            lsp::lsp_hover,
            lsp::lsp_shutdown_workspace,
            lsp::open_lsp_install_guide,
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

    // Ensure decorations are off (tauri.conf.json sets this, but
    // window-state plugin may have restored stale state — belt-and-suspenders)
    let _ = window.set_decorations(false);

    // Enable dark theme for system dialogs etc.
    let _ = window.set_theme(Some(tauri::Theme::Dark));

    // Enable window shadow for borderless window (decorations: false)
    let _ = window.set_shadow(true);

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
