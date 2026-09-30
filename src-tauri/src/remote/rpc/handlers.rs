//! RPC 包装器：每个 = 解析参数 DTO → 取 State → 调 commands 函数体 → 拍平结果。
//! 全部为两输入自由函数（app, params），非捕获闭包形态进 rpc::REGISTRY。
//! 参数 DTO 的字段名 = 前端 api 门面的 camelCase 键（#[serde(rename_all = "camelCase")]）。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{parse, to_json, BoxFuture};
use crate::commands::WorkspaceState;

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
// 远程入参契约：按 DTO 校验形状（缺必填字段 = 拒绝），值原样交给 Host 命令表——
// 只有 permission_mode 在这里读。
#[allow(dead_code)]
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
        // 先按 DTO 校验形状（远程入参的契约），再把预处理后的 permissionMode 写回原参数交给
        // Host 命令表——与桌面同一个 send_message。
        let a: SendMessageArgs = parse(params.clone())?;
        // 远程权限模式兜底：PWA 未随消息带 permissionMode 时读桌面「远程控制」设置
        // （保留旧 bridge 语义：远程会话默认受 remote.permission_mode 约束）。
        // 两路都过一遍 normalize：`default` 已更名为 `manual`，老 PWA 客户端与旧
        // 存盘配置仍可能带旧 id，归一化后再下发，避免 sidecar 收到清单外的模式。
        let permission_mode = normalize_permission_mode(match a.permission_mode {
            Some(m) => m,
            None => crate::remote::read_remote_settings(&app).await?.permission_mode,
        });
        let mut params = params;
        if !params.is_object() {
            params = Value::Object(Default::default());
        }
        params["permissionMode"] = Value::String(permission_mode);
        super::call_core(app, "send_message".into(), params).await
    })
}

// ── 工作区 ──

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
        let ws_state = app.state::<std::sync::Arc<WorkspaceState>>();
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

// ── 自动化任务（ohos 端自动化五屏；与桌面 UI 同一命令实现，参数形状对齐
//    packages/aide-sdk/src/api/automation.ts——`{id}` / `{input}` / `{id, input}` /
//    `{id, enabled}` / `{id, limit?}`，嵌套 AutomationTaskInput 自带 camelCase）──

/// 仅 id 字段（自动化元数据/动作类命令共用形状）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationIdArgs {
    id: String,
}

/// create 入参：input 单字段包装（任务 DTO 整体下发）。
#[derive(Deserialize)]
struct CreateAutomationArgs {
    input: crate::automation::AutomationTaskInput,
}

/// update 入参：定位 id + 替换体。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAutomationArgs {
    id: String,
    input: crate::automation::AutomationTaskInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAutomationEnabledArgs {
    id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListAutomationRunsArgs {
    id: String,
    limit: Option<u32>,
}

pub fn list_automations(
    app: AppHandle,
    _params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::list_automations(svc))
    })
}

pub fn get_automation(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: AutomationIdArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::get_automation(svc, a.id))
    })
}

pub fn create_automation(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: CreateAutomationArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::create_automation(svc, a.input).await)
    })
}

pub fn update_automation(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: UpdateAutomationArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::update_automation(svc, a.id, a.input).await)
    })
}

pub fn delete_automation(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: AutomationIdArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::delete_automation(svc, a.id).await)
    })
}

pub fn set_automation_enabled(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: SetAutomationEnabledArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(
            crate::automation::commands::set_automation_enabled(svc, a.id, a.enabled).await,
        )
    })
}

pub fn list_automation_runs(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: ListAutomationRunsArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::list_automation_runs(svc, a.id, a.limit).await)
    })
}

pub fn automation_run_stats(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: AutomationIdArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::automation_run_stats(svc, a.id).await)
    })
}

pub fn run_automation_now(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: AutomationIdArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::run_automation_now(svc, a.id).await)
    })
}

pub fn get_automation_playbook(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: AutomationIdArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::get_automation_playbook(svc, a.id).await)
    })
}

pub fn redistill_automation(
    app: AppHandle,
    params: Value,
) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: AutomationIdArgs = parse(params)?;
        let svc = app.state::<Arc<crate::automation::scheduler::AutomationService>>();
        to_json(crate::automation::commands::redistill_automation(svc, a.id).await)
    })
}
