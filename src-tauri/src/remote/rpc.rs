//! 远程 RPC 注册表：命令名 → 包装器（注册表即白名单，即远程暴露面）。
//!
//! 目录在 [`lookup`] 的表；每个包装器只做三件事：解析参数 DTO → 取 State →
//! 调现有 commands 函数体（与 Tauri 命令同一实现，能力零漂移）。结果统一
//! 序列化为 JSON 经 relay_client 回包。
//!
//! 收录原则：共享 chat 闭包（@aide/sdk）被动调用 + PWA UI 必需的命令。
//! 桌面 UI 专属动作（customizations CRUD、打开方式注册等）不收录——
//! PWA 没有那些 UI；以后要加 = 这里加一行 + handlers 加一个包装。

use std::future::Future;
use std::pin::Pin;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tauri::AppHandle;

pub mod handlers;

/// `AppHandle` owned + 参数 JSON → 结果 JSON。handlers 是非捕获闭包/自由函数，
/// 可退化为 fn 指针进静态表。
pub type Handler = fn(AppHandle, Value) -> BoxFuture<'static, Result<Value, String>>;
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 参数 DTO 反序列化：失败即拒绝（消息给人读——经 invoke_result 回到 PWA 控制台）。
pub fn parse<T: DeserializeOwned>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("参数解析失败: {e}"))
}

/// 命令结果拍平为 JSON（Result<(), _> → null；Option<T> → null|value）。
pub fn to_json<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|v| serde_json::to_value(v).map_err(|e| format!("结果序列化失败: {e}")))
}

/// 查命令：Some = 白名单内（返回处理器），None = 拒绝。
pub fn lookup(command: &str) -> Option<Handler> {
    REGISTRY
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, h)| *h)
}

/// 执行一条远程命令：先查手写包装表，再查「已迁入 aide-core 的白名单」——后者直接走
/// Host 命令表（与桌面同一实现、零包装）。None = 不在白名单，拒绝。
pub fn dispatch(app: AppHandle, command: &str, params: Value) -> Option<BoxFuture<'static, Result<Value, String>>> {
    if let Some(h) = lookup(command) {
        return Some(h(app, params));
    }
    if !CORE_EXPOSED.contains(&command) {
        return None;
    }
    let run = aide_core::lookup(command)?;
    Some(Box::pin(async move {
        use tauri::Manager;
        let core = app
            .try_state::<std::sync::Arc<aide_core::Core>>()
            .ok_or("host core not initialised")?
            .inner()
            .clone();
        match run(core, params).await? {
            aide_core::Reply::Json(v) => Ok(v),
            aide_core::Reply::Bytes(_) => Err("远程通道不支持二进制结果".to_string()),
        }
    }))
}

/// 已迁入 aide-core 的远程可用命令（**只登记名字**：白名单仍是这里，实现是 core 命令表）。
/// 收录原则同 [`REGISTRY`]。命令迁入 core 后，把它从 REGISTRY 挪到这里并删掉手写包装。
static CORE_EXPOSED: &[&str] = &[
    // ── 设置与供应商 ──
    "get_settings",
    "set_settings",
    "get_providers",
    "set_providers",
    "get_active_provider_id",
    "set_active_provider_id",
    "get_provider_catalog",
    "refresh_models",
];

/// 白名单目录——读这张表即可审计远程暴露面（每行：命令名 → 包装器）。
static REGISTRY: &[(&str, Handler)] = &[
    // ── 聊天控制（闭包直调路径）──
    ("send_message", handlers::send_message),
    ("permission_response", handlers::permission_response),
    ("interrupt_session", handlers::interrupt_session),
    ("stop_chat_session", handlers::stop_chat_session),
    ("stop_bg_task", handlers::stop_bg_task),
    // 已知缺口：PWA 经本条目能发起 set_model，但无成本确认弹窗 UI、REGISTRY 也无
    // model_switch_confirm_decision 回传通道——热缓存+大上下文切换时 PreModelSwitch
    // 挂起 10s 超时按 deny 收尾（与桌面 2026-09-11 补转发层前的失效模式同形）。
    // PWA 补弹窗时须连同决策命令一起收录本表。
    ("set_model", handlers::set_model),
    ("set_effort", handlers::set_effort),
    ("set_permission_mode", handlers::set_permission_mode),
    ("btw_ask", handlers::btw_ask),
    // ── 后台任务快照（远程对账：打开会话/重连时回填 bgTasks）──
    ("list_bg_tasks", handlers::list_bg_tasks),
    // ── 会话管理与元数据 ──
    ("list_sessions", handlers::list_sessions),
    (
        "list_sessions_for_workspace",
        handlers::list_sessions_for_workspace,
    ),
    ("create_session", handlers::create_session),
    ("delete_session", handlers::delete_session),
    ("rename_session", handlers::rename_session),
    ("auto_rename_session", handlers::auto_rename_session),
    ("load_messages", handlers::load_messages),
    ("session_last_event", handlers::session_last_event),
    ("session_model", handlers::session_model),
    ("session_effort", handlers::session_effort),
    ("session_provider", handlers::session_provider),
    // 工作区归属：共享闭包（useChatSession 的 ensureWorkspaceKnown /
    // persistWorkspaceIfDirty）被动调用，PWA 与鸿蒙都走它——按收录原则必须登记。
    ("session_workspace", handlers::session_workspace),
    ("set_session_workspace", handlers::set_session_workspace),
    ("session_alive", handlers::session_alive),
    ("session_identity_drift", handlers::session_identity_drift),
    ("set_session_meta", handlers::set_session_meta),
    // ── 工作区与信任 ──
    ("get_active_workspace", handlers::get_active_workspace),
    ("list_workspaces", handlers::list_workspaces),
    // 日常模式归属：工作区列表把它滤掉了（list_workspaces 服务端 retain），
    // 远程端要进「日常」只能单独问这条。只读身份（key + path），不激活、不改
    // 状态——配对设备与桌面同信任层，收录判据不缺（见 handlers 同名包装器）。
    ("daily_workspace", handlers::daily_workspace),
    ("is_workspace_trusted", handlers::is_workspace_trusted),
    ("trust_workspace", handlers::trust_workspace),
    ("untrust_workspace", handlers::untrust_workspace),
    (
        "claude_credentials_exist",
        handlers::claude_credentials_exist,
    ),
    // ── 通知中心持久化 ──
    ("load_notifications", handlers::load_notifications),
    ("save_notifications", handlers::save_notifications),
    // ── CodeGraph（闭包内 useCodeGraphProgress 被动调用链）──
    ("codegraph_build_index", handlers::codegraph_build_index),
    (
        "codegraph_build_progress",
        handlers::codegraph_build_progress,
    ),
    ("codegraph_close", handlers::codegraph_close),
    ("codegraph_reindex_file", handlers::codegraph_reindex_file),
    ("codegraph_rescan", handlers::codegraph_rescan),
    // ── 模型/权限模式默认值 ──
    ("get_default_models", handlers::get_default_models),
    (
        "get_default_permission_modes",
        handlers::get_default_permission_modes,
    ),
    // ── 自动化任务（ohos 端自动化五屏：列表/详情/表单/运行转录/手册。
    // 与桌面 UI 同一命令实现，能力零漂移；CRUD 与立即运行均经此处开放给
    // 已配对远程端——配对/信任边界与聊天控制命令同层）──
    ("list_automations", handlers::list_automations),
    ("get_automation", handlers::get_automation),
    ("create_automation", handlers::create_automation),
    ("update_automation", handlers::update_automation),
    ("delete_automation", handlers::delete_automation),
    (
        "set_automation_enabled",
        handlers::set_automation_enabled,
    ),
    ("list_automation_runs", handlers::list_automation_runs),
    ("automation_run_stats", handlers::automation_run_stats),
    ("run_automation_now", handlers::run_automation_now),
    (
        "get_automation_playbook",
        handlers::get_automation_playbook,
    ),
    ("redistill_automation", handlers::redistill_automation),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单是安全边界也是功能清单：这行被"清理"掉 = 远程端当场失去日常入口，
    /// 而编译、其余命令都不受影响（静默回归）。钉住本次收录意图。
    #[test]
    fn registry_exposes_daily_workspace() {
        assert!(lookup("daily_workspace").is_some());
    }

    /// 白名单登记的 core 命令必须真的在 core 表里（否则远程端调用即「未知命令」）。
    #[test]
    fn core_exposed_commands_exist_in_core() {
        for name in CORE_EXPOSED {
            assert!(aide_core::lookup(name).is_some(), "{name} not in aide-core");
            assert!(lookup(name).is_none(), "{name} registered twice");
        }
    }
}
