use std::sync::Arc;
use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tauri::Manager;
use tokio_tungstenite::tungstenite::Message;

use super::bridge;
use super::protocol::{DesktopToPhone, PhoneToDesktop};
use super::{read_remote_settings, RemoteGateway};

/// 主循环：连中继 → 注册 → 桥接；断开后指数退避重连（1s → 30s 封顶）。
pub async fn run(gateway: Arc<RemoteGateway>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect_once(&gateway).await {
            Ok(()) => backoff = Duration::from_secs(1),
            Err(e) => {
                eprintln!("[remote] relay error: {e}");
                gateway.set_connected(false);
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

/// 单次连接：连中继 → 注册 → 桥接，直到断开。
async fn connect_once(gateway: &Arc<RemoteGateway>) -> Result<(), String> {
    let settings = read_remote_settings(&gateway.app_handle).await?;
    if settings.relay_url.trim().is_empty() {
        return Err("relay URL 未配置".into());
    }
    let url = format!("{}/ws", settings.relay_url.trim_end_matches('/'));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| e.to_string())?;

    // 注册（配对码过期/为空则刷新，避免配对中途换码）
    let code = gateway.pairing.lock().unwrap().ensure_valid();
    let device_id = gateway.tokens.device_id().await?;
    let register = json!({"type": "register", "device_id": device_id, "pairing_code": code});
    ws.send(Message::Text(register.to_string().into())).await.map_err(|e| e.to_string())?;
    // 只在「断开→连接」转换时打一行：Ok 路径断开不重置 connected（抖动时恒 true），
    // 无条件打印会在连接抖动（如双实例互顶）时每秒刷屏。
    let was_connected = gateway.is_connected();
    gateway.set_connected(true);
    if !was_connected {
        eprintln!("[remote] connected to relay {url}");
    }

    let (mut sink, mut stream) = ws.split();

    // 事件转发：broadcast → mpsc → 主循环 sink（sink 单写者，避免跨任务共享）
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<String>(256);
    let mut rx = gateway.app_handle
        .state::<crate::runtime::AgentRuntimeManager>()
        .inner()
        .subscribe_chat_events();
    let fwd = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            let msg = json!({"type": "event", "event": event});
            if event_tx.send(msg.to_string()).await.is_err() { break; }
        }
    });

    // 入站处理 + 事件发送合并
    let mut authed = false;
    loop {
        tokio::select! {
            Some(text) = event_rx.recv() => {
                if sink.send(Message::Text(text.into())).await.is_err() { break; }
            }
            msg = stream.next() => {
                let Some(msg) = msg else { break; };
                let Ok(msg) = msg else { break; };
                let Message::Text(text) = msg else { continue; };
                let Ok(parsed) = serde_json::from_str::<PhoneToDesktop>(&text) else { continue; };
                let action = match bridge::map_message(&parsed, authed) {
                    Ok(a) => a,
                    Err(e) => {
                        let reply = DesktopToPhone::Error { message: e };
                        let text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
                        if sink.send(Message::Text(text.into())).await.is_err() { break; }
                        continue;
                    }
                };
                match bridge::execute(gateway, action).await {
                    Ok(Some(reply)) => {
                        if matches!(reply, DesktopToPhone::PairOk { .. } | DesktopToPhone::AuthOk) {
                            authed = true;
                        }
                        let text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
                        if sink.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        let reply = DesktopToPhone::Error { message: e };
                        let text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
                        if sink.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                }
            }
        }
    }
    fwd.abort();
    Ok(())
}
