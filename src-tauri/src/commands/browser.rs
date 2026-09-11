//! 内嵌浏览器命令层（薄外壳，functional core / imperative shell）：
//! 拿数据 → 调纯核心校验（url_guard / DTO TryFrom）→ 调引擎端口 → 更新领域注册表 → 送回 DTO。
//!
//! **全部 `async`**：`add_child` / `eval` / `set_position` 内部 `run_on_main_thread` + 阻塞 `recv`，
//! 必须跑在 tokio worker（非主线程），否则主线程死锁（见 adapter/webview2/mod.rs）。
//! 用 `AppHandle`（`Send + 'static`，无生命周期）取 state，规避 async 命令里 `State<'_, T>` 的借用约束。

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

use crate::browser::adapter::PlatformEngine;
use crate::browser::core::url_guard;
use crate::browser::dto::{BoundsDto, BrowserViewDto, CreateBrowserDto};
use crate::browser::port::engine::{BrowserEngine, CreateCfg};
use crate::browser::port::types::{Bounds, BrowserView, BrowserViewId};
use crate::browser::state::{BrowserRegistry, BrowserState};

type CmdResult<T> = Result<T, String>;

/// 主窗口 label（lib.rs setup 里创建的 "main"）。
const MAIN_WINDOW: &str = "main";

fn engine(app: &AppHandle) -> Arc<PlatformEngine> {
    app.state::<Arc<PlatformEngine>>().inner().clone()
}

fn registry(app: &AppHandle) -> Arc<Mutex<BrowserRegistry>> {
    app.state::<BrowserState>().0.clone()
}

fn main_window(app: &AppHandle) -> CmdResult<tauri::Window<tauri::Wry>> {
    app.get_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())
}

fn lock(reg: &Arc<Mutex<BrowserRegistry>>) -> CmdResult<std::sync::MutexGuard<'_, BrowserRegistry>> {
    reg.lock().map_err(|e| e.to_string())
}

/// 创建浏览器视图：校验 url/bounds → 引擎建子 webview → 领域记账（首导航入历史）→ 回快照。
#[tauri::command]
pub async fn browser_create(app: AppHandle, dto: CreateBrowserDto) -> CmdResult<BrowserViewDto> {
    let id = BrowserViewId::try_new(dto.id).map_err(|e| e.to_string())?;
    let url = url_guard::guard(&dto.url).map_err(|e| e.to_string())?;
    let bounds = Bounds::try_from(dto.bounds).map_err(|e| e.to_string())?;

    let window = main_window(&app)?;
    engine(&app)
        .create(
            &window,
            id.clone(),
            CreateCfg {
                initial_url: url.clone(),
                bounds,
                user_agent: None,
                devtools: false,
            },
        )
        .map_err(|e| e.to_string())?;

    let mut view = BrowserView::new(id, bounds);
    view.begin_nav(url);
    let snapshot = BrowserViewDto::from(&view);
    lock(&registry(&app))?.insert(view);
    Ok(snapshot)
}

/// 导航到新 URL：校验 → 引擎 eval location.href → 领域 begin_nav → 回快照。
#[tauri::command]
pub async fn browser_navigate(app: AppHandle, id: String, url: String) -> CmdResult<BrowserViewDto> {
    let id = BrowserViewId::try_new(id).map_err(|e| e.to_string())?;
    let url = url_guard::guard(&url).map_err(|e| e.to_string())?;
    engine(&app).navigate(&id, &url).map_err(|e| e.to_string())?;

    let reg = registry(&app);
    let mut reg = lock(&reg)?;
    let view = reg
        .get_mut(&id)
        .ok_or_else(|| "browser view not found".to_string())?;
    view.begin_nav(url);
    Ok(BrowserViewDto::from(&*view))
}

/// 布局同步：占位 div 的矩形拍到原生视图 + 领域。
#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, id: String, bounds: BoundsDto) -> CmdResult<()> {
    let id = BrowserViewId::try_new(id).map_err(|e| e.to_string())?;
    let bounds = Bounds::try_from(bounds).map_err(|e| e.to_string())?;
    engine(&app)
        .set_bounds(&id, bounds)
        .map_err(|e| e.to_string())?;

    let reg = registry(&app);
    if let Some(view) = lock(&reg)?.get_mut(&id) {
        view.set_bounds(bounds);
    }
    Ok(())
}

/// 显隐：切走面板时隐藏原生视图（否则它浮在全部内容之上）。
#[tauri::command]
pub async fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> CmdResult<()> {
    let id = BrowserViewId::try_new(id).map_err(|e| e.to_string())?;
    engine(&app)
        .set_visible(&id, visible)
        .map_err(|e| e.to_string())?;

    let reg = registry(&app);
    if let Some(view) = lock(&reg)?.get_mut(&id) {
        view.set_visible(visible);
    }
    Ok(())
}

/// 后退：领域移游标取目标 url（历史唯一主人是 BrowserView）→ 引擎 navigate → 回快照。
#[tauri::command]
pub async fn browser_go_back(app: AppHandle, id: String) -> CmdResult<BrowserViewDto> {
    let id = BrowserViewId::try_new(id).map_err(|e| e.to_string())?;
    let (target, snapshot) = {
        let reg = registry(&app);
        let mut reg = lock(&reg)?;
        let view = reg
            .get_mut(&id)
            .ok_or_else(|| "browser view not found".to_string())?;
        (view.go_back(), BrowserViewDto::from(&*view))
    };
    if let Some(url) = target {
        engine(&app).navigate(&id, &url).map_err(|e| e.to_string())?;
    }
    Ok(snapshot)
}

/// 前进：对称于后退。
#[tauri::command]
pub async fn browser_go_forward(app: AppHandle, id: String) -> CmdResult<BrowserViewDto> {
    let id = BrowserViewId::try_new(id).map_err(|e| e.to_string())?;
    let (target, snapshot) = {
        let reg = registry(&app);
        let mut reg = lock(&reg)?;
        let view = reg
            .get_mut(&id)
            .ok_or_else(|| "browser view not found".to_string())?;
        (view.go_forward(), BrowserViewDto::from(&*view))
    };
    if let Some(url) = target {
        engine(&app).navigate(&id, &url).map_err(|e| e.to_string())?;
    }
    Ok(snapshot)
}

/// 关闭视图：引擎销毁子 webview + 领域移除。
#[tauri::command]
pub async fn browser_close(app: AppHandle, id: String) -> CmdResult<()> {
    let id = BrowserViewId::try_new(id).map_err(|e| e.to_string())?;
    engine(&app).close(&id).map_err(|e| e.to_string())?;
    lock(&registry(&app))?.remove(&id);
    Ok(())
}
