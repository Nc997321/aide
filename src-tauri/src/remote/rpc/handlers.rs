//! RPC 包装器：每个 = 解析参数 DTO → 取 State → 调 commands 函数体 → 拍平结果。
//! 全部为两输入自由函数（app, params），非捕获闭包形态进 rpc::REGISTRY。
//! 参数 DTO 的字段名 = 前端 api 门面的 camelCase 键（#[serde(rename_all = "camelCase")]）。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{parse, to_json, BoxFuture};
use crate::commands::session::MetaField;
use crate::commands::WorkspaceState;
use crate::runtime::AgentRuntimeManager;
use crate::settings::SettingsService;

// ── 聊天控制 ──

/// 权限模式 id 迁移：`default` 已更名为 `manual`（对齐 CLI 的 --permission-mode
/// choices，两者 CLI 都接受，aide 统一用 `manual`）。远程侧的两个来源——老 PWA
/// 客户端随消息带的旧 id、桌面设置里存的旧值——都要归一化，否则 sidecar 会收到
/// 一个模式清单里已不存在的 id。
fn normalize_permission_mode(mode: String) -> String {
    if mode == "default" {
        "manual".to_string()
    } else {
        mode
    }
}

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
    /// 发起方附带的渲染描述（@引用卡片/动作胶囊），原样透传给 sidecar 回灌。
    /// 鸿蒙 v1 不发送此字段 → 桌面端降级为纯文本气泡。
    display: Option<Value>,
    provider: Option<String>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    initial_effort: Option<String>,
    permission_mode: Option<String>,
    #[serde(default)]
    jump_queue: bool,
    /// @目录 授权：客户端已知的附加目录全量。远程与桌面走**同一个** send_message，
    /// 所以这里的裁定口径完全一致（未注册工作区照样被拒，见 workspace/attach.rs）。
    #[serde(default)]
    additional_dirs: Option<Vec<String>>,
}

pub fn send_message(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SendMessageArgs = parse(params)?;
        // 远程权限模式兜底：PWA 未随消息带 permissionMode 时读桌面「远程控制」设置
        // （保留旧 bridge 语义：远程会话默认受 remote.permission_mode 约束）。
        // 两路都过一遍 normalize：`default` 已更名为 `manual`，老 PWA 客户端与旧
        // 存盘配置仍可能带旧 id，归一化后再下发，避免 sidecar 收到清单外的模式。
        let permission_mode = Some(normalize_permission_mode(match a.permission_mode {
            Some(m) => m,
            None => {
                crate::remote::read_remote_settings(&app)
                    .await?
                    .permission_mode
            }
        }));
        let runtime = app.state::<AgentRuntimeManager>();
        let ws_state = app.state::<WorkspaceState>();
        let settings = app.state::<Arc<SettingsService>>();
        to_json(
            crate::commands::chat::send_message(
                a.session_id,
                a.prompt,
                a.images,
                a.display,
                a.resume_id,
                a.initial_model,
                a.initial_effort,
                permission_mode,
                Some(a.jump_queue),
                a.workspace_root,
                a.additional_dirs,
                a.provider,
                runtime,
                ws_state,
                settings,
                // 远程路径同样下发 LSP 语言：工具挂载与否决定手机端会话里
                // agent 能不能用语义查询（LspManager 始终跑在桌面）。
                app.clone(),
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

pub fn permission_response(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: PermissionResponseArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(
            crate::commands::chat::permission_response(
                a.session_id,
                a.id,
                a.approved,
                None,
                a.answers,
                a.next_mode,
                a.message,
                a.session_rules,
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

pub fn interrupt_session(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::interrupt_session(a.session_id, runtime).await)
    })
}

pub fn stop_chat_session(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::stop_chat_session(a.session_id, runtime).await)
    })
}

/// stop_bg_task 参数 DTO（镜像前端 api.stopBgTask）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopBgTaskArgs {
    session_id: String,
    task_id: String,
}

pub fn stop_bg_task(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: StopBgTaskArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::stop_bg_task(a.session_id, a.task_id, runtime).await)
    })
}

/// 后台任务快照：远程客户端打开会话/重连后对账 bgTasks（bg_task_* 事件流
/// 只做实时转发无重放，离线期间错过的任务靠这里回填）。
pub fn list_bg_tasks(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdArgs = parse(params)?;
        let reg = app.state::<std::sync::Arc<crate::runtime::bg_registry::BgTaskRegistry>>();
        to_json(Ok(reg.list(&a.session_id)))
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

pub fn set_permission_mode(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetPermissionModeArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::set_permission_mode(a.session_id, a.mode, runtime).await)
    })
}

/// btw_ask 参数 DTO（镜像前端 api.btwAsk）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BtwAskArgs {
    session_id: String,
    question: String,
    #[serde(default)]
    history: Option<Vec<Value>>,
}

pub fn btw_ask(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: BtwAskArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::btw_ask(a.session_id, a.question, a.history, runtime).await)
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

pub fn list_sessions_for_workspace(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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
        // 与桌面同一实现（内部 spawn_blocking 落盘），这里 await 即可。
        to_json(crate::commands::session::create_session(a.id, a.name).await)
    })
}

pub fn delete_session(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        to_json(crate::commands::session::delete_session(a.id).await)
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
        to_json(crate::commands::session::rename_session(a.id, a.name).await)
    })
}

pub fn auto_rename_session(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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
        to_json(
            crate::commands::session::load_messages(
                ws_state,
                a.session_id,
                a.offset_bytes,
                a.limit,
            )
            .await,
        )
    })
}

pub fn session_last_event(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdArgs = parse(params)?;
        let ws_state = app.state::<WorkspaceState>();
        to_json(crate::commands::session::session_last_event(ws_state, a.session_id).await)
    })
}

/// 会话元数据写入的**唯一**远程入口。
///
/// 三个字段都是 `MetaField` 三态（keep / clear / set），缺省 keep——远程端（OHO）
/// 只写其中一个字段时其余原样保留。取代此前的 set_session_model / set_session_effort /
/// set_session_provider 三个单字段命令：它们各写一遍 `<id>.json`，并发时互相覆盖。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSessionMetaArgs {
    id: String,
    #[serde(default)]
    provider: MetaField,
    #[serde(default)]
    model: MetaField,
    #[serde(default)]
    effort: MetaField,
}

pub fn set_session_meta(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetSessionMetaArgs = parse(params)?;
        to_json(
            crate::commands::session::set_session_meta(a.id, a.provider, a.model, a.effort).await,
        )
    })
}

pub fn session_workspace(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        to_json(crate::commands::session::session_workspace(a.id).await)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSessionWorkspaceArgs {
    id: String,
    /// 缺省 = keep（两字段都缺 = 什么都不改）。
    #[serde(default)]
    ws_path: MetaField,
    #[serde(default)]
    ws_key: MetaField,
}

pub fn set_session_workspace(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetSessionWorkspaceArgs = parse(params)?;
        to_json(
            crate::commands::session::set_session_workspace(a.id, a.ws_path, a.ws_key).await,
        )
    })
}

pub fn session_model(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        to_json(crate::commands::session::session_model(a.id).await)
    })
}

pub fn session_effort(_app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        to_json(crate::commands::session::session_effort(a.id).await)
    })
}

pub fn session_provider(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        to_json(crate::commands::session::session_provider(a.id).await)
    })
}

/// 发送前身份漂移判定（远程端复用桌面同一份规则，详见命令侧文档）。
pub fn session_identity_drift(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            id: String,
            provider_id: String,
            model: String,
        }
        let a: Args = parse(params)?;
        to_json(
            crate::commands::session::session_identity_drift(a.id, a.provider_id, a.model).await,
        )
    })
}

/// 会话进程是否存活（远程端决定模型下拉口径的依据，详见命令侧文档）。
pub fn session_alive(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SessionIdOnlyArgs = parse(params)?;
        let runtime = app.state::<crate::runtime::AgentRuntimeManager>();
        to_json(crate::commands::session::session_alive(a.id, runtime))
    })
}

// ── 工作区与信任 ──

/// 活动工作区快照：key 与 list_workspaces 的 key 同源（编码键），path 为解码
/// 路径；未设置工作区（key/path 任一为 None）序列化为 null，手机端退占位名。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveWorkspace {
    key: String,
    path: String,
}

/// 查询桌面当前活动工作区（远程展示用：手机端「跟随桌面」槽位解析真名）。
/// 纯状态读取，无 IO；与 set_workspace（桌面内部命令，未白名单）相对——远程
/// 只读不写，活动工作区仍由桌面独占管理。
pub fn get_active_workspace(
    app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let ws_state = app.state::<WorkspaceState>();
        let key = ws_state.key.lock().map_err(|e| e.to_string())?.clone();
        let path = ws_state.path.lock().map_err(|e| e.to_string())?.clone();
        match (key, path) {
            (Some(k), Some(p)) => to_json(Ok(Some(ActiveWorkspace {
                key: k,
                path: p.to_string_lossy().to_string(),
            }))),
            _ => to_json(Ok(None::<ActiveWorkspace>)),
        }
    })
}

pub fn list_workspaces(
    _app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(crate::commands::workspace::list_workspaces().await) })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
}

pub fn is_workspace_trusted(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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

pub fn untrust_workspace(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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

pub fn get_active_provider_id(
    app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let service = app.state::<Arc<SettingsService>>();
        to_json(crate::commands::provider::get_active_provider_id(service).await)
    })
}

pub fn set_active_provider_id(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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

pub fn get_provider_catalog(
    _app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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

pub fn claude_credentials_exist(
    _app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(Ok(crate::commands::onboarding::claude_credentials_exist())) })
}

// ── 通知中心持久化 ──

pub fn load_notifications(
    _app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(crate::commands::notifications::load_notifications().await) })
}

pub fn save_notifications(
    _app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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

pub fn codegraph_build_index(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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
        to_json(
            crate::codegraph::commands::codegraph_build_index(
                a.project_root,
                Some(a.force),
                state,
                settings,
            )
            .await,
        )
    })
}

pub fn codegraph_build_progress(
    app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
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

pub fn codegraph_reindex_file(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            project_root: String,
            file: String,
        }
        let a: Args = parse(params)?;
        let state = app.state::<Arc<crate::codegraph::CodeGraphService>>();
        to_json(
            crate::codegraph::commands::codegraph_reindex_file(a.project_root, a.file, state).await,
        )
    })
}

pub fn codegraph_rescan(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: ProjectRootArgs = parse(params)?;
        let state = app.state::<Arc<crate::codegraph::CodeGraphService>>();
        to_json(crate::codegraph::commands::codegraph_rescan(a.project_root, state).await)
    })
}

// ── 默认值目录 ──

pub fn get_default_models(
    _app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move { to_json(crate::commands::chat::get_default_models()) })
}

pub fn get_default_permission_modes(
    app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        to_json(crate::commands::chat::get_default_permission_modes(
            app.clone(),
        ))
    })
}
