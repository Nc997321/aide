//! RPC 包装器：每个 = 解析参数 DTO → 取 State → 调 commands 函数体 → 拍平结果。
//! 全部为两输入自由函数（app, params），非捕获闭包形态进 rpc::REGISTRY。
//! 参数 DTO 的字段名 = 前端 api 门面的 camelCase 键（#[serde(rename_all = "camelCase")]）。

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{parse, to_json, BoxFuture};
use crate::commands::WorkspaceState;
use crate::runtime::AgentRuntimeManager;
use crate::settings::SettingsService;

// ── 聊天控制 ──

/// send_message 参数 DTO（镜像前端 SendMessageParams）。
/// `jump_queue` 前端只发 true/缺省——缺省即 false，二态语义用 serde(default)
/// 封闭（None≡Some(false)，见 chat.rs 的 unwrap_or(false)），不留 Option<bool> 三态。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageArgs {
    session_id: String,
    prompt: String,
    workspace_root: Option<String>,
    images: Option<Vec<Value>>,
    provider: Option<String>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    initial_effort: Option<String>,
    permission_mode: Option<String>,
    #[serde(default)]
    jump_queue: bool,
}

pub fn send_message(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SendMessageArgs = parse(params)?;
        // 远程权限模式兜底：PWA 未随消息带 permissionMode 时读桌面「远程控制」设置
        // （保留旧 bridge 语义：远程会话默认受 remote.permission_mode 约束）。
        let permission_mode = match a.permission_mode {
            Some(m) => Some(m),
            None => Some(crate::remote::read_remote_settings(&app).await?.permission_mode),
        };
        let runtime = app.state::<AgentRuntimeManager>();
        let ws_state = app.state::<WorkspaceState>();
        let settings = app.state::<Arc<SettingsService>>();
        to_json(
            crate::commands::chat::send_message(
                a.session_id, a.prompt, a.images, a.resume_id, a.initial_model, a.initial_effort,
                permission_mode, Some(a.jump_queue), a.workspace_root, a.provider,
                runtime, ws_state, settings,
            )
            .await,
        )
    })
}

/// permission_response 参数 DTO。命令层的 `always: Option<bool>` 是历史死参数
/// （前端从不发送），DTO 不建模——serde 缺省 None。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionResponseArgs {
    session_id: String,
    id: String,
    approved: bool,
    answers: Option<std::collections::HashMap<String, String>>,
    next_mode: Option<String>,
    message: Option<String>,
    session_rules: Option<Vec<Value>>,
}

pub fn permission_response(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: PermissionResponseArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(
            crate::commands::chat::permission_response(
                a.session_id, a.id, a.approved, None, a.answers, a.next_mode, a.message, a.session_rules,
                runtime,
            )
            .await,
        )
    })
}

/// 单 sessionId 参数（聊天控制类命令共用形状）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArgs {
    session_id: String,
}

pub fn interrupt_session(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::interrupt_session(a.session_id, runtime).await)
    })
}

pub fn stop_chat_session(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::stop_chat_session(a.session_id, runtime).await)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetModelArgs {
    session_id: String,
    model: String,
}

pub fn set_model(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetModelArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::set_model(a.session_id, a.model, runtime).await)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetEffortArgs {
    session_id: String,
    effort: String,
}

pub fn set_effort(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetEffortArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::set_effort(a.session_id, a.effort, runtime).await)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPermissionModeArgs {
    session_id: String,
    mode: String,
}

pub fn set_permission_mode(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetPermissionModeArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::set_permission_mode(a.session_id, a.mode, runtime).await)
    })
}

/// start_btw_session 参数 DTO（镜像前端 StartBtwParams）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartBtwArgs {
    btw_id: String,
    fork_from: Option<String>,
    prompt: String,
    cwd: String,
    lightweight: bool,
    permission_mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    tools: Option<Vec<String>>,
    permission_policy: Option<Value>,
}

pub fn start_btw_session(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: StartBtwArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        let settings = app.state::<Arc<SettingsService>>();
        to_json(
            crate::commands::chat::start_btw_session(
                a.btw_id, a.fork_from, a.prompt, a.cwd, a.lightweight, a.permission_mode,
                a.model, a.effort, a.tools, a.permission_policy,
                runtime, settings,
            )
            .await,
        )
    })
}

// ── 会话管理与元数据 ──

pub fn list_sessions(app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let ws_state = app.state::<WorkspaceState>();
        to_json(crate::commands::session::list_sessions(ws_state).await)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsKeyArgs {
    ws_key: String,
}

pub fn list_sessions_for_workspace(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: WsKeyArgs = parse(params)?;
        to_json(crate::commands::session::list_sessions_for_workspace(a.ws_key).await)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionArgs {
    id: String,
    name: String,
}

pub fn create_session(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: CreateSessionArgs = parse(params)?;
        // 同步命令体：小文件 IO，relay 任务线程（非主线程）上直接调，等价语义。
        to_json(crate::commands::session::create_session(a.id, a.name))
    })
}

pub fn delete_session(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        let ws_state = app.state::<WorkspaceState>();
        to_json(crate::commands::session::delete_session(ws_state, a.id))
    })
}

/// 仅 id 字段（session 元数据类命令共用形状）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdOnlyArgs {
    id: String,
}

pub fn rename_session(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: CreateSessionArgs = parse(params)?;
        to_json(crate::commands::session::rename_session(a.id, a.name))
    })
}

pub fn auto_rename_session(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: CreateSessionArgs = parse(params)?;
        to_json(crate::commands::session::auto_rename_session(a.id, a.name).await)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadMessagesArgs {
    session_id: String,
    offset_bytes: Option<u64>,
    limit: Option<u32>,
}

pub fn load_messages(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: LoadMessagesArgs = parse(params)?;
        let ws_state = app.state::<WorkspaceState>();
        to_json(crate::commands::session::load_messages(ws_state, a.session_id, a.offset_bytes, a.limit).await)
    })
}

pub fn session_last_event(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdArgs = parse(params)?;
        let ws_state = app.state::<WorkspaceState>();
        to_json(crate::commands::session::session_last_event(ws_state, a.session_id).await)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSessionMetaArgs {
    id: String,
    /// model / effort / provider 共用值字段——按调用命令分别落到对应参数名。
    #[serde(rename = "model")]
    model: Option<String>,
    #[serde(rename = "effort")]
    effort: Option<String>,
    #[serde(rename = "provider")]
    provider: Option<String>,
}

// 元数据三件套各自独立包装（值字段互斥，由调用命令决定取哪个）——
// 比一个「万能 meta 包装」更直白，serde 漏传直接报错。

pub fn set_session_model(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetSessionMetaArgs = parse(params)?;
        let model = a.model.ok_or("缺少 model 字段")?;
        to_json(crate::commands::session::set_session_model(a.id, model).await)
    })
}

pub fn session_model(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        to_json(crate::commands::session::session_model(a.id).await)
    })
}

pub fn set_session_effort(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetSessionMetaArgs = parse(params)?;
        let effort = a.effort.ok_or("缺少 effort 字段")?;
        to_json(crate::commands::session::set_session_effort(a.id, effort).await)
    })
}

pub fn session_effort(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        to_json(crate::commands::session::session_effort(a.id).await)
    })
}

pub fn set_session_provider(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetSessionMetaArgs = parse(params)?;
        let provider = a.provider.ok_or("缺少 provider 字段")?;
        to_json(crate::commands::session::set_session_provider(a.id, provider).await)
    })
}

pub fn session_provider(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        to_json(crate::commands::session::session_provider(a.id).await)
    })
}

// ── 工作区与信任 ──

pub fn list_workspaces(_app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(crate::commands::workspace::list_workspaces().await) })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
}

pub fn is_workspace_trusted(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: PathArgs = parse(params)?;
        to_json(crate::commands::workspace::is_workspace_trusted(a.path).await)
    })
}

pub fn trust_workspace(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: PathArgs = parse(params)?;
        let settings = app.state::<Arc<SettingsService>>();
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::workspace::trust_workspace(a.path, settings, runtime).await)
    })
}

pub fn untrust_workspace(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: PathArgs = parse(params)?;
        let settings = app.state::<Arc<SettingsService>>();
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::workspace::untrust_workspace(a.path, settings, runtime).await)
    })
}

// ── 设置与供应商 ──

pub fn get_settings(app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let service = app.state::<Arc<SettingsService>>();
        to_json(crate::commands::settings::get_settings(service).await)
    })
}

pub fn set_settings(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            settings: Value,
        }
        let a: Args = parse(params)?;
        let service = app.state::<Arc<SettingsService>>();
        to_json(crate::commands::settings::set_settings(a.settings, service).await)
    })
}

pub fn get_providers(app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let service = app.state::<Arc<SettingsService>>();
        to_json(crate::commands::provider::get_providers(service).await)
    })
}

pub fn set_providers(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            providers: Vec<crate::runtime::provider::ProviderConfigInput>,
        }
        let a: Args = parse(params)?;
        let service = app.state::<Arc<SettingsService>>();
        to_json(crate::commands::provider::set_providers(a.providers, service).await)
    })
}

pub fn get_active_provider_id(app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let service = app.state::<Arc<SettingsService>>();
        to_json(crate::commands::provider::get_active_provider_id(service).await)
    })
}

pub fn set_active_provider_id(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            provider_id: String,
        }
        let a: Args = parse(params)?;
        let service = app.state::<Arc<SettingsService>>();
        to_json(crate::commands::provider::set_active_provider_id(a.provider_id, service).await)
    })
}

pub fn get_provider_catalog(_app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(crate::commands::provider::get_provider_catalog()) })
}

pub fn refresh_models(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            provider_id: String,
        }
        let a: Args = parse(params)?;
        let service = app.state::<Arc<SettingsService>>();
        to_json(crate::commands::provider::refresh_models(a.provider_id, service).await)
    })
}

pub fn claude_credentials_exist(_app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(Ok(crate::commands::onboarding::claude_credentials_exist())) })
}

// ── 通知中心持久化 ──

pub fn load_notifications(_app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(crate::commands::notifications::load_notifications().await) })
}

pub fn save_notifications(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            records: Vec<crate::commands::notifications::NotificationRecord>,
        }
        let a: Args = parse(params)?;
        to_json(crate::commands::notifications::save_notifications(a.records).await)
    })
}

// ── CodeGraph ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRootArgs {
    project_root: String,
}

pub fn codegraph_build_index(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            project_root: String,
            // 缺省即 false（命令层 unwrap_or(false)），二态语义 serde(default) 封闭
            #[serde(default)]
            force: bool,
        }
        let a: Args = parse(params)?;
        let state = app.state::<Arc<crate::codegraph::CodeGraphService>>();
        let settings = app.state::<Arc<SettingsService>>();
        to_json(crate::codegraph::commands::codegraph_build_index(a.project_root, Some(a.force), state, settings).await)
    })
}

pub fn codegraph_build_progress(app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let state = app.state::<Arc<crate::codegraph::CodeGraphService>>();
        // 该命令本就返回 Value（非 Result），直通
        Ok(crate::codegraph::commands::codegraph_build_progress(state))
    })
}

pub fn codegraph_close(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: ProjectRootArgs = parse(params)?;
        let state = app.state::<Arc<crate::codegraph::CodeGraphService>>();
        to_json(crate::codegraph::commands::codegraph_close(a.project_root, state).await)
    })
}

pub fn codegraph_reindex_file(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            project_root: String,
            file: String,
        }
        let a: Args = parse(params)?;
        let state = app.state::<Arc<crate::codegraph::CodeGraphService>>();
        let settings = app.state::<Arc<SettingsService>>();
        to_json(crate::codegraph::commands::codegraph_reindex_file(a.project_root, a.file, state, settings).await)
    })
}

pub fn codegraph_rescan(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: ProjectRootArgs = parse(params)?;
        let state = app.state::<Arc<crate::codegraph::CodeGraphService>>();
        let settings = app.state::<Arc<SettingsService>>();
        to_json(crate::codegraph::commands::codegraph_rescan(a.project_root, state, settings).await)
    })
}

// ── 默认值目录 ──

pub fn get_default_models(app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(crate::commands::chat::get_default_models(app.clone())) })
}

pub fn get_default_permission_modes(app: AppHandle, _params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(crate::commands::chat::get_default_permission_modes(app.clone())) })
}
