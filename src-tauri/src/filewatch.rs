//! 工作区文件系统监听的 Tauri 外壳。归集 / 防抖 / 生命周期全在
//! [`aide_workspace::watch`]（与远程工作区的 aide-host 共用）；这里只把事件出口
//! 接到 `app.emit("file-tree-changed")`。

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

pub use aide_workspace::watch::{FileWatchService, WatchSink, EVENT_NAME};

fn emit_sink(app: AppHandle) -> WatchSink {
    Arc::new(move |dirs: Vec<String>| app.emit(EVENT_NAME, dirs).map_err(|e| e.to_string()))
}

/// 本地监听重定向（`None` = 停表）。IPC 拦截层在工作区切到远程时也调它停掉本地表。
pub fn retarget_local(
    svc: &FileWatchService,
    root: Option<&Path>,
    app: &AppHandle,
) -> Result<(), String> {
    svc.retarget(root, &emit_sink(app.clone()))
}

/// 前端 FileTree 在 loadRoot 成功后调用：把监控指向当前工作区根（或空串停表）。
///
/// async + spawn_blocking：watch 的重活在 Linux 侧（Recursive = 全树逐目录
/// inotify_add_watch + 遍历，node_modules 规模属重 IO）且在 retarget 的
/// Mutex 内；Windows（RDCW 单 syscall）顺带受益。注意 State 不能跨
/// spawn_blocking（CLAUDE.md 红线）——先 Arc clone 成 owned 值再 move。
#[tauri::command]
pub async fn file_tree_watch(
    root: String,
    app: AppHandle,
    svc: State<'_, Arc<FileWatchService>>,
) -> Result<(), String> {
    let svc = svc.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = (!root.is_empty()).then(|| Path::new(&root).to_path_buf());
        retarget_local(&svc, root.as_deref(), &app)
    })
    .await
    .map_err(|e| format!("文件监听任务中断: {e}"))?
}
