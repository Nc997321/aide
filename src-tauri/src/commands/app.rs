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
    if let Some(rt) = app.try_state::<crate::runtime::AgentRuntimeManager>() {
        rt.kill_runtime().await;
    }
    // 2) LSP server（按 工作区×语言 拉起，java / go / ts 各一个进程）
    if let Some(lsp) = app.try_state::<std::sync::Arc<crate::lsp::LspState>>() {
        lsp.kill_all().await;
    }
    // 3) codegraph runner 不在此列：proxy 内有 idle_reaper 空闲自动回收兜底，
    //    且 CodeGraphService 尚未暴露 kill_runner 接口。
}
