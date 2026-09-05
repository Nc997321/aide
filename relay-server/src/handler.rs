use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::state::{Claim, SharedState, WsSink, WsStream};

/// 单连接处理：首条消息必须是 register（桌面）或 connect（手机）。
pub async fn handle_conn(stream: TcpStream, state: SharedState) -> Result<(), String> {
    let ws = accept_async(stream).await.map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();
    let first = stream.next().await.ok_or("closed before first message")?
        .map_err(|e| e.to_string())?;
    let text = match first {
        Message::Text(t) => t.to_string(),
        _ => return Err("first message must be text".into()),
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("register") => {
            let device_id = v.get("device_id").and_then(|s| s.as_str())
                .ok_or("register: missing device_id")?.to_string();
            let code = v.get("pairing_code").and_then(|s| s.as_str())
                .ok_or("register: missing pairing_code")?.to_string();
            park_device(&state, device_id.clone(), Some(code), sink, stream);
            eprintln!("registered device {device_id}");
            Ok(())
        }
        Some("connect") => {
            let device_id = if let Some(code) = v.get("code").and_then(|s| s.as_str()) {
                state.lock().unwrap().codes.get(code).cloned()
            } else {
                v.get("device_id").and_then(|s| s.as_str()).map(|s| s.to_string())
            };
            let device_id = device_id.ok_or("connect: unknown device")?;
            let (mut d_sink, mut d_stream) = claim_device(&state, &device_id).await?;
            eprintln!("bridging phone -> {device_id}");
            // 双向转发（单 task 内 select，流所有权留在本函数）：数据帧原样
            // 转发；任一侧 close/断流 → 结束桥接。
            // 手机 close 不转发——桌面端是持久服务连接，不该被手机断开拖垮；
            // 桌面端 close（下线）→ 结束桥接 → 手机连接随之关闭，感知设备离线。
            let desktop_alive = bridge(&mut sink, &mut stream, &mut d_sink, &mut d_stream).await;
            // 桥接结束：清掉配对码路由；桌面端若仍健康且期间没有重连换新连接，
            // 归还路由表继续由看守任务托管
            let can_park = {
                let mut st = state.lock().unwrap();
                st.codes.retain(|_, v| v != &device_id);
                desktop_alive && !st.devices.contains_key(&device_id)
            };
            if can_park {
                park_device(&state, device_id.clone(), None, d_sink, d_stream);
            }
            Ok(())
        }
        _ => Err("unknown first message type".into()),
    }
}

/// 把桌面连接放进路由表，并挂上看守任务。
/// 关键：tungstenite 读到 Ping 只是把 Pong 排进 additional 队列
/// （tungstenite protocol/mod.rs），真正刷出 socket 要等下一次 read poll
/// 开头（tokio-tungstenite 的 poll_read 自身不 flush）。不持续 poll 读侧，
/// Ping 得不到回应、close 无人察觉，连接就成了僵尸。
fn park_device(
    state: &SharedState,
    device_id: String,
    pairing_code: Option<String>,
    sink: WsSink,
    stream: WsStream,
) {
    let (claim_tx, claim_rx) = mpsc::channel::<Claim>(1);
    let gen = {
        let mut st = state.lock().unwrap();
        if let Some(code) = pairing_code {
            st.codes.insert(code, device_id.clone());
        }
        st.insert_device(device_id.clone(), claim_tx)
    };
    tokio::spawn(device_watcher(device_id, gen, sink, stream, claim_rx, state.clone()));
}

/// 从路由表领回桌面连接：请求看守任务交还 (sink, stream)
async fn claim_device(state: &SharedState, device_id: &str) -> Result<(WsSink, WsStream), String> {
    let (gen, claim_tx) = {
        let st = state.lock().unwrap();
        let c = st.devices.get(device_id)
            .ok_or_else(|| "connect: device offline".to_string())?;
        (c.gen, c.claim.clone())
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    // 看守已退（连接关闭但登记未清）→ 离线
    if claim_tx.send(reply_tx).await.is_err() {
        state.lock().unwrap().remove_device_if(device_id, gen);
        return Err("connect: device offline".into());
    }
    let halves = reply_rx.await;
    state.lock().unwrap().remove_device_if(device_id, gen);
    halves.map_err(|_| "connect: device offline".to_string())
}

/// 看守任务：托管空闲的桌面连接。
/// - 读到 Ping：tungstenite 已自动排好 Pong，下一轮 poll 读开始时 flush 出去；
/// - 读到 close / 出错 / 对端消失：连接完蛋，从路由表摘除自己；
/// - 收到 connect 认领：把连接交还后退出。
async fn device_watcher(
    device_id: String,
    gen: u64,
    mut sink: WsSink,
    mut stream: WsStream,
    mut claim_rx: mpsc::Receiver<Claim>,
    state: SharedState,
) {
    loop {
        tokio::select! {
            claimed = claim_rx.recv() => {
                match claimed {
                    Some(reply) => {
                        // 队列里若有残留的 Pong，桥接循环首轮 poll 读会 flush，无需在此等
                        let _ = reply.send((sink, stream));
                        return;
                    }
                    None => return, // 路由表条目被覆盖（重连换新连接）或服务关闭
                }
            }
            msg = stream.next() => match msg {
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                // 桌面优雅下线：close 应答已排队，刷出去再摘除登记
                Some(Ok(Message::Close(_))) => {
                    let _ = tokio::time::timeout(Duration::from_secs(2), sink.flush()).await;
                    break;
                }
                // 空闲期间不该有数据帧：丢弃，不掐连接
                Some(Ok(_)) => {
                    eprintln!("relay: idle device {device_id} sent data frame, dropped");
                }
                _ => break, // Err / None
            }
        }
    }
    state.lock().unwrap().remove_device_if(&device_id, gen);
}

/// 双向转发循环。返回桌面侧是否仍存活（存活 = 可归还路由表等待下一次 connect）。
async fn bridge(
    sink: &mut WsSink,
    stream: &mut WsStream,
    d_sink: &mut WsSink,
    d_stream: &mut WsStream,
) -> bool {
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Close(_))) => {
                    // 手机优雅断开：把 tungstenite 排队的 close 应答刷出去，握手收尾
                    let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
                    return true;
                }
                Some(Ok(m)) => {
                    if d_sink.send(m).await.is_err() { return false; }
                }
                _ => return true, // 手机侧断了：桌面侧未见异常，交还看守验证
            },
            msg = d_stream.next() => match msg {
                Some(Ok(Message::Close(_))) => {
                    // 桌面下线：回 close 应答，连接不归还
                    let _ = tokio::time::timeout(Duration::from_secs(2), d_sink.close()).await;
                    return false;
                }
                Some(Ok(m)) => {
                    if sink.send(m).await.is_err() { return true; }
                }
                _ => return false, // 桌面侧断流/出错
            },
        }
    }
}
