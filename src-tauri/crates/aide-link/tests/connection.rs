//! 整条协议栈（握手 → 加密 → 会话）的端到端：大帧分块往返、终止帧在关连接前确实送达。

use aide_link::client::RefClient;
use aide_link::secure::{Mode, WireFrame};
use aide_link::testkit::{FakeHarness, PHONE_A_SECRET};
use aide_link::Connection;
use aide_link::identity::keypair_from_private;
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

async fn connected(h: &FakeHarness) -> (Connection, UnboundedReceiver<WireFrame>, RefClient) {
    let (tx, mut rx) = unbounded_channel();
    let mut conn = Connection::new(h.backend.clone(), h.identity.clone(), tx);
    let phone = keypair_from_private(PHONE_A_SECRET);
    let (init, pending) = RefClient::begin(Mode::Resume, &phone, &h.identity.host_public(), h.identity.device_id(), None, &[1]).unwrap();
    conn.on_wire_text(&serde_json::to_string(&init).unwrap()).await;
    let resp = rx.recv().await.expect("sc_resp");
    (conn, rx, pending.complete(&resp).expect("handshake"))
}

async fn send(conn: &mut Connection, client: &mut RefClient, frame: Value) {
    for w in client.seal_frame(&frame) {
        conn.on_wire_text(&serde_json::to_string(&w).unwrap()).await;
    }
}

async fn recv(rx: &mut UnboundedReceiver<WireFrame>, client: &mut RefClient) -> Value {
    loop {
        let w = rx.recv().await.expect("wire frame");
        if let Some(v) = client.open(&w).unwrap() {
            return v;
        }
    }
}

/// 一个 Link 帧远大于单块（32 KiB）：两个方向都要分块、重组，内容一字不差。
#[tokio::test]
async fn frames_larger_than_a_chunk_cross_the_encrypted_channel_intact() {
    let h = FakeHarness::new();
    let (mut conn, mut rx, mut client) = connected(&h).await;
    send(&mut conn, &mut client, json!({"type":"hello"})).await;
    assert_eq!(recv(&mut rx, &mut client).await["type"], "hello_ok");

    let big = "界".repeat(100_000); // 300 KB 的 UTF-8
    send(&mut conn, &mut client, json!({"type":"call","id":1,"method":"get_settings","params":{"blob": big}})).await;
    let reply = recv(&mut rx, &mut client).await;
    assert_eq!(reply["type"], "result");
    assert_eq!(reply["value"]["blob"].as_str().unwrap(), big);
}

/// 终止帧：Host 踢人时，`flush` 之后 `bye` 已加密进了线上通道——驱动方据此先发完再关连接。
#[tokio::test]
async fn the_final_bye_reaches_the_wire_before_the_connection_closes() {
    let h = FakeHarness::new();
    let (mut conn, mut rx, mut client) = connected(&h).await;
    send(&mut conn, &mut client, json!({"type":"hello"})).await;
    let _ = recv(&mut rx, &mut client).await;
    send(&mut conn, &mut client, json!({"type":"call","id":1,"method":"link.unpair","params":{}})).await;
    assert!(conn.is_closed());
    conn.flush().await;
    assert_eq!(recv(&mut rx, &mut client).await["type"], "result");
    let bye = recv(&mut rx, &mut client).await;
    assert_eq!((bye["type"].as_str(), bye["code"].as_str()), (Some("bye"), Some("revoked")));
}
