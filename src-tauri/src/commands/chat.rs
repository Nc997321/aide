use crate::commands::settings::get_settings;
use crate::commands::{project_root_for_commands, WorkspaceState};
use crate::runtime::env::build_runtime_env_vars;
use crate::runtime::AgentRuntimeManager;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::State;

async fn resolve_active_provider(
    service: std::sync::Arc<crate::settings::SettingsService>,
) -> Result<crate::runtime::provider::ProviderConfig, String> {
    tokio::task::spawn_blocking(move || {
        service
            .resolve_active_runtime_provider()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn resolve_provider_by_id(
    service: &std::sync::Arc<crate::settings::SettingsService>,
    id: &str,
) -> Result<crate::runtime::provider::ProviderConfig, String> {
    let service = service.clone();
    let id = id.to_string();
    tokio::task::spawn_blocking(move || {
        service
            .resolve_runtime_provider(&id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 解析本次发送的 provider（三层，逐级回落）：
///  1. 前端透传的会话身份（stampProvider/restoreBinding 解析出的绑定，最权威）；
///  2. 会话元数据 `<sid>.json` 的 provider 字段（前端无绑定的历史会话兜底）；
///  3. 全局 active provider（新会话/两者皆无）。
/// 显式 id 在 provider 列表里不存在（被删除）→ 回落全局 active——与前端
/// sessionProvider 计算属性同一语义（供应商没了就用全局），不会硬失败。
async fn resolve_send_provider(
    service: std::sync::Arc<crate::settings::SettingsService>,
    session_id: &str,
    explicit_provider: Option<String>,
) -> Result<crate::runtime::provider::ProviderConfig, String> {
    let sid = session_id.to_string();
    let metadata_provider =
        tokio::task::spawn_blocking(move || crate::commands::our_session_provider_field(&sid))
            .await
            .map_err(|error| error.to_string())?;
    let preferred = explicit_provider.or(metadata_provider);
    let Some(id) = preferred.filter(|s| !s.is_empty()) else {
        return resolve_active_provider(service).await;
    };
    match resolve_provider_by_id(&service, &id).await {
        Ok(p) => Ok(p),
        Err(_) => resolve_active_provider(service).await,
    }
}

/// send 命令的可选行为（全部带 Default，调用点 `..Default::default()` 起步）。
///
/// 具名字段解决裸 bool 调用点（`false, true, true`）不可读问题；`jump_queue` 用
/// `bool`（原 `Option<bool>` 的 None 与 Some(false) 行为相同，三角态是假的）。
#[derive(Default)]
struct SendOptions<'a> {
    images: Option<&'a [serde_json::Value]>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    initial_effort: Option<String>,
    permission_mode: Option<String>,
    jump_queue: bool,
    provider_switched: bool,
    auto_title: bool,
    thinking_enabled: bool,
}

/// 构造 `send` 命令的 JSON（纯函数，可单测）。骨架目录：必填字段 + 逐项附件，
/// 每个附件一个子函数（attach_*），零分支，读者可一眼读出"由哪几层组成"。
///
/// 关键：resume_id 进 `resume_session_id` 独立字段，**不覆盖 `session_id`**（路由键）。
/// SessionManager 按 session_id 路由到/建 worker；SessionWorker 在首条 send（无活 query）
/// 时把 resume_session_id 赋给 resumeSource，startLoop 的 forkResumeOptions 据此 resume。
/// 旧行为（resume_id 覆盖 session_id）会让路由键换成真 ID 但 resumeSource 仍空 → 不 resume。
fn build_send_command(
    session_id: &str,
    prompt: &str,
    cwd: &str,
    env_vars: &HashMap<String, String>,
    opts: SendOptions<'_>,
) -> serde_json::Value {
    let mut cmd = base_send_command(session_id, prompt, cwd, env_vars, &opts);
    attach_images(&mut cmd, opts.images);
    attach_resume(&mut cmd, opts.resume_id);
    attach_env_override(&mut cmd, "ANTHROPIC_MODEL", opts.initial_model);
    attach_env_override(&mut cmd, "CLAUDE_CODE_EFFORT_LEVEL", opts.initial_effort);
    attach_permission_mode(&mut cmd, opts.permission_mode);
    attach_flag(&mut cmd, "jump_queue", opts.jump_queue);
    attach_flag(&mut cmd, "provider_switched", opts.provider_switched);
    cmd
}

/// 必填骨架。env 恒存在（`attach_env_override` 依赖此不变式，不做 get_mut 兜底）。
fn base_send_command(
    session_id: &str,
    prompt: &str,
    cwd: &str,
    env_vars: &HashMap<String, String>,
    opts: &SendOptions<'_>,
) -> serde_json::Value {
    json!({
        "cmd": "send",
        "session_id": session_id,
        "prompt": prompt,
        "cwd": cwd,
        "env": env_vars,
        "auto_title": opts.auto_title,
        "thinking_enabled": opts.thinking_enabled,
    })
}

/// images 非空才落（None 与空数组均不落字段）。
fn attach_images(cmd: &mut serde_json::Value, images: Option<&[serde_json::Value]>) {
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            cmd["images"] = json!(imgs);
        }
    }
}

/// resume_id 走独立字段（不动 session_id 路由键）。
fn attach_resume(cmd: &mut serde_json::Value, resume_id: Option<String>) {
    if let Some(rid) = resume_id {
        cmd["resume_session_id"] = json!(rid);
    }
}

/// 非空字符串走 env 覆盖（model / effort 同形）。None 与空串不注入（保留
/// provider env 原值）。env 恒存在（base 不变式），直接索引不兜底。
/// effort 注：CLAUDE_CODE_EFFORT_LEVEL 不在 connection_fingerprint 白名单里，
/// 不会触发 provider_switched 重启；也不会被 sidecar 透传成 CLI 的 env
/// （worker 显式删除，effort 只走 options.effort + applyFlagSettings）。
fn attach_env_override(cmd: &mut serde_json::Value, key: &str, value: Option<String>) {
    if let Some(v) = value {
        if !v.is_empty() {
            cmd["env"][key] = json!(v);
        }
    }
}

/// 非空 mode 才落 permission_mode 字段。
fn attach_permission_mode(cmd: &mut serde_json::Value, mode: Option<String>) {
    if let Some(m) = mode {
        if !m.is_empty() {
            cmd["permission_mode"] = json!(m);
        }
    }
}

/// 条件布尔：true 才落字段（false/缺省不写，与原 Option<bool> 的 None 行为一致）。
fn attach_flag(cmd: &mut serde_json::Value, key: &str, on: bool) {
    if on {
        cmd[key] = json!(true);
    }
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    prompt: String,
    images: Option<Vec<serde_json::Value>>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    initial_effort: Option<String>,
    permission_mode: Option<String>,
    jump_queue: Option<bool>,
    workspace_root: Option<String>,
    // 会话自持的 provider 身份（前端 stampProvider/restoreBinding 解析出的绑定）。
    // None = 前端无绑定，走会话元数据 → 全局 active 兜底（见 resolve_send_provider）。
    provider: Option<String>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
    workspace_state: State<'_, WorkspaceState>,
    settings_service: State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<(), String> {
    let cwd = session_cwd(&workspace_root, &workspace_state);
    let cwd_str = cwd.to_string_lossy().to_string();

    let active =
        resolve_send_provider(settings_service.inner().clone(), &session_id, provider).await?;
    // Clone the Arc before `get_settings` takes the `State` by value — the
    // permission snapshot below still needs the service.
    let snapshot_service = settings_service.inner().clone();
    let settings = get_settings(settings_service).await.ok();
    let proxy = settings
        .as_ref()
        .map(|s| s.proxy.clone())
        .unwrap_or_default();
    let provider_env = build_runtime_env_vars(&active, &proxy);
    let provider_switched = runtime_mgr.connection_drifted(&session_id, &provider_env);
    runtime_mgr.upsert_fingerprint(&session_id, &provider_env);
    // 自动命名开关下发 sidecar（设置读取失败时默认开启）
    let auto_title = settings.as_ref().map(|s| s.auto_naming).unwrap_or(true);
    // 思考开关下发 sidecar（设置读取失败时默认开启）：只在 spawn（建 query）时
    // 生效——会话内 CLI 锁死无法恢复，故仅影响之后新建的会话/btw 支线。
    let thinking_enabled = settings
        .as_ref()
        .map(|s| s.thinking_enabled)
        .unwrap_or(true);

    let mut cmd = build_send_command(
        &session_id,
        &prompt,
        &cwd_str,
        &provider_env,
        SendOptions {
            images: images.as_deref(),
            resume_id,
            initial_model,
            initial_effort,
            permission_mode,
            jump_queue: jump_queue.unwrap_or(false),
            provider_switched,
            auto_title,
            thinking_enabled,
        },
    );

    // 工作区信任标志下发给 sidecar：不信任时 startLoop 据此跳过项目 CLAUDE.md /
    // 项目 .aide/claude/skills/ / 项目 .mcp.json（见 session-worker.ts startLoop）。
    cmd["trusted"] = json!(crate::commands::workspace::is_path_trusted(&cwd_str));

    // Attach the permission policy snapshot so the sidecar's PreToolUse hook can
    // enforce it on the first query. Best-effort: if the snapshot build fails the
    // send still goes out and the sidecar defers to the provider permission mode.
    // `snapshot_service` was cloned above (before `get_settings` consumed the State).
    let snapshot_cwd = cwd.clone();
    if let Ok(Ok(snapshot)) = tokio::task::spawn_blocking(move || {
        snapshot_service.permission_snapshot_blocking(Some(&snapshot_cwd))
    })
    .await
    {
        cmd["permission_policy"] = json!(snapshot);
    }

    // Register/refresh the session's workspace route so future permission-rule
    // saves can broadcast `update_permission_policy` to this session.
    runtime_mgr.register_session_route(&session_id, Some(&cwd));

    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn permission_response(
    session_id: String,
    id: String,
    approved: bool,
    always: Option<bool>,
    answers: Option<HashMap<String, String>>,
    next_mode: Option<String>,
    // 拒绝理由：仅 approved=false 时生效，sidecar 透传给 SDK 的 deny message
    // （作为工具错误反馈给模型，让模型按理由直接调整，不再追问一轮）。
    message: Option<String>,
    // 会话级规则草稿（前端在「允许」文件工具时推导，如「本会话内同文件不再询问」）：
    // 不透明透传给 sidecar 入库（PermissionRuleDraft 形状，Rust 不校验内容）。
    session_rules: Option<Vec<serde_json::Value>>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let mut cmd = json!({
        "cmd": "permission_response",
        "session_id": session_id,
        "id": id,
        "approved": approved,
        "always": always,
    });
    if let Some(a) = answers {
        cmd["answers"] = json!(a);
    }
    if let Some(mode) = next_mode {
        cmd["nextMode"] = json!(mode);
    }
    if let Some(m) = message {
        cmd["message"] = json!(m);
    }
    if let Some(rules) = session_rules {
        cmd["sessionRules"] = json!(rules);
    }
    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn interrupt_session(
    session_id: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "interrupt", "session_id": session_id });
    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn stop_bg_task(
    session_id: String,
    task_id: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "stop_bg_task", "session_id": session_id, "task_id": task_id });
    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn set_model(
    session_id: String,
    model: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<bool, String> {
    let cmd = json!({ "cmd": "set_model", "session_id": session_id, "model": model });
    runtime_mgr.send_to_runtime(&cmd).await.map(|_| true)
}

/// 会话级 effort 切换（provider-agnostic 字符串档位，Claude sidecar 解释为
/// low/medium/high/xhigh/max）。镜像 set_model：Runtime 不在时返回 false，
/// 前端按 deferred 处理（值会随下一条 send 的 env 通道带上）。
#[tauri::command]
pub async fn set_effort(
    session_id: String,
    effort: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<bool, String> {
    let cmd = json!({ "cmd": "set_effort", "session_id": session_id, "effort": effort });
    runtime_mgr.send_to_runtime(&cmd).await.map(|_| true)
}

#[tauri::command]
pub async fn set_permission_mode(
    session_id: String,
    mode: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "set_permission_mode", "session_id": session_id, "mode": mode });
    runtime_mgr.send_to_runtime(&cmd).await
}

#[tauri::command]
pub async fn stop_chat_session(
    session_id: String,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "session_stop", "session_id": session_id });
    runtime_mgr.send_to_runtime(&cmd).await
}

/// 启动 btw 支线：不再 spawn 独立进程，改为发 send 命令到 Runtime，
/// Runtime 内部创建 btwMode=true 的 SessionWorker。
///
/// fork_from 为 None/空 = 不 fork，全新会话（btw 任务支线如 git-commit：
/// 不背主会话历史，token 最省）；tools 非空 = 任务支线的内建工具白名单
/// （query() 的 tools/allowedTools 收成它）；permission_policy 原样透传
/// （worker 的 handleSend 已消费），任务支线靠它在 policy 层放行白名单命令。
#[tauri::command]
pub async fn start_btw_session(
    btw_id: String,
    fork_from: Option<String>,
    prompt: String,
    cwd: String,
    lightweight: bool,
    permission_mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    tools: Option<Vec<String>>,
    permission_policy: Option<serde_json::Value>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
    settings_service: State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<(), String> {
    let active = resolve_active_provider(settings_service.inner().clone()).await?;
    let proxy = get_settings(settings_service)
        .await
        .map(|s| s.proxy)
        .unwrap_or_default();
    let provider_env = build_runtime_env_vars(&active, &proxy);

    // session_id = BTW 自己的路由键（避免与主会话 worker 冲突）；
    // fork_from = fork 源会话（SDK 据此 fork 主会话上下文）。
    let mut cmd = json!({
        "cmd": "send",
        "session_id": btw_id,
        "prompt": prompt,
        "cwd": cwd,
        "btw": true,
        "lightweight": lightweight,
        "env": provider_env,
    });
    // fork_from 空/省略 = 全新会话（worker 侧 `if (forkFrom)` 判空），不写进 JSON。
    if let Some(ref f) = fork_from {
        if !f.is_empty() {
            cmd["fork_from"] = json!(f);
        }
    }
    if let Some(t) = tools {
        if !t.is_empty() {
            cmd["tools"] = json!(t);
        }
    }
    if let Some(p) = permission_policy {
        cmd["permission_policy"] = p;
    }
    // 工作区信任标志（与 send_message 同语义）。
    cmd["trusted"] = json!(crate::commands::workspace::is_path_trusted(&cwd));

    if let Some(ref m) = model {
        if !m.is_empty() {
            if let Some(env) = cmd.get_mut("env").and_then(|e| e.as_object_mut()) {
                env.insert("ANTHROPIC_MODEL".to_string(), json!(m));
            }
        }
    }
    // effort 与普通 send 的 initial_effort 同形：骑 env 通道，worker 只读作初始
    // currentEffort（options.effort），绝不会以 env 形式透传给 CLI。
    if let Some(ref effort) = effort {
        if !effort.is_empty() {
            if let Some(env) = cmd.get_mut("env").and_then(|e| e.as_object_mut()) {
                env.insert("CLAUDE_CODE_EFFORT_LEVEL".to_string(), json!(effort));
            }
        }
    }
    if let Some(mode) = permission_mode {
        if !mode.is_empty() {
            cmd["permission_mode"] = json!(mode);
        }
    }

    runtime_mgr.send_to_runtime(&cmd).await
}

/// 会话工作目录
fn session_cwd(
    workspace_root: &Option<String>,
    workspace_state: &State<'_, WorkspaceState>,
) -> PathBuf {
    match workspace_root {
        Some(root) if !root.is_empty() => PathBuf::from(root),
        _ => project_root_for_commands(workspace_state),
    }
}

// ---- 静态数据（模型列表、权限模式） ----

fn resolve_sidecar_data_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let path = manifest
            .parent()
            .unwrap()
            .join("agent-sidecar")
            .join(file_name);
        if path.exists() {
            return Ok(path);
        }
        Err(format!("{} not found at {:?}", file_name, path))
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let path = resource_dir.join("agent-runtime").join(file_name);
        if path.exists() {
            return Ok(path);
        }
        // fallback
        let fallback = resource_dir.join("agent-sidecar").join(file_name);
        if fallback.exists() {
            return Ok(fallback);
        }
        Err(format!("{} resource missing: {:?}", file_name, path))
    }
}

fn read_sidecar_data_json(
    app: &tauri::AppHandle,
    file_name: &str,
) -> Result<serde_json::Value, String> {
    let path = resolve_sidecar_data_path(app, file_name)?;
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", file_name, e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", file_name, e))
}

#[tauri::command]
pub fn get_default_models(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    read_sidecar_data_json(&app_handle, "default-models.json")
}

#[tauri::command]
pub fn get_default_permission_modes(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    read_sidecar_data_json(&app_handle, "default-permission-modes.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认开 auto_title/thinking_enabled（与 send_message 生产路径的默认一致）。
    fn base_opts() -> SendOptions<'static> {
        SendOptions {
            auto_title: true,
            thinking_enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn send_message_cmd_has_session_id() {
        // 回归：所有命令必须带 session_id，否则 Runtime 无法路由
        let cmd = json!({ "cmd": "send", "session_id": "test-sid", "prompt": "hello", "cwd": "/tmp", "env": {} });
        assert_eq!(cmd["session_id"], "test-sid");
        assert_eq!(cmd["cmd"], "send");
    }

    #[test]
    fn session_stop_cmd_has_session_id() {
        let cmd = json!({ "cmd": "session_stop", "session_id": "test-sid" });
        assert_eq!(cmd["session_id"], "test-sid");
    }

    #[test]
    fn permission_response_cmd_has_session_id() {
        let cmd = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": true,
            "always": serde_json::Value::Null,
        });
        assert_eq!(cmd["session_id"], "test-sid");
        assert_eq!(cmd["id"], "perm-1");
        assert_eq!(cmd["approved"], true);
    }

    /// 回归：拒绝带理由时 permission_response 必须携带 message（sidecar 透传给
    /// SDK 的 deny message）；无理由时不得出现该键（保持旧行为）。
    #[test]
    fn permission_response_cmd_message_optional() {
        let with_msg = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": false,
            "always": serde_json::Value::Null,
            "message": "改用相对路径",
        });
        assert_eq!(with_msg["message"], "改用相对路径");

        let without_msg = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": false,
            "always": serde_json::Value::Null,
        });
        assert!(without_msg.get("message").is_none());
    }

    /// 会话级规则草稿：带则透传 sessionRules，不带则不得出现该键。
    #[test]
    fn permission_response_cmd_session_rules_optional() {
        let with_rules = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": true,
            "always": serde_json::Value::Null,
            "sessionRules": [{
                "effect": "allow",
                "tool": "Edit",
                "matcher": { "kind": "path", "field": "file_path", "file": "C:/x.ts" },
            }],
        });
        assert_eq!(with_rules["sessionRules"][0]["tool"], "Edit");
        assert_eq!(with_rules["sessionRules"][0]["matcher"]["file"], "C:/x.ts");

        let without_rules = json!({
            "cmd": "permission_response",
            "session_id": "test-sid",
            "id": "perm-1",
            "approved": true,
            "always": serde_json::Value::Null,
        });
        assert!(without_rules.get("sessionRules").is_none());
    }

    #[test]
    fn interrupt_cmd_has_session_id() {
        let cmd = json!({ "cmd": "interrupt", "session_id": "test-sid" });
        assert_eq!(cmd["session_id"], "test-sid");
    }

    #[test]
    fn set_model_cmd_has_session_id() {
        let cmd = json!({ "cmd": "set_model", "session_id": "test-sid", "model": "sonnet" });
        assert_eq!(cmd["session_id"], "test-sid");
        assert_eq!(cmd["model"], "sonnet");
    }

    /// 回归：普通 send 不携带 btw/fork_from/provider_switched，SessionWorker 不应该
    /// 把 session_id 当作 fork 源（否则 SDK 会尝试 resume 不存在的会话导致 404）。
    #[test]
    fn send_message_cmd_no_fork_triggers_for_normal_session() {
        let cmd = json!({ "cmd": "send", "session_id": "normal-sid", "prompt": "hello", "cwd": "/tmp", "env": {} });
        // 普通会话不应有 fork 标记
        assert!(cmd.get("btw").is_none() || cmd["btw"] == false);
        assert!(cmd.get("fork_from").is_none());
        assert!(cmd.get("provider_switched").is_none() || cmd["provider_switched"] == false);
        assert_eq!(cmd["session_id"], "normal-sid"); // 路由键仍然存在
    }

    /// 回归：BTW send 必须带 fork_from（fork 源会话）和 btw:true。
    /// session_id 是 BTW 自己的路由键，不应等于 fork_from（否则会和主会话 worker 冲突）。
    #[test]
    fn btw_cmd_has_fork_from_not_session_id_as_fork_source() {
        // 模拟 start_btw_session 构造的 JSON
        let btw_id = "btw-temp-id";
        let fork_from = "main-session-id";
        let cmd = json!({
            "cmd": "send",
            "session_id": btw_id,
            "prompt": "顺便问",
            "cwd": "/repo",
            "btw": true,
            "lightweight": true,
            "fork_from": fork_from,
            "env": {}
        });
        assert_eq!(cmd["btw"], true);
        assert_eq!(cmd["session_id"], btw_id); // BTW 自己的路由键
        assert_eq!(cmd["fork_from"], fork_from); // fork 源独立字段
        assert_ne!(cmd["session_id"], cmd["fork_from"]); // 两者不能相同，否则 worker 路由冲突
    }

    /// 回归（Bug 2）：resume_id 必须进 resume_session_id 字段，不能覆盖 session_id（路由键）。
    /// 覆盖了会让 SessionManager 用真 ID 建 worker，但 SessionWorker.resumeSource 仍空 → 不 resume。
    #[test]
    fn build_send_command_resume_goes_to_separate_field() {
        let cmd = build_send_command(
            "main-sid", // session_id（路由键 = 前端 sid）
            "继续聊",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                resume_id: Some("resume-xyz".to_string()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["cmd"], "send");
        assert_eq!(cmd["session_id"], "main-sid"); // 路由键不变
        assert_eq!(cmd["resume_session_id"], "resume-xyz"); // resume 进独立字段
        assert!(cmd.get("provider_switched").is_none() || cmd["provider_switched"] == false);
    }

    /// 回归：无 resume_id 时不出 resume_session_id 字段（普通新会话）。
    #[test]
    fn build_send_command_no_resume_field_when_absent() {
        let cmd = build_send_command("temp-1", "hi", "/tmp", &HashMap::new(), base_opts());
        assert_eq!(cmd["session_id"], "temp-1");
        assert!(cmd.get("resume_session_id").is_none());
    }

    /// images 非空才落字段（Some 非空 → cmd.images；空数组与 None 均不落）。
    #[test]
    fn build_send_command_carries_images_when_nonempty() {
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                images: Some(&[json!({"mime": "image/png", "data": "aGk="})]),
                ..base_opts()
            },
        );
        assert_eq!(cmd["images"][0]["mime"], "image/png");
        // 空数组：与 None 一样不落字段
        let empty = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                images: Some(&[]),
                ..base_opts()
            },
        );
        assert!(empty.get("images").is_none());
    }

    /// initial_model 注入 env.ANTHROPIC_MODEL 覆盖 provider 默认；空串不注入
    /// （保留 provider env 原值）。与 effort 共用 attach_env_override（带值/空串臂）。
    #[test]
    fn build_send_command_carries_initial_model() {
        let env: HashMap<String, String> = HashMap::from([(
            "ANTHROPIC_MODEL".to_string(),
            "claude-sonnet-4-5".to_string(),
        )]);
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &env,
            SendOptions {
                initial_model: Some("claude-opus-4-1".to_string()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["env"]["ANTHROPIC_MODEL"], "claude-opus-4-1");
        // 空串：不注入，provider env 原值保留
        let blank = build_send_command(
            "s",
            "hi",
            "/tmp",
            &env,
            SendOptions {
                initial_model: Some(String::new()),
                ..base_opts()
            },
        );
        assert_eq!(blank["env"]["ANTHROPIC_MODEL"], "claude-sonnet-4-5");
    }

    /// effort 与 initial_model 同形：initial_effort 注入 env.CLAUDE_CODE_EFFORT_LEVEL
    /// 覆盖 provider 默认；缺省/空串则不注入（保留 provider env 原值）。
    #[test]
    fn build_send_command_carries_initial_effort() {
        let env: HashMap<String, String> =
            HashMap::from([("CLAUDE_CODE_EFFORT_LEVEL".to_string(), "LOW".to_string())]);
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &env,
            SendOptions {
                initial_effort: Some("max".to_string()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "max");
        // 缺省：provider env 原值保留（sidecar 读作 provider 默认档位）
        let cmd2 = build_send_command("s", "hi", "/tmp", &env, base_opts());
        assert_eq!(cmd2["env"]["CLAUDE_CODE_EFFORT_LEVEL"], "LOW");
    }

    /// permission_mode 非空才落字段；空串不落。
    #[test]
    fn build_send_command_carries_permission_mode() {
        let cmd = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                permission_mode: Some("writeEdits".to_string()),
                ..base_opts()
            },
        );
        assert_eq!(cmd["permission_mode"], "writeEdits");
        // 空串：不落字段
        let blank = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                permission_mode: Some(String::new()),
                ..base_opts()
            },
        );
        assert!(blank.get("permission_mode").is_none());
    }

    /// jump_queue 仅 true 落字段（false 与缺省一致，不落）。
    #[test]
    fn build_send_command_carries_jump_queue_when_enabled() {
        let on = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                jump_queue: true,
                ..base_opts()
            },
        );
        assert_eq!(on["jump_queue"], true);
        let off = build_send_command("s", "hi", "/tmp", &HashMap::new(), base_opts());
        assert!(off.get("jump_queue").is_none());
    }

    /// 回归：provider_switched 仍照常带，且不干扰 resume_session_id。
    #[test]
    fn build_send_command_provider_switched_and_resume_coexist() {
        let cmd = build_send_command(
            "main-sid",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                resume_id: Some("resume-xyz".to_string()),
                provider_switched: true,
                ..base_opts()
            },
        );
        assert_eq!(cmd["session_id"], "main-sid");
        assert_eq!(cmd["resume_session_id"], "resume-xyz");
        assert_eq!(cmd["provider_switched"], true);
    }

    /// 自动命名开关（settings.autoNaming）随 send 命令下发给 sidecar：
    /// false 时 sidecar 首轮后不生成会话标题。
    #[test]
    fn build_send_command_carries_auto_title_flag() {
        let on = build_send_command("s", "hi", "/tmp", &HashMap::new(), base_opts());
        assert_eq!(on["auto_title"], true);
        let off = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                auto_title: false,
                ..base_opts()
            },
        );
        assert_eq!(off["auto_title"], false);
    }

    /// 思考开关（settings.thinkingEnabled）随 send 命令下发给 sidecar：
    /// false 时 spawn 的 thinking 参数为 disabled（会话内无效，只影响新建会话）。
    #[test]
    fn build_send_command_carries_thinking_enabled_flag() {
        let on = build_send_command("s", "hi", "/tmp", &HashMap::new(), base_opts());
        assert_eq!(on["thinking_enabled"], true);
        let off = build_send_command(
            "s",
            "hi",
            "/tmp",
            &HashMap::new(),
            SendOptions {
                thinking_enabled: false,
                ..base_opts()
            },
        );
        assert_eq!(off["thinking_enabled"], false);
    }
}
