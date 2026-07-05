use tauri::State;
use serde_json::json;
use crate::sidecar::SidecarManager;
use crate::commands::{WorkspaceState, project_root_for_commands};
use crate::commands::provider::{load_active_provider, provider_to_env_vars};
use crate::commands::settings::get_settings;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[tauri::command]
pub async fn send_message(
    session_id: String,
    prompt: String,
    images: Option<Vec<serde_json::Value>>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    permission_mode: Option<String>,
    sidecar_mgr: State<'_, SidecarManager>,
    workspace_state: State<'_, WorkspaceState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // env_vars 每次发消息前都无条件重新计算（provider 配置只是读一次 JSON 文件，
    // 代价可忽略）：这是修复"切换供应商后已存活进程还在用旧 base_url"这个 bug
    // 的关键——旧代码只在 `!has_session` 分支里算一次，进程活着就再也不会重新
    // 读取 provider 配置，导致切换供应商对已存活会话形同虚设。
    let mut env_vars: HashMap<String, String> = if let Some(provider) = load_active_provider() {
        provider_to_env_vars(&provider)
    } else {
        HashMap::new()
    };

    // 从系统全局环境变量读取认证信息和代理（provider 未覆盖的字段兜底）
    for var in &[
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CONFIG_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if !env_vars.contains_key(*var) {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() {
                    env_vars.insert(var.to_string(), val);
                }
            }
        }
    }

    if let Ok(s) = get_settings() {
        if !s.proxy.is_empty() {
            env_vars.insert("HTTP_PROXY".to_string(), s.proxy.clone());
            env_vars.insert("HTTPS_PROXY".to_string(), s.proxy.clone());
            env_vars.insert("http_proxy".to_string(), s.proxy.clone());
            env_vars.insert("https_proxy".to_string(), s.proxy);
        }
    }

    // 连接身份（base_url/api_key/auth_token/代理）相对存活进程 spawn 时的快照
    // 漂移了，或者该 session 压根没有存活进程：都需要（重新）拉起子进程。
    // 已有进程会先被 kill——kill() 内部先置 killed=true 再杀，读者任务的
    // EOF 不会误报 session_dead（跟用户主动点"停止"走的是同一条静默路径）。
    // 新进程沿用已有的 resume_id（前端对非 pending 会话恒定带 sid 作为
    // resume_id）续上 SDK 侧的会话历史，对用户透明。

    if sidecar_mgr.needs_respawn(&session_id, &env_vars) {
        if sidecar_mgr.has_session(&session_id) {
            sidecar_mgr.kill(&session_id).await;
        }
        let cwd = project_root_for_commands(&workspace_state);
        // 会话面板里当前选中的模型，覆盖 provider 配置的默认值；之后切模型走
        // 运行时的 set_model 命令。首次 spawn 和「漂移触发的重新 spawn」都走
        // 这一行——后者天然会带上用户切换供应商时刚选的新模型（前端每条消息
        // 都带 initialModel，只是旧代码只在首次 spawn 时用到）。
        apply_initial_model_override(&mut env_vars, initial_model);
        sidecar_mgr.spawn(session_id.clone(), cwd, env_vars, app_handle)?;
    }

    let cwd = project_root_for_commands(&workspace_state)
        .to_string_lossy()
        .to_string();
    let mut cmd = json!({
        "cmd": "send",
        "prompt": prompt,
        "cwd": cwd,
    });
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            cmd["images"] = json!(imgs);
        }
    }
    if let Some(rid) = resume_id {
        cmd["session_id"] = json!(rid);
    }
    // 每条消息都带当前选中的权限模式：sidecar 侧幂等（同值跳过），
    // 首条消息借此把模式带进 query 初始选项。Rust 不理解模式语义，无脑透传。
    if let Some(mode) = permission_mode {
        if !mode.is_empty() {
            cmd["permission_mode"] = json!(mode);
        }
    }
    sidecar_mgr.send(&session_id, &cmd).await
}

#[tauri::command]
pub async fn permission_response(
    session_id: String,
    id: String,
    approved: bool,
    always: Option<bool>,
    answers: Option<HashMap<String, String>>,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    let cmd = build_permission_response_cmd(&id, approved, always, answers);
    sidecar_mgr.send(&session_id, &cmd).await
}

/// 「总是允许」把 `always: true` 原样透传给 sidecar——sidecar 侧的 PermissionManager
/// 据此决定是否把这次调用的规则（SDK suggestions 或兜底的整工具名规则）附加到
/// PermissionResult.updatedPermissions 上，交给 SDK 自己落盘到项目
/// `.claude/settings.json`。`answers` 仅 AskUserQuestion 场景使用（问题文本 →
/// 选中答案的不透明映射，由 sidecar 重组进 updatedInput）。Rust 这层对两者都只做
/// 无脑透传，不理解语义；answers 为 None 时干脆不带这个键，保持普通工具批准的
/// JSON 形状不变。
fn build_permission_response_cmd(
    id: &str,
    approved: bool,
    always: Option<bool>,
    answers: Option<HashMap<String, String>>,
) -> serde_json::Value {
    let mut cmd = json!({ "cmd": "permission_response", "id": id, "approved": approved, "always": always });
    if let Some(a) = answers {
        cmd["answers"] = json!(a);
    }
    cmd
}

#[tauri::command]
pub async fn interrupt_session(
    session_id: String,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "interrupt" });
    sidecar_mgr.send(&session_id, &cmd).await
}

#[tauri::command]
pub async fn set_model(
    session_id: String,
    model: String,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "set_model", "model": model });
    sidecar_mgr.send(&session_id, &cmd).await
}

#[tauri::command]
pub async fn set_permission_mode(
    session_id: String,
    mode: String,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "set_permission_mode", "mode": mode });
    sidecar_mgr.send(&session_id, &cmd).await
}

#[tauri::command]
pub async fn stop_chat_session(
    session_id: String,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    sidecar_mgr.kill(&session_id).await;
    Ok(())
}

/// 临时 key → SDK 真实 session id：只改 sidecar 进程注册表这一个内存态。
/// 临时 key 从未落盘，这里不需要再触碰任何文件（对比旧版 migrate_session）。
#[tauri::command]
pub fn rename_sidecar_session(
    old_id: String,
    new_id: String,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    sidecar_mgr.rename(&old_id, &new_id)
}

/// 新建 sidecar 进程时，把面板里选的模型转成 CLI 认的 `ANTHROPIC_MODEL` 环境变量，
/// 覆盖 provider 配置的默认值——CLI 启动时读这个变量决定用哪个模型，这条路径
/// 在 `provider_to_env_vars` 里对 provider 默认模型已经用过，这里只是同一机制上
/// 再叠一层"这次对话显式选的模型"优先级更高。
fn apply_initial_model_override(env_vars: &mut HashMap<String, String>, initial_model: Option<String>) {
    if let Some(model) = initial_model {
        if !model.is_empty() {
            env_vars.insert("ANTHROPIC_MODEL".to_string(), model);
        }
    }
}

/// agent-sidecar 名下的静态数据文件：dev 从源码目录读，release 从打包资源读。
fn resolve_sidecar_data_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let path = manifest.parent().unwrap().join("agent-sidecar").join(file_name);
        if path.exists() {
            return Ok(path);
        }
        Err(format!("{} not found at {:?}", file_name, path))
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let path = resource_dir.join("agent-sidecar").join(file_name);
        if path.exists() {
            return Ok(path);
        }
        Err(format!("{} resource missing: {:?}", file_name, path))
    }
}

fn read_sidecar_data_json(app: &tauri::AppHandle, file_name: &str) -> Result<serde_json::Value, String> {
    let path = resolve_sidecar_data_path(app, file_name)?;
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", file_name, e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", file_name, e))
}

/// 会话还没连上 SDK 之前的兜底模型列表——纯静态数据，读文件不起进程。数据本身
/// 是 Claude 专属的模型别名（'sonnet'/'opus' 等），但物理上归 agent-sidecar 所有
/// （`agent-sidecar/default-models.json`），Rust 这层只做不关心内容的透传，
/// 不违反"核心层不出现 provider 专属知识"的红线——和读 Claude 的 .jsonl transcript
/// 是同一类已知例外（见 docs/ARCHITECTURE.md「已知技术债」）。
#[tauri::command]
pub fn get_default_models(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    read_sidecar_data_json(&app_handle, "default-models.json")
}

/// 会话还没连上 SDK 之前的兜底权限模式清单——同 get_default_models 的已知例外：
/// 数据归 agent-sidecar 所有，Rust 只做不关心内容的透传。
#[tauri::command]
pub fn get_default_permission_modes(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    read_sidecar_data_json(&app_handle, "default-permission-modes.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    // 回归：面板里选的模型必须真的落到 CLI 认的 ANTHROPIC_MODEL 环境变量上，
    // 并且优先级高于 provider 配置的默认值——否则"对话前选模型"就是摆设。
    #[test]
    fn initial_model_overrides_provider_default() {
        let mut env_vars = HashMap::new();
        env_vars.insert("ANTHROPIC_MODEL".to_string(), "opus".to_string());
        apply_initial_model_override(&mut env_vars, Some("haiku".to_string()));
        assert_eq!(env_vars.get("ANTHROPIC_MODEL"), Some(&"haiku".to_string()));
    }

    #[test]
    fn no_initial_model_leaves_provider_default_untouched() {
        let mut env_vars = HashMap::new();
        env_vars.insert("ANTHROPIC_MODEL".to_string(), "opus".to_string());
        apply_initial_model_override(&mut env_vars, None);
        assert_eq!(env_vars.get("ANTHROPIC_MODEL"), Some(&"opus".to_string()));
    }

    #[test]
    fn empty_initial_model_is_ignored() {
        let mut env_vars = HashMap::new();
        apply_initial_model_override(&mut env_vars, Some(String::new()));
        assert!(!env_vars.contains_key("ANTHROPIC_MODEL"));
    }

    // 回归：点「总是允许」时 always:true 必须原样进到发给 sidecar 的 JSON 里，
    // 否则 sidecar 侧的持久化规则永远不会被触发。
    #[test]
    fn permission_response_cmd_forwards_always_true() {
        let cmd = build_permission_response_cmd("perm-1", true, Some(true), None);
        assert_eq!(cmd["cmd"], "permission_response");
        assert_eq!(cmd["id"], "perm-1");
        assert_eq!(cmd["approved"], true);
        assert_eq!(cmd["always"], true);
    }

    #[test]
    fn permission_response_cmd_defaults_always_to_null() {
        let cmd = build_permission_response_cmd("perm-2", true, None, None);
        assert!(cmd["always"].is_null());
    }

    // 回归：AskUserQuestion 批准时 answers 必须原样进到 JSON 里，否则 sidecar
    // 没法把用户选择重组进 updatedInput，模型只会看到"用户没有回答"。
    #[test]
    fn permission_response_cmd_forwards_answers() {
        let mut answers = HashMap::new();
        answers.insert("用什么颜色？".to_string(), "蓝色".to_string());
        let cmd = build_permission_response_cmd("perm-3", true, None, Some(answers));
        assert_eq!(cmd["answers"]["用什么颜色？"], "蓝色");
    }

    // 普通工具批准（无 answers）不该在 JSON 里凭空长出 answers 键。
    #[test]
    fn permission_response_cmd_omits_answers_key_when_none() {
        let cmd = build_permission_response_cmd("perm-4", true, None, None);
        assert!(cmd.get("answers").is_none());
    }
}
