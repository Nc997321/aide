use aide_relay::state::RelayState;
use aide_relay::run;
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

async fn start_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state: Arc<Mutex<RelayState>> = Arc::new(Mutex::new(RelayState::default()));
    tokio::spawn(async move { run(listener, state).await; });
    format!("ws://{addr}")
}

#[tokio::test]
async fn bridges_frames_between_desktop_and_phone() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(Message::Text(r#"{"type":"register","device_id":"dev-1","pairing_code":"123456"}"#.into())).await.unwrap();
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(r#"{"type":"connect","code":"123456"}"#.into())).await.unwrap();
    // 手机 → 桌面
    p_ws.send(Message::Text("hello-desktop".into())).await.unwrap();
    let msg = d_ws.next().await.unwrap().unwrap();
    assert_eq!(msg, Message::Text("hello-desktop".into()));
    // 桌面 → 手机
    d_ws.send(Message::Text("hello-phone".into())).await.unwrap();
    let msg = p_ws.next().await.unwrap().unwrap();
    assert_eq!(msg, Message::Text("hello-phone".into()));
}

#[tokio::test]
async fn connect_by_device_id_after_pairing() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(Message::Text(r#"{"type":"register","device_id":"dev-2","pairing_code":"654321"}"#.into())).await.unwrap();
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(r#"{"type":"connect","device_id":"dev-2","token":"opaque"}"#.into())).await.unwrap();
    p_ws.send(Message::Text("ping".into())).await.unwrap();
    let msg = d_ws.next().await.unwrap().unwrap();
    assert_eq!(msg, Message::Text("ping".into()));
}

#[tokio::test]
async fn connect_to_unknown_device_closes() {
    let url = start_server().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(r#"{"type":"connect","code":"000000"}"#.into())).await.unwrap();
    let next = p_ws.next().await;
    assert!(next.is_none() || next.unwrap().is_err());
}

/// 回归：手机优雅断开（close 帧）后，桌面端连接必须保持，且可被下一台
/// 手机再次 connect 桥接——桌面端连接是持久服务连接，不该被手机断开拖垮。
#[tokio::test]
async fn phone_disconnect_keeps_desktop_connection_for_next_phone() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(Message::Text(r#"{"type":"register","device_id":"dev-3","pairing_code":"111222"}"#.into())).await.unwrap();
    // 手机 1：connect → 确认桥接 → 优雅断开
    let (mut p1_ws, _) = connect_async(&url).await.unwrap();
    p1_ws.send(Message::Text(r#"{"type":"connect","device_id":"dev-3"}"#.into())).await.unwrap();
    p1_ws.send(Message::Text("first".into())).await.unwrap();
    let first = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        d_ws.next(),
    ).await.expect("桥接未建立").unwrap().unwrap();
    assert_eq!(first, Message::Text("first".into()));
    p1_ws.close(None).await.unwrap();
    // 等中继处理 close（桥接结束、桌面连接归还）
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    // 手机 2：同一桌面连接必须还能再次桥接
    let (mut p2_ws, _) = connect_async(&url).await.unwrap();
    p2_ws.send(Message::Text(r#"{"type":"connect","device_id":"dev-3"}"#.into())).await.unwrap();
    p2_ws.send(Message::Text("second".into())).await.unwrap();
    let second = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        d_ws.next(),
    ).await.expect("桌面端连接在手机断开后未能保持").unwrap().unwrap();
    assert_eq!(second, Message::Text("second".into()));
}
