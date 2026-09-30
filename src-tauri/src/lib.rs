mod automation;
// 内嵌浏览器子系统（骨架阶段：纯核心+领域类型+端口签名已落地并单测；adapter/命令待
// 可视原型定 A/B 后填充）。私有模块，对外经 commands 暴露命令。
mod browser;
// commands/remote/settings 公开给集成测试（tests/ 目录只能访问 crate 公开 API，
// 测试分离布局要求源文件零测试代码，集成测试是唯一测试面）
pub mod commands;
mod conversation;
mod diagnostics;
mod host_door;
mod lsp;
/// 权限策略住在 aide-core（Host 自持）；保留 `crate::policy` 路径。
use aide_core::{codegraph, policy};
pub mod remote;
// 远程工作区（WSL / SSH 目标机上的项目，GUI 留在桌面）。与上面的 remote（手机遥控桌面）无关。
pub(crate) mod remote_workspace;
pub mod runtime;
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

    // state.json 播种（legacy config.json → state.json 一次性 key 搬迁）必须在
    // load_workspace_state 之前——它读的就是 state.json。幂等；失败保留 legacy
    // 文件，设置迁移清理时会重试。
    if let Err(e) = commands::settings::seed_state_from_legacy(
        &commands::config_path(),
        &commands::state_path(),
    ) {
        eprintln!("[aide] state.json seeding failed: {e}");
    }
    // 工作区显式注册表一次性迁移（扫 claude/projects 播种，marker 幂等）必须在
    // 活动工作区恢复之前——恢复路径优先查注册表。失败不阻断启动，下次重试。
    if let Err(e) = commands::workspace::ensure_registry_migrated() {
        eprintln!("[aide] workspace registry migration failed: {e}");
    }
    // 日常目录引导：建目录 + 幂等注册。**刻意不激活**——活动工作区仍由下面的恢复链
    // 与用户操作决定（「日常」是内部实现细节，不该顶掉用户的当前项目，也不该影响
    // 引导向导的跳过判据）。失败不阻断启动（与上面同策略）。
    if let Err(e) = commands::workspace::daily::ensure_daily_workspace() {
        eprintln!("[aide] daily workspace bootstrap failed: {e}");
    }
    let saved_key = commands::load_workspace_state();
    // 「工作区还在吗」注入远程感知判定：远程路径同步 stat 不了，按存在处理（Host 核心的
    // 根解析 / 工作区列表、桌面的会话 cwd 兜底共用这一判定）。
    aide_core::workspace::set_presence_check(remote_workspace::path::present);
    aide_core::commands::terminal::set_remote_shell(remote_workspace::launcher::remote_shell);
    let workspace_state = std::sync::Arc::new(WorkspaceState::new());
    // 设置服务是 Host 自持状态：Tauri 与 aide-core 共享同一实例（密钥端口 = OS 钥匙串）。
    let settings_service = std::sync::Arc::new(settings::SettingsService::new(
        settings::SettingsPaths::new().expect("settings paths"),
        std::sync::Arc::new(settings::KeyringSecretStore::new()),
    ));
    if let Some(key) = saved_key {
        // 活动工作区 path 解析：注册表优先（真实 path 权威源）；解码回退兜
        // 注册表落地前的旧数据（resolve_path_from_key 仅存的运行时用途之一）。
        let path =
            commands::workspace::registered_path_for_key(&commands::settings::load_state(), &key)
                .or_else(|| commands::resolve_path_from_key(&key));
        if let Some(path) = path {
            *workspace_state.path.lock().unwrap() = Some(std::path::PathBuf::from(&path));
        }
        *workspace_state.key.lock().unwrap() = Some(key);
    }

    let builder = tauri::Builder::default();
    // 单实例（**仅 release**）：二次启动唤出首实例窗口、转发 argv 后立即退出。
    //
    // dev 豁免（`#[cfg(not(debug_assertions))]`）是刻意保留的——开发期要与安装版
    // 并存。但它**与「dev 不连中继」是一对**：两个实例共用 identifier（com.aide.app）
    // 与同一 settings.json（remote device_id 同源），双双注册会在 relay 上互踢——
    // 2026-09-18 实测 ~500 注册/秒、六天 6.5GB 日志，手机每次桥接几毫秒内被顶断。
    // 所以豁免的另一半挡在 `remote/mod.rs` 的 relay_allowed_in_this_build()：
    // **改这里必须同时看那里**，只改一边就会把互踢放回来。
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // 唤出主窗口：二次启动的最小预期反馈（用户再点图标不该毫无反应）。
        // 窗口可能已被「点 X」隐藏到托盘：必须先 show 再 focus——set_focus
        // 对隐藏窗口无效。
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        // 资源管理器「打开方式 → Aide」以 `aide.exe <path>` 唤起：转发给首个实例。
        if let Some(p) = argv.get(1) {
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
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                    // Exclude DECORATIONS — let tauri.conf.json be authoritative
                    //
                    // Exclude VISIBLE — 托盘化后「点 X = 隐藏窗口」，一旦把
                    // visible=false 持久化，下次启动 restore 会把窗口恢复成
                    // 不可见：只剩托盘图标、窗口怎么点都叫不出来。可见性一律
                    // 由 setup 里显式 show() 决定，不进持久化。
                )
                .build(),
        )
        .manage(diagnostics::DiagnosticsState::new())
        .manage(std::sync::Arc::clone(&settings_service))
        .manage(runtime::AgentRuntimeManager::new())
        // 后台任务快照注册表：事件泵喂入（runtime/mod.rs），list_bg_tasks RPC 读
        .manage(std::sync::Arc::new(
            runtime::bg_registry::BgTaskRegistry::default(),
        ))
        .manage(std::sync::Arc::clone(&workspace_state))
        .manage(PendingOpenFile(std::sync::Mutex::new(None)))
        // 点标题栏 X = 隐藏到托盘，进程常驻：automation 定时调度、agent runtime
        // （node 常驻）、remote 网关都需要 aide.exe 活着。真正退出的唯一出口是
        // 托盘菜单「退出 Aide」→ commands::app::quit_app，那里先杀常驻子进程
        // 再 exit(0)（Windows 无父子进程级联 kill，不显式收就留孤儿）。
        //
        // 隐藏是瞬时的：试过让前端播 CSS 收缩动画再 hide，但窗口是
        // decorations(false) + DWM 阴影，窗口矩形本身肉眼可见——CSS 只缩放了
        // WebView 内容，空框仍钉在原地，观感比没动画更怪。要真收缩得 Rust
        // 侧逐帧 set_size/set_position（内容还被裁不是缩放），代价远大于收益。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .manage(std::sync::Arc::new(lsp::LspState::new()))
        .manage(std::sync::Arc::new(automation::AutomationService::new()))
        // 内嵌浏览器：平台引擎（Windows=Webview2Engine）+ 领域视图注册表。
        .manage(std::sync::Arc::new(browser::adapter::PlatformEngine::new()))
        .manage(browser::state::BrowserState::new())
        .setup(move |app| {
            // 本机 Host 核心：与 Tauri 共享同一个活动工作区实例；事件经 Tauri 广播。
            app.manage(aide_core::Core::new(
                std::sync::Arc::clone(&workspace_state),
                std::sync::Arc::clone(&settings_service),
                std::sync::Arc::new(host_door::TauriSink(app.handle().clone())),
                std::sync::Arc::new(host_door::DesktopResources(app.handle().clone())),
            ));
            app.state::<std::sync::Arc<settings::SettingsService>>()
                .initialize_blocking()
                .map_err(|error| std::io::Error::other(error.to_string()))?;

            // 远程控制网关：manage 需要 AppHandle，只能在 setup 内注册。
            // initialize_blocking 必须先于 public_settings（未初始化读会报 NotInitialized）。
            remote_workspace::manage(app);
            app.manage(std::sync::Arc::new(remote::RemoteGateway::new(
                app.handle().clone(),
            )));
            // 设置开启则随 app 启动
            {
                let gateway = app.state::<std::sync::Arc<remote::RemoteGateway>>();
                let service = app.state::<std::sync::Arc<settings::SettingsService>>();
                let enabled = commands::settings::public_settings(service.inner())
                    .map(|s| s.remote.enabled)
                    .unwrap_or(false);
                if enabled {
                    gateway.start();
                }
            }

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
            // 托盘化后 window-state 不再持久化/恢复 VISIBLE（会把「隐藏到托盘」
            // 存成 visible=false，下次启动窗口叫不出来），可见性这里定死。
            .visible(true)
            .disable_drag_drop_handler()
            .build()?;

            #[cfg(target_os = "windows")]
            apply_window_theme(app);

            // 卡死诊断黑匣子 watchdog（须在主窗口创建之后：要解析 HWND）
            diagnostics::start(app.handle());

            // 冻结报告现场完整性自检（仅 dev/诊断包；AIDE_FREEZE_SELFCHECK=<ms>）
            // ——注入真冻结后审报告，退出码即 verdict。见 selfcheck.rs 注释。
            #[cfg(any(debug_assertions, feature = "devtools"))]
            diagnostics::selfcheck::selfcheck_on_startup(app.handle());

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
                    let settings_service = handle1
                        .state::<std::sync::Arc<settings::SettingsService>>()
                        .inner()
                        .clone();
                    let resolved = tokio::task::spawn_blocking(move || {
                        let active = settings_service
                            .resolve_active_runtime_provider()
                            .map_err(|error| error.to_string())?;
                        let proxy =
                            crate::commands::settings::public_settings(&settings_service)?.proxy;
                        Ok::<_, String>((active, proxy))
                    })
                    .await;
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

            // 自动化调度器：常驻 tokio task（30s tick + 启动 missed-run 扫描）。
            // M1 只观测日志；M2 接通 send_to_runtime 执行链。
            {
                let svc = app.state::<std::sync::Arc<automation::AutomationService>>();
                svc.inner().clone().start(app.handle().clone());
            }

            // 内置插件：后台确保已安装/版本更新（git 网络 IO，必须 spawn_blocking +
            // 失败只记日志，不阻塞启动——CLAUDE.md 主线程红线）。用户已卸载（墓碑）
            // 或手动禁用的内置插件不会被复活/重置，见 marketplace/bundled.rs。
            {
                let service = app
                    .state::<std::sync::Arc<settings::SettingsService>>()
                    .inner()
                    .clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tokio::task::spawn_blocking(move || {
                        commands::marketplace::bundled::ensure_bundled_plugins_installed(&service);
                    })
                    .await;
                });
            }

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

            // 托盘：点 X 隐藏窗口后的唯一出口（左键切换显示 / 右键菜单退出）。
            // 失败只记日志不阻断启动——Linux 缺 libappindicator 时 tray 不可用，
            // 托盘是增强项，不该让整个 app 起不来。
            if let Err(e) = setup_tray(app.handle()) {
                tracing::error!("tray setup failed: {e}（点 X 将退化为直接退出）");
            }

            Ok(())
        })
        // 远程工作区的 IPC 拦截层包在命令分派外面：参数里带远程路径的工作区命令在这里
        // 转发给目标机（见 remote_workspace/routes.rs），其余原样交给命令表。
        .invoke_handler({
            let commands: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
            commands::browser::browser_create,
            commands::browser::browser_navigate,
            commands::browser::browser_set_bounds,
            commands::browser::browser_set_displayed,
            commands::browser::browser_views_list,
            commands::browser::browser_go_back,
            commands::browser::browser_go_forward,
            commands::browser::browser_close,
            commands::browser::browser_bookmarks_list,
            commands::browser::browser_bookmarks_add,
            commands::browser::browser_bookmarks_remove,
            commands::browser::browser_bookmarks_import,
            commands::browser::browser_favicons,
            commands::filesystem::file_open,
            commands::file_assoc::consume_pending_open_file,
            commands::file_assoc::register_open_with,
            commands::file_assoc::unregister_open_with,
            commands::file_assoc::set_open_with_extensions,
            commands::filesystem::show_in_explorer,
            automation::commands::list_automations,
            automation::commands::get_automation,
            automation::commands::create_automation,
            automation::commands::update_automation,
            automation::commands::delete_automation,
            automation::commands::set_automation_enabled,
            automation::commands::list_automation_runs,
            automation::commands::automation_run_stats,
            automation::commands::run_automation_now,
            automation::commands::get_automation_playbook,
            automation::commands::redistill_automation,
            commands::session_runtime::session_alive,
            // 工作区信任（Trusted Workspace）
            commands::workspace_trust::trust_workspace,
            commands::workspace_trust::untrust_workspace,
            commands::settings::notify_send,
            commands::settings::session_notification_info,
            commands::permissions::get_permission_settings,
            commands::permissions::create_permission_rule,
            commands::permissions::create_permission_rules,
            commands::permissions::update_permission_rule,
            commands::permissions::delete_permission_rule,
            commands::permissions::explain_permission_decision,
            commands::app::get_app_version,
            // 托盘菜单「退出 Aide」的出口。刻意不进 remote RPC 白名单——远端
            // PWA 不该有把桌面端进程干掉的能力。
            commands::app::quit_app,
            // Customization commands
            commands::mcp_probe::test_mcp_connection,
            // Provider commands
            // Marketplace commands
            // Run configuration commands
            // JDK registry (scan / resolve) — per-project JDK injection
            // Run process lifecycle commands
            // Clipboard paste (files / images) into the Claude TUI
            commands::clipboard::clipboard_read_files,
            commands::clipboard::clipboard_write_files,
            // Workspace FS watching: auto-refresh the file tree on external changes
            commands::clipboard::clipboard_read_image,
            // Stage an externally-dropped OS file to temp (drop-handler fallback
            // when WebView2 doesn't expose File.path)
            commands::clipboard::stage_dropped_file,
            // Recent access
            // Chat (Agent SDK)
            commands::chat::send_message,
            commands::chat::permission_response,
            commands::chat::interrupt_session,
            commands::chat::stop_bg_task,
            commands::chat::set_model,
            commands::chat::model_switch_confirm_decision,
            commands::chat::set_effort,
            commands::chat::set_permission_mode,
            commands::chat::get_default_models,
            commands::chat::get_default_permission_modes,
            commands::chat::stop_chat_session,
            commands::chat::btw_ask,
            // Knowledge base runtime credentials
            // (→ `~/.aide/` 下的凭据文件，名称随构建档位：dev = knowledge.dev.json，release = knowledge.json)
            // Plugin skills scanning
            // Code graph
            // 卡死诊断黑匣子
            diagnostics::log_frontend_error,
            diagnostics::diag_heartbeat,
            diagnostics::diag_freeze_supplement,
            #[cfg(any(debug_assertions, feature = "devtools"))]
            diagnostics::open_devtools,
            // 通知中心持久化
            // 一次性迁移：从用户系统 ~/.claude/ 拷到 Aide 自管理目录
            // LSP built-in
            // 工作区级代码索引开关（每工作区默认关，右侧栏面板读写）
            // 工作区级 JDK（一个工作区一个 JDK，所有运行配置共享）
            lsp::lsp_detect_languages,
            lsp::lsp_ensure_server,
            lsp::lsp_did_open,
            lsp::lsp_did_change,
            lsp::lsp_did_close,
            lsp::lsp_definition,
            lsp::lsp_references,
            lsp::lsp_call_hierarchy,
            lsp::lsp_inlay_hints,
            lsp::lsp_completion,
            lsp::lsp_completion_resolve,
            lsp::lsp_signature_help,
            lsp::lsp_semantic_tokens,
            lsp::lsp_did_save,
            lsp::lsp_hover,
            lsp::lsp_implementation,
            lsp::lsp_document_symbol,
            lsp::workspace_symbol::lsp_workspace_symbol,
            lsp::lsp_capabilities,
            lsp::lsp_shutdown_workspace,
            lsp::open_lsp_install_guide,
            commands::remote::remote_get_status,
            commands::remote::remote_set_enabled,
            commands::remote::remote_refresh_pairing_code,
            commands::remote::remote_revoke,
            remote_workspace::remote_ws_targets,
            remote_workspace::remote_ws_connect,
            remote_workspace::remote_ws_disconnect,
            remote_workspace::remote_ws_statuses,
            remote_workspace::remote_ws_host_of,
            ]);
            // 远程工作区拦截 → 本机 Host 命令表（aide-core）→ 其余 Tauri 命令。
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                match remote_workspace::routes::intercept(invoke).and_then(host_door::dispatch) {
                    Some(invoke) => commands(invoke),
                    None => true,
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 托盘：点标题栏 X 隐藏窗口后的唯一出口。
///
/// - 左键单击：显示 ⇄ 隐藏 切换（最高频的恢复动作）
/// - 右键菜单：显示 Aide / 退出 Aide
///
/// `show_menu_on_left_click(false)` 是关键：默认左键也会弹菜单，那样左键切换
/// 这个动作就被吃掉了，只能靠右键菜单恢复。
fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItemBuilder::with_id("show", "显示 Aide").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 Aide").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Aide")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                // 退出前必须收常驻子进程（Windows 无级联 kill）。清理是 async，
                // 交给 tauri 的 async_runtime，收完再 exit(0)。
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::commands::app::shutdown_children(&app).await;
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    // 图标复用主窗口图标（generate_context! 已内嵌成 Image）。来源按平台分派：
    // Windows 取 bundle.icon 里第一个 .ico，其余平台取第一个 .png。
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// 显示并聚焦主窗口（托盘「显示 Aide」与二次启动唤起共用）。
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 左键切换：已显示且聚焦 → 隐藏；否则显示并聚焦。
fn toggle_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main_window(app);
        }
    }
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
