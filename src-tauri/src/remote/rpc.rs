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

/// 白名单目录——读这张表即可审计远程暴露面（每行：命令名 → 包装器）。
static REGISTRY: &[(&str, Handler)] = &[
    // ── 聊天控制（闭包直调路径）──
    ("send_message", handlers::send_message),
    ("permission_response", handlers::permission_response),
    ("interrupt_session", handlers::interrupt_session),
    ("stop_chat_session", handlers::stop_chat_session),
    ("set_model", handlers::set_model),
    ("set_effort", handlers::set_effort),
    ("set_permission_mode", handlers::set_permission_mode),
    ("start_btw_session", handlers::start_btw_session),
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
    ("set_session_model", handlers::set_session_model),
    ("session_effort", handlers::session_effort),
    ("set_session_effort", handlers::set_session_effort),
    ("session_provider", handlers::session_provider),
    ("set_session_provider", handlers::set_session_provider),
    // ── 工作区与信任 ──
    ("list_workspaces", handlers::list_workspaces),
    ("is_workspace_trusted", handlers::is_workspace_trusted),
    ("trust_workspace", handlers::trust_workspace),
    ("untrust_workspace", handlers::untrust_workspace),
    // ── 设置与供应商 ──
    ("get_settings", handlers::get_settings),
    ("set_settings", handlers::set_settings),
    ("get_providers", handlers::get_providers),
    ("set_providers", handlers::set_providers),
    ("get_active_provider_id", handlers::get_active_provider_id),
    ("set_active_provider_id", handlers::set_active_provider_id),
    ("get_provider_catalog", handlers::get_provider_catalog),
    ("refresh_models", handlers::refresh_models),
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
];
