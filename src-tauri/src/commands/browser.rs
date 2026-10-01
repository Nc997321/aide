//! 内嵌浏览器命令层：**UI 薄壳**——只做「入参解析 → 门面 → 错误转文案」。
//!
//! 编排（校验 → 引擎 → 注册表 → 广播）全在 `browser::facade`：命令层是 UI 的适配器，不是能力
//! 本体。未来的 agent 工具桥接从**同一个门面**进（设计 §11：新增消费方 = 加适配器，不动内核）。
//!
//! **全部 `async`**：`add_child` / `eval` / `set_position` 内部 `run_on_main_thread` + 阻塞 `recv`，
//! 必须跑在 tokio worker（非主线程），否则主线程死锁（见 adapter/webview2/mod.rs）。
//! 用 `AppHandle`（`Send + 'static`，无生命周期）取状态，规避 async 命令里 `State<'_, T>` 的借用约束。

use std::collections::HashMap;

use tauri::{Manager, WebviewWindow};

use crate::browser::bookmarks::{parse, BookmarkStore};
use crate::browser::dto::{
    BookmarkDto, BoundsDto, BrowserViewDto, CreateBrowserDto, ImportReportDto,
};
use crate::browser::facade::BrowserFacade;
use crate::browser::favicons::FaviconStore;

type CmdResult<T> = Result<T, String>;

/// 门面按**调用窗口**作用域：视图属于创建它的窗口（一个窗口 = 一个 Host），Tauri 注入
/// 调用方窗口，命令层不认识任何窗口标签。
fn facade(window: &WebviewWindow) -> BrowserFacade {
    BrowserFacade::new(window.app_handle(), window.label())
}

/// 创建浏览器视图（id 由注册表发，调用方从返回快照里取）。
#[tauri::command]
pub async fn browser_create(window: WebviewWindow, dto: CreateBrowserDto) -> CmdResult<BrowserViewDto> {
    facade(&window)
        .create(&dto)
        .map_err(|e| e.to_string())
}

/// 列出全部视图（面板挂载时对账用）。**与 agent 的 `list_views` 同一个门面方法**——
/// 两条消费路径不能各查一份状态（那正是"面板看不见 agent 开的 tab"的来源）。
#[tauri::command]
pub async fn browser_views_list(window: WebviewWindow) -> CmdResult<Vec<BrowserViewDto>> {
    facade(&window)
        .list_views()
        .map_err(|e| e.to_string())
}

/// 导航到新 URL（与当前相同则按重载处理）。
#[tauri::command]
pub async fn browser_navigate(
    window: WebviewWindow,
    id: String,
    url: String,
) -> CmdResult<BrowserViewDto> {
    facade(&window)
        .navigate(&id, &url)
        .map_err(|e| e.to_string())
}

/// 布局同步：占位 div 的矩形拍到原生视图。
#[tauri::command]
pub async fn browser_set_bounds(window: WebviewWindow, id: String, bounds: BoundsDto) -> CmdResult<()> {
    facade(&window)
        .set_bounds(&id, bounds)
        .map_err(|e| e.to_string())
}

/// 显隐：切走面板时隐藏原生视图（否则它浮在全部内容之上）。
#[tauri::command]
pub async fn browser_set_displayed(window: WebviewWindow, id: String, displayed: bool) -> CmdResult<()> {
    facade(&window)
        .set_displayed(&id, displayed)
        .map_err(|e| e.to_string())
}

/// 后退。
#[tauri::command]
pub async fn browser_go_back(window: WebviewWindow, id: String) -> CmdResult<BrowserViewDto> {
    facade(&window)
        .go_back(&id)
        .map_err(|e| e.to_string())
}

/// 前进。
#[tauri::command]
pub async fn browser_go_forward(window: WebviewWindow, id: String) -> CmdResult<BrowserViewDto> {
    facade(&window)
        .go_forward(&id)
        .map_err(|e| e.to_string())
}

/// 关闭视图：引擎销毁子 webview + 领域移除。
#[tauri::command]
pub async fn browser_close(window: WebviewWindow, id: String) -> CmdResult<()> {
    facade(&window)
        .close(&id)
        .map_err(|e| e.to_string())
}

// ── 书签（收藏夹）：旁支数据能力 ──
//
// 不经 `BrowserFacade`：那些命令编排的是"视图"（引擎 + 注册表 + 广播），书签只是文件 + 纯逻辑，
// 没有可编排的东西。命令层与未来的 agent 工具直接调 `BookmarkStore`——同一个存储、同一条路径。

/// 读全部收藏。
#[tauri::command]
pub async fn browser_bookmarks_list() -> CmdResult<Vec<BookmarkDto>> {
    let list = BookmarkStore::at_default_location()
        .list()
        .map_err(|e| e.to_string())?;
    Ok(list.iter().map(BookmarkDto::from).collect())
}

/// 加一条收藏（过 `url_guard`；同 URL 幂等——重复点 ★ 不会堆一堆）。
#[tauri::command]
pub async fn browser_bookmarks_add(title: String, url: String) -> CmdResult<BookmarkDto> {
    BookmarkStore::at_default_location()
        .add(&title, &url)
        .map(|b| BookmarkDto::from(&b))
        .map_err(|e| e.to_string())
}

/// 删一条收藏（未知 id 返回 `false`，不报错——UI 的删除是幂等动作）。
#[tauri::command]
pub async fn browser_bookmarks_remove(id: String) -> CmdResult<bool> {
    BookmarkStore::at_default_location()
        .remove(&id)
        .map_err(|e| e.to_string())
}

/// 从文件导入（路径由应用内文件选择器给出）。
/// 字节先按 BOM 判编码再解文本——UTF-16 是记事本另存 HTML 的默认编码，直接 `read_to_string` 会失败。
#[tauri::command]
pub async fn browser_bookmarks_import(path: String) -> CmdResult<ImportReportDto> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{path}（{e}）"))?;
    let text = parse::decode_import_text(&bytes);
    BookmarkStore::at_default_location()
        .import(&text)
        .map(ImportReportDto::from)
        .map_err(|e| e.to_string())
}

/// 批量取站点图标：`url → data URI`。**查不到的 url 不会出现在结果里**（前端据此回落默认图标）。
///
/// 批量而不是逐条问：收藏条一屏几十条，一条一个来回太碎。查找链（精确 URL → 同主机）在
/// `browser::favicons` 里实现，命令层不复制规则——跟书签一样是**薄壳**。
#[tauri::command]
pub async fn browser_favicons(urls: Vec<String>) -> CmdResult<HashMap<String, String>> {
    let store = FaviconStore::at_default_location();
    Ok(urls
        .into_iter()
        .filter_map(|url| store.get(&url).map(|icon| (url, icon)))
        .collect())
}
