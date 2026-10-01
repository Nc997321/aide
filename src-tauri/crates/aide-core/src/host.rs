//! Host 的启动引导——**本机与远程 Host 共用这一份**（桌面 setup 与 `aide-host serve` 都调）。
//!
//! 为什么收在一处：Host 的启动职责（数据迁移、日常目录、恢复活动工作区、拉起 runtime /
//! 自动化 / 内置插件）一旦只写在某个前门里，另一扇门就少一截——2026-09-30 真机：
//! `aide-host serve` 没做日常目录引导，WSL 窗口的日常会话 cwd 不存在，sidecar 起 claude
//! 报 ENOENT（SDK 误报成 libc 不匹配）。新增 Host 级启动职责一律加在这里。

use std::path::PathBuf;
use std::sync::Arc;

use crate::{Core, WorkspaceState};

/// 第一段（建 Core 之前，同步）：数据迁移 + 日常目录 + 恢复活动工作区，返回活动工作区状态。
/// 每一步失败都只留痕、不阻断启动（下次启动重试）。
pub fn prepare_workspace() -> WorkspaceState {
    // state.json 播种（legacy config.json → state.json）必须在读活动工作区之前。
    if let Err(e) = crate::app_settings::seed_state_from_legacy(
        &crate::paths::config_path(),
        &crate::paths::state_path(),
    ) {
        tracing::warn!("state.json seeding failed: {e}");
    }
    // 工作区显式注册表一次性迁移必须在恢复之前——恢复路径优先查注册表。
    if let Err(e) = crate::commands::workspace::ensure_registry_migrated() {
        tracing::warn!("workspace registry migration failed: {e}");
    }
    // 日常目录：建目录 + 幂等注册（**不激活**）。会话子进程要拿它当 cwd，目录必须真在。
    if let Err(e) = crate::commands::workspace::daily::ensure_daily_workspace() {
        tracing::warn!("daily workspace bootstrap failed: {e}");
    }
    let state = WorkspaceState::new();
    if let Some(key) = crate::commands::workspace::load_workspace_state() {
        // 注册表优先（真实 path 权威源）；解码回退兜注册表落地前的旧数据。
        let path = crate::commands::workspace::registered_path_for_key(
            &crate::app_settings::load_state(),
            &key,
        )
        .or_else(|| crate::commands::workspace::resolve_path_from_key(&key));
        if let Some(path) = path {
            *state.path.lock().unwrap() = Some(PathBuf::from(&path));
        }
        *state.key.lock().unwrap() = Some(key);
    }
    state
}

/// 第二段（Core 建好之后，须在 tokio runtime 上调用）：供应商 schema 迁移、拉起 agent
/// runtime、自动化调度、内置插件。耗时的都在后台，不阻塞调用方。
///
/// 前门若要给 runtime 挂 GUI 侧钩子（`runtime.set_hooks`），须在调用本函数之前挂好。
pub fn start(core: &Arc<Core>) {
    // 手机网关：上次是启用状态就接上中继（身份没有就生成）
    core.link.start(core);
    // 老 provider schema 迁移（幂等）——必须在 runtime 取 env 之前。
    if let Err(e) = crate::provider::ensure_migrated() {
        tracing::error!("provider schema migration failed: {e}（继续用旧配置）");
    }
    {
        let core = Arc::clone(core);
        tokio::spawn(async move {
            if let Err(e) = crate::runtime::start_with_active_provider(&core).await {
                tracing::error!("agent runtime failed to start: {e}");
            }
        });
    }
    core.automation.start(core);
    // 内置插件：确保已安装 / 版本更新（git 网络 IO，后台；用户卸载 / 禁用的不复活）。
    let settings = Arc::clone(&core.settings);
    tokio::task::spawn_blocking(move || {
        crate::commands::marketplace::bundled::ensure_bundled_plugins_installed(&settings);
    });
}
