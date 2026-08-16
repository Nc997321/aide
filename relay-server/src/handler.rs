use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::state::SharedState;

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
            {
                let mut st = state.lock().unwrap();
                st.devices.insert(device_id.clone(), (sink, stream));
                st.codes.insert(code.clone(), device_id.clone());
            }
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
            let (mut d_sink, mut d_stream) = state.lock().unwrap()
                .devices.remove(&device_id)
                .ok_or("connect: device offline")?;
            eprintln!("bridging phone -> {device_id}");
            // 双向转发（单 task 内 select，流所有权留在本函数）：数据帧原样
            // 转发；任一侧 close/断流 → 结束桥接。
            // 手机 close 不转发——桌面端是持久服务连接，不该被手机断开拖垮；
            // 桌面端 close（下线）→ 结束桥接 → 手机连接随之关闭，感知设备离线。
            loop {
                tokio::select! {
                    msg = stream.next() => {
                        match msg {
                            Some(Ok(Message::Close(_))) => break,
                            Some(Ok(m)) => { if d_sink.send(m).await.is_err() { break; } }
                            _ => break,
                        }
                    }
                    msg = d_stream.next() => {
                        match msg {
                            Some(Ok(Message::Close(_))) => break,
                            Some(Ok(m)) => { if sink.send(m).await.is_err() { break; } }
                            _ => break,
                        }
                    }
                }
            }
            // 桥接结束：清掉配对码路由；桌面端连接归还 state 等下一次 connect
            // （若桌面端已下线则是死连接，其重连 register 会覆盖该条目）
            {
                let mut st = state.lock().unwrap();
                st.codes.retain(|_, v| v != &device_id);
                st.devices.insert(device_id.clone(), (d_sink, d_stream));
            }
            Ok(())
        }
        _ => Err("unknown first message type".into()),
    }
}
