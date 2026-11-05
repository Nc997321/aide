//! 仅 debug 的独立真机验收宿主：隔离 Core/浏览器 profile，不启动 SDK 或重载用户窗口。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;

use crate::browser::{adapter::PlatformEngine, state::BrowserState};
use crate::host_window::HostWindows;

const PAGE: &str = include_str!("probe.html");

pub(crate) fn run(root: PathBuf, files: Vec<PathBuf>) -> Result<(), String> {
    let initialization = initialization(&files)?;
    let core = aide_core::Core::isolated(root.join("host"), Arc::new(aide_core::NullSink));
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.aide.media-probe".into();
    context.config_mut().build.dev_url = None;
    probe_builder(core, root, initialization).run(context).map_err(|e| e.to_string())
}

fn initialization(files: &[PathBuf]) -> Result<String, String> {
    if files.is_empty() { return Err("usage: media_probe <isolated-root> <media-file> [other-media-files...]".into()); }
    let files: Vec<_> = files.iter().map(|path| serde_json::json!({
        "path": path.to_string_lossy(), "title": path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default()
    })).collect();
    Ok(format!("window.__probeFiles={};", serde_json::to_string(&files).map_err(|e| e.to_string())?))
}

fn probe_builder(core: Arc<aide_core::Core>, root: PathBuf, script: String) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(core).manage(HostWindows::default())
        .manage(Arc::new(PlatformEngine::new())).manage(BrowserState::new())
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("aide-media-probe", |_, _| {
            tauri::http::Response::builder().header("Content-Type", "text/html; charset=utf-8")
                .body(PAGE.as_bytes().to_vec()).expect("fixed probe document headers are valid")
        })
        .setup(move |app| {
            crate::remote_workspace::manage(app);
            super::manage(app.handle());
            create_window(app, &root, &script)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                super::release_window(window.app_handle(), window.label());
                crate::browser::facade::release_window(window.app_handle(), window.label());
            }
        })
        .invoke_handler(dispatcher())
}

fn create_window(app: &tauri::App, root: &std::path::Path, script: &str) -> Result<(), tauri::Error> {
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(
        "aide-media-probe://localhost/".parse().expect("fixed probe URL is valid")
    )).title("Aide · isolated media acceptance probe")
        .inner_size(1200.0, 850.0).data_directory(root.join("webview"))
        .initialization_script(script).build()?;
    Ok(())
}

fn dispatcher() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let commands: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![
        crate::commands::media::media_preview_open, crate::commands::media::media_feedback_ack,
        crate::commands::browser::browser_views_list, crate::commands::browser::browser_close,
        crate::commands::browser::browser_set_bounds, crate::commands::browser::browser_set_displayed,
    ]);
    move |invoke| match crate::host_door::dispatch(invoke) {
        Some(invoke) => commands(invoke),
        None => true,
    }
}
