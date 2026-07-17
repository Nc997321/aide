use tauri::State;
use serde_json::json;
use crate::sidecar::SidecarManager;
use crate::commands::{WorkspaceState, project_root_for_commands, find_session_jsonl_globally};
use crate::commands::provider::{load_active_provider, provider_to_env_vars, system_default_mappings_to_env};
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
    // 忙碌时的"插队"：不在这里直接打断，原样透传给 sidecar，由它在安全边界
    // （当前工具调用跑完）自己决定何时真正 interrupt，见 agent-sidecar/src/index.ts
    // 的 jump_queue 处理。
    jump_queue: Option<bool>,
    // 会话所属工作区根路径（混合 tab 布局：跨工作区会话必须在自己的项目目录里
    // 跑，而不是当前活动工作区）。缺省 = 新会话，归属当前活动工作区。
    workspace_root: Option<String>,
    sidecar_mgr: State<'_, SidecarManager>,
    workspace_state: State<'_, WorkspaceState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // 存活会话永不 respawn：全局切换供应商不应影响已启动的会话，它继续用 spawn
    // 那一刻的 provider 配置，直到用户主动点 stop_session 杀掉进程。只有"没有存活
    // 进程"（新会话 / stop 后续发 / 重开历史对话）才在这里 spawn，并用当前 active
    // provider 的配置。
    let cwd = session_cwd(&workspace_root, &workspace_state);
    let mut cmd = json!({
        "cmd": "send",
        "prompt": prompt,
        "cwd": cwd.to_string_lossy().to_string(),
    });

    if !sidecar_mgr.has_session(&session_id) {
        let mut env_vars = build_sidecar_env_vars();

        // 在 spawn upsert 新指纹之前读旧指纹：判断这是不是"换着 provider 续一个
        // 旧会话"（stop 后切了供应商再续发）。若是，通知 sidecar forkSession 绕开
        // CLI session 文件里缓存的旧 provider 配置，避免打到旧 base_url 返回 404。
        // 全新会话无旧指纹 → false；同 provider stop 后续发 → 指纹一致 → false。
        let provider_switched = sidecar_mgr.connection_drifted(&session_id, &env_vars);

        // 会话面板里当前选中的模型，覆盖 provider 配置的默认值；之后切模型走运行时
        // 的 set_model 命令。仅在 spawn 时生效一次。
        apply_initial_model_override(&mut env_vars, initial_model);
        sidecar_mgr.spawn(session_id.clone(), cwd, env_vars, app_handle)?;

        if provider_switched {
            cmd["provider_switched"] = json!(true);
        }
    }

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
    if jump_queue == Some(true) {
        cmd["jump_queue"] = json!(true);
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
) -> Result<bool, String> {
    // 无活进程（停止/历史会话）不算错误：返回 false 让前端走「随下一条消息
    // initialModel 生效」的 deferred 路径并给出回执提示——此前用 Err
    // （"Session not found"）表达，前端只能靠吞错分辨，未启动切换因此毫无提示。
    if !sidecar_mgr.has_session(&session_id) {
        return Ok(false);
    }
    let cmd = json!({ "cmd": "set_model", "model": model });
    sidecar_mgr.send(&session_id, &cmd).await.map(|_| true)
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

/// 启动一个 btw 支线 sidecar 进程:fork 主会话(fork_from)当前状态,跑一个隔离
/// 的"顺便问一下"支线。btw_id 由前端生成(纯内存临时 key,落 pendingSids,不进
/// 侧栏/不写元数据)。spawn 复用 SidecarManager::spawn(CREATE_NO_WINDOW /
/// dunce::simplified 等跨平台约束自动满足),再发首条带 btw:true 的 send 命令。
///
/// fork 源判据:主会话 sidecar 进程存活 **或** 它在磁盘上有历史 transcript 文件。
/// 后者覆盖「续接历史对话但本轮还没发新消息」的场景——主 sidecar 没起,但
/// transcript 在,SDK 的 fork(resume:<sid> + forkSession:true)读的是文件,照样
/// 能带着完整历史上下文分叉。两者都没有(全新空白会话)才真的没法 fork——
/// 不过全新空白会话 sessionId 为 null,前端已禁用 btw,正常走不到这里。
#[tauri::command]
pub async fn start_btw_session(
    btw_id: String,
    fork_from: String,
    prompt: String,
    cwd: String,
    lightweight: bool,
    permission_mode: Option<String>,
    // btw 默认走便宜快的模型(前端传 haiku);None/空串则退化到 provider 默认。
    // 仅 spawn 时生效一次,语义与 send_message 的 initial_model 一致。
    model: Option<String>,
    app_handle: tauri::AppHandle,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    if !sidecar_mgr.has_session(&fork_from) && find_session_jsonl_globally(&fork_from).is_empty() {
        return Err(format!("主对话未就绪,无法顺便问(fork_from 既无存活进程也无历史 transcript): {fork_from}"));
    }
    let mut env_vars = build_sidecar_env_vars();
    apply_initial_model_override(&mut env_vars, model);
    sidecar_mgr.spawn(btw_id.clone(), PathBuf::from(&cwd), env_vars, app_handle)?;
    let cmd = build_btw_send_cmd(&fork_from, &prompt, &cwd, lightweight, &permission_mode);
    sidecar_mgr.send(&btw_id, &cmd).await
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

/// 会话实际生效的工作目录：显式归属（混合 tab 的跨工作区会话）优先，
/// 否则回落当前活动工作区。空串视同缺省。
fn session_cwd(
    workspace_root: &Option<String>,
    workspace_state: &State<'_, WorkspaceState>,
) -> PathBuf {
    match workspace_root {
        Some(root) if !root.is_empty() => PathBuf::from(root),
        _ => project_root_for_commands(workspace_state),
    }
}

/// 构造 sidecar spawn 用的 env:active provider 的连接参数 + 系统 env 兜底 +
/// settings 代理。send_message 与 start_btw_session 共用,保证 btw 进程与主
/// sidecar 用同一套 provider 配置(否则 fork 出来的支线会打到错误 endpoint)。
fn build_sidecar_env_vars() -> HashMap<String, String> {
    let active_provider = load_active_provider();
    let mut env_vars: HashMap<String, String> = if let Some(ref provider) = active_provider {
        provider_to_env_vars(provider)
    } else {
        system_default_mappings_to_env()
    };

    let fallback_keys: &[&str] = if active_provider.is_some() {
        &[
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ]
    } else {
        &[
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
        ]
    };
    for var in fallback_keys {
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
    env_vars
}

/// btw 首条 send 命令:fork 主会话(session_id=主 sid)+ btw:true + lightweight。
/// Rust 不感知 forkSession 语义,只透传 btw 标记,由 sidecar 解释(见 agent-sidecar
/// /src/index.ts)。cwd/permission_mode 原样透传,空 permission_mode 不带键。
fn build_btw_send_cmd(
    fork_from: &str,
    prompt: &str,
    cwd: &str,
    lightweight: bool,
    permission_mode: &Option<String>,
) -> serde_json::Value {
    let mut cmd = json!({
        "cmd": "send",
        "prompt": prompt,
        "cwd": cwd,
        "session_id": fork_from,
        "btw": true,
        "lightweight": lightweight,
    });
    if let Some(mode) = permission_mode {
        if !mode.is_empty() {
            cmd["permission_mode"] = json!(mode);
        }
    }
    cmd
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

    // btw:fork 主会话的 send 命令必须带 session_id(主 sid)+ btw:true + lightweight,
    // 且 cwd/prompt 透传。permission_mode 仅非空时带。
    #[test]
    fn btw_send_cmd_forks_from_main_session() {
        let cmd = build_btw_send_cmd("main-sid", "顺便问下 X", "/repo", true, &None);
        assert_eq!(cmd["cmd"], "send");
        assert_eq!(cmd["session_id"], "main-sid");
        assert_eq!(cmd["btw"], true);
        assert_eq!(cmd["lightweight"], true);
        assert_eq!(cmd["prompt"], "顺便问下 X");
        assert_eq!(cmd["cwd"], "/repo");
        assert!(cmd.get("permission_mode").is_none());
    }

    #[test]
    fn btw_send_cmd_full_mode_carries_permission_mode() {
        let cmd = build_btw_send_cmd("main-sid", "q", "/repo", false, &Some("default".to_string()));
        assert_eq!(cmd["lightweight"], false);
        assert_eq!(cmd["permission_mode"], "default");
    }

    #[test]
    fn btw_send_cmd_empty_permission_mode_omitted() {
        let cmd = build_btw_send_cmd("main-sid", "q", "/repo", true, &Some(String::new()));
        assert!(cmd.get("permission_mode").is_none());
    }
}
