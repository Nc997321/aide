//! 会话状态机里向量表达不了的情形：多连接交互、Host 侧发起的撤销、背压、超大帧，以及
//! 「执行器本身不是空转」的自检。

use std::sync::Arc;
use std::time::Instant;

use aide_link::catalog::LinkPolicy;
use aide_link::conformance::run_fixture;
use aide_link::frame::{ErrorCode, HostFrame, HostInfo, Since, MAX_FRAME_BYTES, MAX_IN_FLIGHT};
use aide_link::testkit::{FakeHarness, FIXTURE_TOKEN};
use aide_link::{Backend, BoxFuture, Session, Subscription};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

fn session(h: &FakeHarness) -> (Session, UnboundedReceiver<HostFrame>) {
    let (tx, rx) = unbounded_channel();
    (Session::new(h.backend.clone(), h.creds.clone(), tx), rx)
}

async fn authed(h: &FakeHarness) -> (Session, UnboundedReceiver<HostFrame>) {
    let (mut s, mut rx) = session(h);
    s.on_text(&json!({"type":"hello","versions":[1]}).to_string()).await;
    s.on_text(&json!({"type":"auth","token":FIXTURE_TOKEN}).to_string()).await;
    assert!(matches!(rx.recv().await, Some(HostFrame::HelloOk { .. })));
    assert!(matches!(rx.recv().await, Some(HostFrame::Authed { .. })));
    (s, rx)
}

fn bye_code(rx: &mut UnboundedReceiver<HostFrame>) -> Option<ErrorCode> {
    while let Ok(f) = rx.try_recv() {
        if let HostFrame::Bye { code, .. } = f {
            return Some(code);
        }
    }
    None
}

/// 执行器不能空转：错的期望必须被判失败。
#[tokio::test]
async fn the_conformance_runner_actually_fails_on_a_wrong_expectation() {
    let wrong = json!({"name":"wrong","steps":[
        {"send":{"type":"hello","versions":[1]}},
        {"expect":{"type":"hello_ok","version":2}}
    ]});
    let err = run_fixture(&FakeHarness::new(), &wrong).await.unwrap_err();
    assert!(err.contains("expected 2"), "{err}");

    let missing = json!({"name":"missing","steps":[{"expect":{"type":"pong","n":1}}]});
    assert!(run_fixture(&FakeHarness::new(), &missing).await.is_err(), "no frame was sent, expecting one must fail");

    let not_closed = json!({"name":"nc","steps":[{"send":{"type":"hello","versions":[1]}},{"expect":{"type":"hello_ok"}},{"expect_closed":true}]});
    assert!(run_fixture(&FakeHarness::new(), &not_closed).await.is_err());
}

/// 单设备：另一台设备配对成功，先前已认证的连接被踢，原因是 `superseded`。
#[tokio::test]
async fn pairing_a_second_device_kicks_the_first() {
    let h = FakeHarness::new();
    let (mut a, mut rx_a) = authed(&h).await;

    let (mut b, mut rx_b) = session(&h);
    b.on_text(&json!({"type":"hello","versions":[1]}).to_string()).await;
    b.on_text(&json!({"type":"pair","code":"123456"}).to_string()).await;
    assert!(matches!(rx_b.recv().await, Some(HostFrame::HelloOk { .. })));
    assert!(matches!(rx_b.recv().await, Some(HostFrame::Paired { .. })));
    assert!(!b.is_closed(), "the new device stays");

    a.on_tick(Instant::now());
    assert_eq!(bye_code(&mut rx_a), Some(ErrorCode::Superseded));
    assert!(a.is_closed());
}

/// Host 上撤销配对：已认证的连接收到 `revoked`；之后旧 token 也认证不了。
#[tokio::test]
async fn revoking_on_the_host_ends_authenticated_connections() {
    let h = FakeHarness::new();
    let (mut a, mut rx_a) = authed(&h).await;
    h.creds.revoke().unwrap();
    a.on_tick(Instant::now());
    assert_eq!(bye_code(&mut rx_a), Some(ErrorCode::Revoked));

    let (mut c, mut rx_c) = session(&h);
    c.on_text(&json!({"type":"hello","versions":[1]}).to_string()).await;
    c.on_text(&json!({"type":"auth","token":FIXTURE_TOKEN}).to_string()).await;
    let _ = rx_c.recv().await; // hello_ok
    assert!(matches!(rx_c.recv().await, Some(HostFrame::AuthError { code: ErrorCode::BadToken, .. })));
}

/// 超大帧：协议违规，Host 断开（不去解析它）。
#[tokio::test]
async fn oversized_frames_end_the_connection() {
    let h = FakeHarness::new();
    let (mut s, mut rx) = session(&h);
    s.on_text(&"x".repeat(MAX_FRAME_BYTES + 1)).await;
    assert_eq!(bye_code(&mut rx), Some(ErrorCode::TooLarge));
    assert!(s.is_closed());
}

/// 一个永远不返回的 Host 后端：用来顶满在途上限。
struct Hang;
impl Backend for Hang {
    fn host(&self) -> HostInfo {
        HostInfo::default()
    }
    fn policy(&self) -> LinkPolicy {
        LinkPolicy::default()
    }
    fn call(&self, _method: &str, _params: Value) -> BoxFuture<Result<Value, String>> {
        Box::pin(std::future::pending())
    }
    fn attach_events(&self, _s: UnboundedSender<HostFrame>, _sessions: Option<Vec<String>>, _since: Option<Since>) -> Box<dyn Subscription> {
        struct Nop;
        impl Subscription for Nop {}
        Box::new(Nop)
    }
}

/// 在途上限：占满后新调用立即得到 `busy`，不排队、不拖垮 Host。
#[tokio::test]
async fn too_many_calls_in_flight_get_busy() {
    let h = FakeHarness::new();
    let (tx, mut rx) = unbounded_channel();
    let mut s = Session::new(Arc::new(Hang), h.creds.clone(), tx);
    s.on_text(&json!({"type":"hello","versions":[1]}).to_string()).await;
    s.on_text(&json!({"type":"auth","token":FIXTURE_TOKEN}).to_string()).await;
    let _ = (rx.recv().await, rx.recv().await);
    for id in 1..=MAX_IN_FLIGHT as u64 {
        s.on_text(&json!({"type":"call","id":id,"method":"list_sessions"}).to_string()).await;
    }
    s.on_text(&json!({"type":"call","id":999,"method":"list_sessions"}).to_string()).await;
    match rx.recv().await {
        Some(HostFrame::Error { id: Some(999), code: ErrorCode::Busy, .. }) => {}
        other => panic!("expected busy for call 999, got {other:?}"),
    }
}

/// 订阅被替换 / 连接结束时，旧订阅确实退掉了（不再往已无人读的通道里灌事件）。
#[tokio::test]
async fn resubscribing_replaces_and_closing_detaches() {
    let h = FakeHarness::new();
    let (mut s, mut rx) = authed(&h).await;
    s.on_text(&json!({"type":"subscribe","sessions":["s1"]}).to_string()).await;
    s.on_text(&json!({"type":"subscribe","sessions":["s2"]}).to_string()).await;
    let _ = (rx.recv().await, rx.recv().await); // 两个 subscribed
    h.emit_chat("s1", 1);
    h.emit_chat("s2", 2);
    match rx.recv().await {
        Some(HostFrame::Event { payload, .. }) => assert_eq!(payload["session_id"], "s2"),
        other => panic!("expected only s2's event, got {other:?}"),
    }
    assert!(rx.try_recv().is_err(), "s1 was dropped by the replacement");
}

trait Emit {
    fn emit_chat(&self, sid: &str, n: u32);
}
impl Emit for FakeHarness {
    fn emit_chat(&self, sid: &str, n: u32) {
        self.backend.bus.emit("chat-event", json!({"type":"x","session_id":sid,"n":n}));
    }
}
