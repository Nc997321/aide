use tauri::State;
use serde_json::json;
use crate::runtime::AgentRuntimeManager;
use crate::commands::{WorkspaceState, project_root_for_commands};
use crate::runtime::provider::active_provider_or_system_default;
use crate::runtime::env::build_runtime_env_vars;
use crate::commands::settings::get_settings;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// 构造 `send` 命令的 JSON（纯函数，可单测）。
///
/// 关键：resume_id 进 `resume_session_id` 独立字段，**不覆盖 `session_id`**（路由键）。
/// SessionManager 按 session_id 路由到/建 worker；SessionWorker 在首条 send（无活 query）
/// 时把 resume_session_id 赋给 resumeSource，startLoop 的 forkResumeOptions 据此 resume。
/// 旧行为（resume_id 覆盖 session_id）会让路由键换成真 ID 但 resumeSource 仍空 → 不 resume。
#[allow(clippy::too_many_arguments)]
fn build_send_command(
    session_id: &str,
    prompt: &str,
    images: Option<&Vec<serde_json::Value>>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    permission_mode: Option<String>,
    jump_queue: Option<bool>,
    workspace_root: Option<String>,
    provider_switched: bool,
    auto_title: bool,
    env_vars: &HashMap<String, String>,
    cwd: &str,
) -> serde_json::Value {
    let mut cmd = json!({
        "cmd": "send",
        "session_id": session_id,
        "prompt": prompt,
        "cwd": cwd,
        "env": env_vars,
        "auto_title": auto_title,
    });
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            cmd["images"] = json!(imgs);
        }
    }
    if let Some(rid) = resume_id {
        cmd["resume_session_id"] = json!(rid);
    }
    if let Some(ref model) = initial_model {
        if !model.is_empty() {
            if let Some(env) = cmd.get_mut("env").and_then(|e| e.as_object_mut()) {
                env.insert("ANTHROPIC_MODEL".to_string(), json!(model));
            }
        }
    }
    if let Some(mode) = permission_mode {
        if !mode.is_empty() {
            cmd["permission_mode"] = json!(mode);
        }
    }
    if jump_queue == Some(true) {
        cmd["jump_queue"] = json!(true);
    }
    if provider_switched {
        cmd["provider_switched"] = json!(true);
    }
    let _ = workspace_root; // cwd 已在外部解析传入
    cmd
}

/// 构造 Runtime 内部图片预检命令（纯函数，保持 IPC 载荷可单测）。
#[cfg(test)]
fn build_probe_image_input_command(
    request_id: &str,
    model: Option<String>,
    env: &HashMap<String, String>,
) -> serde_json::Value {
    json!({
        "cmd": "probe_image_input",
        "request_id": request_id,
        "model": model,
        "env": env,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInputProbeResult {
    pub supported: Option<bool>,
}

#[tauri::command]
pub async fn probe_image_input(
    model: Option<String>,
    app_handle: tauri::AppHandle,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<ImageInputProbeResult, String> {
    let active = active_provider_or_system_default();
    let proxy = get_settings().map(|s| s.proxy).unwrap_or_default();
    let mut env = build_runtime_env_vars(&active, &proxy);
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        env.insert("ANTHROPIC_MODEL".into(), model);
    }

    runtime_mgr.ensure_runtime(app_handle, env.clone()).await?;
    Ok(ImageInputProbeResult {
        supported: runtime_mgr.probe_image_input(env).await?,
    })
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    prompt: String,
    images: Option<Vec<serde_json::Value>>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    permission_mode: Option<String>,
    jump_queue: Option<bool>,
    workspace_root: Option<String>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let cwd = session_cwd(&workspace_root, &workspace_state);
    let cwd_str = cwd.to_string_lossy().to_string();

    let active = active_provider_or_system_default();
    let settings = get_settings().ok();
    let proxy = settings.as_ref().map(|s| s.proxy.clone()).unwrap_or_default();
    let provider_env = build_runtime_env_vars(&active, &proxy);
    let provider_switched = runtime_mgr.connection_drifted(&session_id, &provider_env);
    runtime_mgr.upsert_fingerprint(&session_id, &provider_env);
    // 自动命名开关下发 sidecar（设置读取失败时默认开启）
    let auto_title = settings.as_ref().map(|s| s.auto_naming).unwrap_or(true);

    let cmd = build_send_command(
        &session_id,
        &prompt,
        images.as_ref(),
        resume_id,
        initial_model,
        permission_mode,
        jump_queue,
        workspace_root,
        provider_switched,
        auto_title,
        &provider_env,
        &cwd_str,
    );

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
#[tauri::command]
pub async fn start_btw_session(
    btw_id: String,
    fork_from: String,
    prompt: String,
    cwd: String,
    lightweight: bool,
    permission_mode: Option<String>,
    model: Option<String>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let active = active_provider_or_system_default();
    let proxy = get_settings().map(|s| s.proxy).unwrap_or_default();
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
        "fork_from": fork_from,
        "env": provider_env,
    });

    if let Some(ref m) = model {
        if !m.is_empty() {
            if let Some(env) = cmd.get_mut("env").and_then(|e| e.as_object_mut()) {
                env.insert("ANTHROPIC_MODEL".to_string(), json!(m));
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
        let path = manifest.parent().unwrap().join("agent-sidecar").join(file_name);
        if path.exists() { return Ok(path); }
        Err(format!("{} not found at {:?}", file_name, path))
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let path = resource_dir.join("agent-runtime").join(file_name);
        if path.exists() { return Ok(path); }
        // fallback
        let fallback = resource_dir.join("agent-sidecar").join(file_name);
        if fallback.exists() { return Ok(fallback); }
        Err(format!("{} resource missing: {:?}", file_name, path))
    }
}

fn read_sidecar_data_json(app: &tauri::AppHandle, file_name: &str) -> Result<serde_json::Value, String> {
    let path = resolve_sidecar_data_path(app, file_name)?;
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", file_name, e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", file_name, e))
}

#[tauri::command]
pub fn get_default_models(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    read_sidecar_data_json(&app_handle, "default-models.json")
}

#[tauri::command]
pub fn get_default_permission_modes(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    read_sidecar_data_json(&app_handle, "default-permission-modes.json")
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let env: HashMap<String, String> = HashMap::new();
        let cmd = build_send_command(
            "main-sid",        // session_id（路由键 = 前端 sid）
            "继续聊",
            None,              // images
            Some("resume-xyz".to_string()), // resume_id
            None, None, None, None, false, true, &env,
            "/tmp",
        );
        assert_eq!(cmd["cmd"], "send");
        assert_eq!(cmd["session_id"], "main-sid");       // 路由键不变
        assert_eq!(cmd["resume_session_id"], "resume-xyz"); // resume 进独立字段
        assert!(cmd.get("provider_switched").is_none() || cmd["provider_switched"] == false);
    }

    /// 回归：无 resume_id 时不出 resume_session_id 字段（普通新会话）。
    #[test]
    fn build_send_command_no_resume_field_when_absent() {
        let env: HashMap<String, String> = HashMap::new();
        let cmd = build_send_command(
            "temp-1", "hi", None, None, None, None, None, None, false, true, &env, "/tmp",
        );
        assert_eq!(cmd["session_id"], "temp-1");
        assert!(cmd.get("resume_session_id").is_none());
    }

    /// 回归：provider_switched 仍照常带，且不干扰 resume_session_id。
    #[test]
    fn build_send_command_provider_switched_and_resume_coexist() {
        let env: HashMap<String, String> = HashMap::new();
        let cmd = build_send_command(
            "main-sid", "hi", None,
            Some("resume-xyz".to_string()),
            None, None, None, None,
            true, true, &env, "/tmp",
        );
        assert_eq!(cmd["session_id"], "main-sid");
        assert_eq!(cmd["resume_session_id"], "resume-xyz");
        assert_eq!(cmd["provider_switched"], true);
    }

    /// 自动命名开关（settings.autoNaming）随 send 命令下发给 sidecar：
    /// false 时 sidecar 首轮后不生成会话标题。
    #[test]
    fn build_send_command_carries_auto_title_flag() {
        let env: HashMap<String, String> = HashMap::new();
        let on = build_send_command(
            "s", "hi", None, None, None, None, None, None, false, true, &env, "/tmp",
        );
        assert_eq!(on["auto_title"], true);
        let off = build_send_command(
            "s", "hi", None, None, None, None, None, None, false, false, &env, "/tmp",
        );
        assert_eq!(off["auto_title"], false);
    }

    #[test]
    fn probe_image_input_cmd_carries_request_model_and_provider_env() {        let cmd = build_probe_image_input_command(
            "probe-1",
            Some("glm-5.2".into()),
            &HashMap::from([("ANTHROPIC_BASE_URL".into(), "https://gateway".into())]),
        );
        assert_eq!(cmd["cmd"], "probe_image_input");
        assert_eq!(cmd["request_id"], "probe-1");
        assert_eq!(cmd["model"], "glm-5.2");
        assert_eq!(cmd["env"]["ANTHROPIC_BASE_URL"], "https://gateway");
    }
}
