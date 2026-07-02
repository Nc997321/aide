use tauri::State;
use serde_json::json;
use crate::sidecar::SidecarManager;
use crate::commands::{WorkspaceState, project_root_for_commands};
use crate::commands::provider::{load_active_provider, provider_to_env_vars};
use crate::commands::settings::get_settings;
use std::collections::HashMap;

#[tauri::command]
pub async fn send_message(
    session_id: String,
    prompt: String,
    images: Option<Vec<serde_json::Value>>,
    resume_id: Option<String>,
    sidecar_mgr: State<'_, SidecarManager>,
    workspace_state: State<'_, WorkspaceState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if !sidecar_mgr.has_session(&session_id) {
        let cwd = project_root_for_commands(&workspace_state);
        let mut env_vars: HashMap<String, String> = if let Some(provider) = load_active_provider() {
            provider_to_env_vars(&provider)
        } else {
            HashMap::new()
        };

        // 从系统全局环境变量读取认证信息和代理
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
    sidecar_mgr.send(&session_id, &cmd).await
}

#[tauri::command]
pub async fn permission_response(
    session_id: String,
    id: String,
    approved: bool,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "permission_response", "id": id, "approved": approved });
    sidecar_mgr.send(&session_id, &cmd).await
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
pub async fn stop_chat_session(
    session_id: String,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    sidecar_mgr.kill(&session_id);
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
