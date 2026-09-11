use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::commands::settings::public_settings;
use crate::remote::RemoteGateway;
use crate::settings::{SettingsScope, SettingsService};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub relay_url: String,
    pub device_id: String,
    pub pairing_code: Option<String>,
    pub connected: bool,
    pub token_configured: bool,
    /// token 签发时刻（Unix 毫秒）。旧版签发的 token 无此记录 → None。
    pub token_issued_at: Option<i64>,
}

/// 设置面板状态快照。secrets 读取是同步 IO，与 public_settings 一起包进
/// spawn_blocking（对齐现有 get_settings 的模式）。
#[tauri::command]
pub async fn remote_get_status(app: AppHandle) -> Result<RemoteStatus, String> {
    let gateway = app.state::<Arc<RemoteGateway>>().inner().clone();
    let service = app.state::<Arc<SettingsService>>();
    let service2 = service.inner().clone();
    let gateway2 = gateway.clone();
    let (settings, token_configured, token_issued_at) = tokio::task::spawn_blocking(move || {
        let settings = public_settings(&service2)?;
        let token_configured = service2
            .secrets()
            .get("remote/token")
            .map_err(|e| e.to_string())?
            .is_some();
        // 无 token 时不必读时间戳；有 token 但无记录（旧版签发）→ None
        let token_issued_at = if token_configured {
            gateway2.tokens.issued_at()
        } else {
            None
        };
        Ok::<_, String>((settings, token_configured, token_issued_at))
    })
    .await
    .map_err(|e| e.to_string())??;
    let pairing_code = gateway.pairing.lock().unwrap().current();
    Ok(RemoteStatus {
        enabled: settings.remote.enabled,
        relay_url: settings.remote.relay_url,
        device_id: settings.remote.device_id,
        pairing_code,
        connected: gateway.is_connected(),
        token_configured,
        token_issued_at,
    })
}

/// 开关远程控制：写设置 + 启停网关。
#[tauri::command]
pub async fn remote_set_enabled(enabled: bool, app: AppHandle) -> Result<(), String> {
    let service = app.state::<Arc<SettingsService>>();
    let service2 = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        service2
            .mutate_scope_blocking(SettingsScope::User, None, |document| {
                let target = document
                    .values
                    .entry("settings".to_string())
                    .or_insert_with(|| serde_json::json!({}));
                let target = target.as_object_mut().ok_or_else(|| {
                    crate::settings::SettingsError::Validation(
                        "settings must be an object".to_string(),
                    )
                })?;
                let remote = target
                    .entry("remote".to_string())
                    .or_insert_with(|| serde_json::json!({}));
                remote["enabled"] = serde_json::json!(enabled);
                Ok(())
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let gateway = app.state::<Arc<RemoteGateway>>().inner().clone();
    if enabled {
        gateway.start();
    } else {
        gateway.stop();
    }
    Ok(())
}

/// 刷新配对码（设置面板「刷新」按钮）。
#[tauri::command]
pub async fn remote_refresh_pairing_code(app: AppHandle) -> Result<String, String> {
    let gateway = app.state::<Arc<RemoteGateway>>().inner().clone();
    let code = gateway.pairing.lock().unwrap().refresh();
    // 上报中继：旧实装只改本地 PairingState，relay 码路由里还是旧码，
    // 刷新后的新码对手机永远 unknown device
    gateway.announce_code(code.clone());
    Ok(code)
}

/// 吊销所有远程设备（清 token）。
#[tauri::command]
pub async fn remote_revoke(app: AppHandle) -> Result<(), String> {
    let gateway = app.state::<Arc<RemoteGateway>>().inner().clone();
    gateway.tokens.revoke()
}
