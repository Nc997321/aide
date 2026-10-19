use tauri::AppHandle;
use tauri::Manager;

/// 应用版本号（package_info，纯内存读取，inline 命令安全）。
/// 前端品牌区/关于页用；不进远程 RPC 白名单（PWA 无此需求）。
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 真正退出应用：先收掉 aide 拉起的常驻子进程，再退出进程。
///
/// 托盘化之后「点标题栏 X = 隐藏窗口」（见 lib.rs 的 CloseRequested 拦截），
/// 这是唯一的真退出出口——托盘菜单「退出 Aide」调它。
///
/// 为什么必须显式收子进程：Windows 没有父子进程级联 kill，aide.exe 消失后
/// agent runtime（node，常驻）与 LSP server（java 等）会变孤儿继续跑。用户
/// 「关了窗口却还能在后台看到它们」就是这么来的。
#[tauri::command]
pub async fn quit_app(app: AppHandle) {
    shutdown_children(&app).await;
    app.exit(0);
}

/// 退出前清理常驻子进程。best-effort：任一环未初始化或失败都不阻塞退出。
pub(crate) async fn shutdown_children(app: &AppHandle) {
    // 1) Agent Runtime（node 常驻进程，所有会话共享那一个）
    // 2) LSP server（按 工作区×语言 拉起，java / go / ts 各一个进程）——两者都住 Host 核心
    if let Some(core) = app.try_state::<std::sync::Arc<aide_core::Core>>() {
        core.runtime.kill_runtime().await;
        core.lsp.kill_all().await;
        // 3) 侧栏应用的后端（给界面用的那一份；会话里的那份随 Agent Runtime 一起走）和它们起的进程
        aide_core::apps::shutdown(&core);
    }
}

// ── 关闭最后一扇窗口时做什么（标题栏 X / Alt+F4 / 任务栏关闭）──
//
// 是桌面外壳自己的偏好（托盘只有 GUI 前门才有），**不进 Host 设置**：WSL / SSH 窗口的设置页
// 改的是那台 Host 的文档，而决定关窗行为的是本机这个进程。落本机 state.json 的 `closeBehavior`。

/// 关闭行为。缺省 / 未知值 = `Ask`（每次弹「关闭 Aide 窗口？」卡片）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    Ask,
    Tray,
    Quit,
}

const CLOSE_BEHAVIOR_KEY: &str = "closeBehavior";

fn parse_close_behavior(state: &serde_json::Value) -> CloseBehavior {
    serde_json::from_value(state[CLOSE_BEHAVIOR_KEY].clone()).unwrap_or(CloseBehavior::Ask)
}

/// 同步读（CloseRequested 回调里用：state.json 很小，读一次可以接受）。
pub(crate) fn close_behavior() -> CloseBehavior {
    parse_close_behavior(&aide_core::app_settings::load_state())
}

#[tauri::command]
pub async fn get_close_behavior() -> Result<CloseBehavior, String> {
    tauri::async_runtime::spawn_blocking(close_behavior)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_close_behavior(behavior: CloseBehavior) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        aide_core::app_settings::with_state_mut(|state| {
            if !state.is_object() {
                *state = serde_json::json!({});
            }
            state[CLOSE_BEHAVIOR_KEY] = serde_json::to_value(behavior).map_err(|e| e.to_string())?;
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 托盘建成了没有（Linux 缺 libappindicator 时建不出来）。没有托盘时「收进托盘」等于窗口
/// 找不回来，关闭一律按退出处理，也不弹询问。
static TRAY_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn mark_tray_ready() {
    TRAY_READY.store(true, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn tray_ready() -> bool {
    TRAY_READY.load(std::sync::atomic::Ordering::Relaxed)
}

/// 关最后一扇窗口时实际要做的事（纯函数，便于测试）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CloseAction {
    /// 让前端弹询问卡片
    Ask,
    Hide,
    Quit,
}

pub(crate) fn decide_close(behavior: CloseBehavior, tray: bool) -> CloseAction {
    match (behavior, tray) {
        (_, false) | (CloseBehavior::Quit, _) => CloseAction::Quit,
        (CloseBehavior::Tray, true) => CloseAction::Hide,
        (CloseBehavior::Ask, true) => CloseAction::Ask,
    }
}

/// 真退出（与托盘「退出 Aide」同一条路：先收常驻子进程再 exit）。
pub(crate) fn quit_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        shutdown_children(&app).await;
        app.exit(0);
    });
}

#[cfg(test)]
mod close_tests {
    use super::*;

    #[test]
    fn unknown_or_missing_value_means_ask() {
        assert_eq!(parse_close_behavior(&serde_json::json!({})), CloseBehavior::Ask);
        assert_eq!(parse_close_behavior(&serde_json::json!({"closeBehavior": "bogus"})), CloseBehavior::Ask);
        assert_eq!(parse_close_behavior(&serde_json::json!({"closeBehavior": "tray"})), CloseBehavior::Tray);
        assert_eq!(parse_close_behavior(&serde_json::json!({"closeBehavior": "quit"})), CloseBehavior::Quit);
    }

    #[test]
    fn without_tray_closing_always_quits() {
        for b in [CloseBehavior::Ask, CloseBehavior::Tray, CloseBehavior::Quit] {
            assert_eq!(decide_close(b, false), CloseAction::Quit);
        }
        assert_eq!(decide_close(CloseBehavior::Ask, true), CloseAction::Ask);
        assert_eq!(decide_close(CloseBehavior::Tray, true), CloseAction::Hide);
        assert_eq!(decide_close(CloseBehavior::Quit, true), CloseAction::Quit);
    }
}
