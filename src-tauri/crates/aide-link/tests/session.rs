//! 会话 / 连接层向量表达不了的情形：背压、超大帧、订阅替换，以及「执行器本身不是空转」的自检。

use std::sync::Arc;

use aide_link::catalog::LinkPolicy;
use aide_link::conformance::run_fixture;
use aide_link::frame::{ErrorCode, HostFrame, HostInfo, Since, MAX_FRAME_BYTES, MAX_IN_FLIGHT};
use aide_link::testkit::FakeHarness;
use aide_link::{Backend, BoxFuture, Session, Subscription};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

async fn ready(h: &FakeHarness) -> (Session, UnboundedReceiver<HostFrame>) {
    let (tx, mut rx) = unbounded_channel();
    let mut s = Session::new(h.backend.clone(), h.identity.clone(), 1, tx);
    s.on_text(&json!({"type":"hello"}).to_string()).await;
    assert!(matches!(rx.recv().await, Some(HostFrame::HelloOk { .. })));
    (s, rx)
}

/// 执行器不能空转：错的期望必须被判失败。
#[tokio::test]
async fn the_conformance_runner_actually_fails_on_a_wrong_expectation() {
    let wrong = json!({"name":"wrong","steps":[
        {"send":{"type":"hello"}},
        {"expect":{"type":"hello_ok","version":2}}
    ]});
    let err = run_fixture(&FakeHarness::new(), &wrong).await.unwrap_err();
    assert!(err.contains("expected 2"), "{err}");

    let missing = json!({"name":"missing","steps":[{"expect":{"type":"pong","n":1}}]});
    assert!(run_fixture(&FakeHarness::new(), &missing).await.is_err(), "no frame was sent, expecting one must fail");

    let not_closed = json!({"name":"nc","steps":[{"send":{"type":"hello"}},{"expect":{"type":"hello_ok"}},{"expect_closed":true}]});
    assert!(run_fixture(&FakeHarness::new(), &not_closed).await.is_err());

    // 陌生人 resume 若被放行，这条断言会翻车
    let stranger_in = json!({"name":"s","channel":"none","steps":[
        {"connect":{"mode":"resume","as":"stranger"}},
        {"send":{"type":"hello"}},
        {"expect":{"type":"hello_ok"}}
    ]});
    assert!(run_fixture(&FakeHarness::new(), &stranger_in).await.is_err(), "a stranger must not get a working channel");
}

/// 超大帧：协议违规，Host 断开（不去解析它）。
#[tokio::test]
async fn oversized_frames_end_the_session() {
    let h = FakeHarness::new();
    let (tx, mut rx) = unbounded_channel();
    let mut s = Session::new(h.backend.clone(), h.identity.clone(), 1, tx);
    s.on_text(&"x".repeat(MAX_FRAME_BYTES + 1)).await;
    assert!(matches!(rx.recv().await, Some(HostFrame::Bye { code: ErrorCode::TooLarge, .. })));
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
    let mut s = Session::new(Arc::new(Hang), h.identity.clone(), 1, tx);
    s.on_text(&json!({"type":"hello"}).to_string()).await;
    let _ = rx.recv().await; // hello_ok
    for id in 1..=MAX_IN_FLIGHT as u64 {
        s.on_text(&json!({"type":"call","id":id,"method":"list_sessions"}).to_string()).await;
    }
    s.on_text(&json!({"type":"call","id":999,"method":"list_sessions"}).to_string()).await;
    match rx.recv().await {
        Some(HostFrame::Error { id: Some(999), code: ErrorCode::Busy, .. }) => {}
        other => panic!("expected busy for call 999, got {other:?}"),
    }
}

/// 订阅被替换时，旧订阅确实退掉了（不再往通道里灌事件）。
#[tokio::test]
async fn resubscribing_replaces_the_previous_subscription() {
    let h = FakeHarness::new();
    let (mut s, mut rx) = ready(&h).await;
    s.on_text(&json!({"type":"subscribe","sessions":["s1"]}).to_string()).await;
    s.on_text(&json!({"type":"subscribe","sessions":["s2"]}).to_string()).await;
    let _ = (rx.recv().await, rx.recv().await); // 两个 subscribed
    h.backend.bus.emit("chat-event", json!({"type":"x","session_id":"s1"}));
    h.backend.bus.emit("chat-event", json!({"type":"x","session_id":"s2"}));
    match rx.recv().await {
        Some(HostFrame::Event { payload, .. }) => assert_eq!(payload["session_id"], "s2"),
        other => panic!("expected only s2's event, got {other:?}"),
    }
    assert!(rx.try_recv().is_err(), "s1 was dropped by the replacement");
}
