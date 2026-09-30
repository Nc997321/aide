use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{DesktopToPhone, PhoneToDesktop};
use super::{read_remote_settings, rpc, RemoteGateway};

/// 稳定连接判据：连接存活 ≥ 该时长才重置退避。短命连接（被同 device_id 的新
/// register 顶替、注册后秒断）视同失败并入指数退避——2026-09-18 实测双实例
/// （安装版 + dev 版共用同一 settings.json 的 device_id）在 relay 互踢，旧实现
/// Ok 路径无 sleep 的立即重连把互踢放大成 ~500 注册/秒、六天 6.5GB 日志。
const STABLE_CONN_SECS: u64 = 30;

/// 主循环：连中继 → 注册 → 桥接；断开后指数退避重连（1s → 30s 封顶）。
/// - 稳定连接断开（中继重启类瞬断）：退避重置，保持旧行为立即重连；
/// - 短命连接 / 连接失败：至少停满当前退避再试，且退避照常翻倍——
///   任何秒断病理都烧不成热循环。
pub async fn run(gateway: Arc<RemoteGateway>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = std::time::Instant::now();
        match connect_once(&gateway).await {
            Ok(()) if started.elapsed() >= Duration::from_secs(STABLE_CONN_SECS) => {
                backoff = Duration::from_secs(1);
                continue;
            }
            Ok(()) => {}
            Err(e) => {
                eprintln!("[remote] relay error: {e}");
                gateway.set_connected(false);
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// 单次连接：连中继 → 注册 → 桥接，直到断开。
async fn connect_once(gateway: &Arc<RemoteGateway>) -> Result<(), String> {
    let settings = read_remote_settings(&gateway.app_handle).await?;
    if settings.relay_url.trim().is_empty() {
        return Err("relay URL 未配置".into());
    }
    let url = format!("{}/ws", settings.relay_url.trim_end_matches('/'));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| e.to_string())?;

    // 防陈旧：清掉断连期积压的换码宣告——它们若在新连接 register 之后发出，
    // 会把刚注册的新码从中继码路由里清掉
    gateway.codes.clear_pending();
    // 注册（配对码过期/为空则刷新，避免配对中途换码）
    let code = super::lock_recover(&gateway.pairing).ensure_valid();
    let device_id = gateway.tokens.device_id().await?;
    let register = json!({"type": "register", "device_id": device_id, "pairing_code": code});
    ws.send(Message::Text(register.to_string()))
        .await
        .map_err(|e| e.to_string())?;
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
    let mut rx = gateway
        .app_handle
        .state::<std::sync::Arc<aide_core::Core>>()
        .runtime
        .subscribe_chat_events();
    let fwd = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            let msg = json!({"type": "event", "event": event});
            if event_tx.send(msg.to_string()).await.is_err() {
                break;
            }
        }
    });

    // 入站处理 + 事件发送合并
    let mut authed = false;
    loop {
        tokio::select! {
            Some(text) = event_rx.recv() => {
                if sink.send(Message::Text(text)).await.is_err() { break; }
            }
            // 中途换码宣告（设置面板「刷新」）：帧形状与 relay-server/src/protocol.rs
            // 的 update_code_of 守卫镜像对账
            code = gateway.codes.take() => {
                let frame = json!({ "type": "update_code", "code": code });
                if sink.send(Message::Text(frame.to_string())).await.is_err() { break; }
            }
            msg = stream.next() => {
                let Some(msg) = msg else { break; };
                let Ok(msg) = msg else { break; };
                let Message::Text(text) = msg else { continue; };
                let Ok(parsed) = serde_json::from_str::<PhoneToDesktop>(&text) else { continue; };
                if let Some(reply) = handle_message(gateway, parsed, &mut authed).await {
                    let text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
                    if sink.send(Message::Text(text)).await.is_err() { break; }
                }
            }
        }
    }
    fwd.abort();
    Ok(())
}

/// 入站消息处理（pair/auth 是连接生命周期；invoke 走 RPC 注册表白名单）。
/// 返回要回给手机的应答（None = 无应答）。
async fn handle_message(
    gateway: &Arc<RemoteGateway>,
    msg: PhoneToDesktop,
    authed: &mut bool,
) -> Option<DesktopToPhone> {
    match msg {
        PhoneToDesktop::Pair { code } => {
            if !super::lock_recover(&gateway.pairing).validate(&code) {
                return Some(DesktopToPhone::AuthError {
                    message: "配对码无效或已过期".into(),
                });
            }
            // 签发长期 token + 取设备 id；任一步失败都按配对失败回（可重试）
            let reply = match gateway.tokens.issue() {
                Ok(token) => match gateway.tokens.device_id().await {
                    Ok(device_id) => {
                        *authed = true;
                        DesktopToPhone::PairOk { device_id, token }
                    }
                    Err(e) => DesktopToPhone::AuthError { message: e },
                },
                Err(e) => DesktopToPhone::AuthError { message: e },
            };
            Some(reply)
        }
        PhoneToDesktop::Auth { token } => {
            if gateway.tokens.validate(&token) {
                *authed = true;
                Some(DesktopToPhone::AuthOk)
            } else {
                Some(DesktopToPhone::AuthError {
                    message: "token 无效".into(),
                })
            }
        }
        PhoneToDesktop::Invoke {
            id,
            command,
            params,
        } => {
            if !*authed {
                return Some(DesktopToPhone::InvokeErr {
                    id,
                    error: "未认证：请先配对".into(),
                });
            }
            let reply = match rpc::dispatch(gateway.app_handle.clone(), &command, params) {
                Some(call) => match call.await {
                    Ok(payload) => DesktopToPhone::InvokeOk { id, payload },
                    Err(error) => DesktopToPhone::InvokeErr { id, error },
                },
                None => DesktopToPhone::InvokeErr {
                    id,
                    error: format!("未知命令（不在远程白名单）: {command}"),
                },
            };
            Some(reply)
        }
    }
}
