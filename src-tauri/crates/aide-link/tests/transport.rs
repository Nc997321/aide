//! 传输适配器端到端（真 WebSocket，真中继）：手机一侧用参考客户端，Host 一侧是 `aide_link::transport`。
//! 需要 `transport` 特性（本 crate 的 dev-dependency 已打开）。

use std::sync::Arc;
use std::time::Duration;

use aide_link::client::RefClient;
use aide_link::identity::keypair_from_private;
use aide_link::secure::{Mode, WireFrame};
use aide_link::testkit::{FakeHarness, OFFER_PSK, PHONE_A_SECRET, PHONE_B_SECRET};
use aide_link::transport::relay::{register_frame, RelayStatus};
use aide_link::transport::{direct, relay, LinkHost};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn host(h: &FakeHarness) -> LinkHost {
    LinkHost::new(h.backend.clone(), h.identity.clone())
}

/// 手机一侧：一条 WebSocket + 参考客户端。
struct Phone {
    ws: Ws,
    client: RefClient,
}

impl Phone {
    /// `relay_device`：经中继时先发中继层 connect。`mode` / `secret`：用谁的密钥、怎么握手。
    async fn connect(url: &str, h: &FakeHarness, relay_device: Option<&str>, mode: Mode, secret: [u8; 32]) -> Result<Phone, String> {
        let (mut ws, _) = connect_async(url).await.map_err(|e| e.to_string())?;
        if let Some(id) = relay_device {
            ws.send(Message::Text(json!({"type":"connect","device_id":id}).to_string())).await.unwrap();
        }
        let phone = keypair_from_private(secret);
        let psk = (mode == Mode::Pair).then_some(OFFER_PSK);
        let (init, pending) =
            RefClient::begin(mode, &phone, &h.identity.host_public(), h.identity.device_id(), psk.as_ref(), &[1])?;
        ws.send(Message::Text(serde_json::to_string(&init).unwrap())).await.unwrap();
        let resp = next_wire(&mut ws).await?;
        let client = match &resp {
            WireFrame::ScResp { .. } => pending.complete(&resp)?,
            WireFrame::ScErr { code, .. } => return Err(format!("sc_err {code:?}")),
            other => return Err(format!("unexpected {other:?}")),
        };
        Ok(Phone { ws, client })
    }

    async fn send(&mut self, frame: Value) {
        for w in self.client.seal_frame(&frame) {
            self.ws.send(Message::Text(serde_json::to_string(&w).unwrap())).await.unwrap();
        }
    }

    async fn recv(&mut self) -> Value {
        loop {
            let w = next_wire(&mut self.ws).await.expect("wire frame");
            if let Some(v) = self.client.open(&w).expect("decrypt") {
                return v;
            }
        }
    }

    async fn call(&mut self, id: u64, method: &str) -> Value {
        self.send(json!({"type":"call","id":id,"method":method,"params":{}})).await;
        self.recv().await
    }
}

async fn next_wire(ws: &mut Ws) -> Result<WireFrame, String> {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .map_err(|_| "timed out".to_string())?
            .ok_or("closed")?
            .map_err(|e| e.to_string())?;
        if let Message::Text(t) = m {
            return serde_json::from_str(&t).map_err(|e| e.to_string());
        }
    }
}

async fn start_direct(h: &FakeHarness) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(direct::serve(listener, host(h)));
    format!("ws://{addr}/")
}

/// 直连：扫码配对 → 调用 → 订阅收事件；之后用 resume 重连。
#[tokio::test]
async fn direct_pairing_then_calls_events_and_resume() {
    let h = FakeHarness::new();
    h.identity.seed_for_test(None, Some(OFFER_PSK)); // 全新的 Host：没有已配对的手机
    let url = start_direct(&h).await;

    let mut p = Phone::connect(&url, &h, None, Mode::Pair, PHONE_B_SECRET).await.expect("pair handshake");
    p.send(json!({"type":"hello"})).await;
    assert_eq!(p.recv().await["type"], "hello_ok");
    assert!(h.identity.is_authorized(&keypair_from_private(PHONE_B_SECRET).public), "paired after the first valid frame");
    assert_eq!(p.call(1, "list_sessions").await["value"], json!(["s1", "s2"]));

    p.send(json!({"type":"subscribe","sessions":null})).await;
    assert_eq!(p.recv().await["type"], "subscribed");
    h.backend.bus.emit("chat-event", json!({"type":"x","session_id":"s1"}));
    let ev = p.recv().await;
    assert_eq!((ev["type"].as_str(), ev["seq"].as_u64()), (Some("event"), Some(1)));
    drop(p);

    // 之后用 resume 重连：不再需要二维码
    let mut again = Phone::connect(&url, &h, None, Mode::Resume, PHONE_B_SECRET).await.expect("resume handshake");
    again.send(json!({"type":"hello"})).await;
    assert_eq!(again.recv().await["type"], "hello_ok");
}

/// 直连：陌生手机不能 resume，且直连不允许在一条连接上二次握手（Host 终止即关连接）。
#[tokio::test]
async fn direct_rejects_strangers_and_closes_after_a_host_termination() {
    let h = FakeHarness::new();
    let url = start_direct(&h).await;
    let err = Phone::connect(&url, &h, None, Mode::Resume, [0x77; 32]).await.err().expect("must be refused");
    assert!(err.contains("Unauthorized"), "{err}");

    let mut p = Phone::connect(&url, &h, None, Mode::Resume, PHONE_A_SECRET).await.unwrap();
    p.send(json!({"type":"hello"})).await;
    let _ = p.recv().await;
    p.send(json!({"type":"call","id":1,"method":"link.unpair","params":{}})).await;
    let _ = p.recv().await; // result
    assert_eq!(p.recv().await["code"], "revoked");
    // Host 终止 → 连接被关
    let end = tokio::time::timeout(Duration::from_secs(3), async { loop { match p.ws.next().await { None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break, _ => {} } } }).await;
    assert!(end.is_ok(), "the Host must close a direct connection it terminated");
}

async fn start_relay() -> String {
    use aide_relay::state::RelayState;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(std::sync::Mutex::new(RelayState::default()));
    tokio::spawn(async move { aide_relay::run(listener, state).await });
    format!("ws://{addr}")
}

async fn wait_registered(status: &RelayStatus) {
    for _ in 0..50 {
        if status.connected() {
            tokio::time::sleep(Duration::from_millis(100)).await; // 中继处理完 register
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("Host never registered with the relay: {}", status.last_error());
}

/// 经真实中继：Host 出站注册控制腿（无配对码），手机按 device_id 寻址 → Host 拨回专属桥接腿 → 握手 → 调用；
/// 手机离开后下一次连接是**新的**桥接腿；另一台手机配对会顶掉前一台。
#[tokio::test]
async fn through_a_real_relay_sessions_restart_and_supersede() {
    let relay_url = start_relay().await;
    let h = FakeHarness::new();
    let status = Arc::new(RelayStatus::default());
    tokio::spawn(relay::run(host(&h), relay_url.clone(), Arc::clone(&status)));
    wait_registered(&status).await;
    let ws_url = relay::ws_url(&relay_url);
    let id = h.identity.device_id().to_string();

    // 手机 A 恢复
    let mut a = Phone::connect(&ws_url, &h, Some(&id), Mode::Resume, PHONE_A_SECRET).await.expect("A resumes");
    a.send(json!({"type":"hello"})).await;
    assert_eq!(a.recv().await["type"], "hello_ok");
    assert_eq!(a.call(1, "list_sessions").await["value"], json!(["s1", "s2"]));

    // A 离开（桥接腿随之被关）；A 再来一次——新的桥接腿、新的会话
    a.ws.close(None).await.ok();
    drop(a);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut a2 = Phone::connect(&ws_url, &h, Some(&id), Mode::Resume, PHONE_A_SECRET).await.expect("A resumes again on a fresh bridge leg");
    a2.send(json!({"type":"hello"})).await;
    assert_eq!(a2.recv().await["type"], "hello_ok");

    // 手机 B 扫码配对（有效二维码）→ A 的连接被顶掉
    a2.ws.close(None).await.ok();
    drop(a2);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut b = Phone::connect(&ws_url, &h, Some(&id), Mode::Pair, PHONE_B_SECRET).await.expect("B pairs");
    b.send(json!({"type":"hello"})).await;
    assert_eq!(b.recv().await["type"], "hello_ok");
    b.ws.close(None).await.ok();
    drop(b);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let a3 = Phone::connect(&ws_url, &h, Some(&id), Mode::Resume, PHONE_A_SECRET).await.err().expect("A was superseded");
    assert!(a3.contains("Unauthorized"), "{a3}");
}

/// 中继在场也看不到内容：线上只有 sc_* 外层帧，没有任何 Link 帧 / 方法名 / 配对秘密的明文。
#[tokio::test]
async fn the_relay_only_ever_sees_ciphertext() {
    let relay_url = start_relay().await;
    let h = FakeHarness::new();
    let status = Arc::new(RelayStatus::default());
    tokio::spawn(relay::run(host(&h), relay_url.clone(), Arc::clone(&status)));
    wait_registered(&status).await;

    // 在 Host 与中继之间插一个「窃听」：改成手机经窃听代理连中继，代理记录全部文本
    let tap = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tap_addr = tap.local_addr().unwrap();
    let upstream = relay::ws_url(&relay_url);
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let seen2 = Arc::clone(&seen);
    tokio::spawn(async move {
        let (sock, _) = tap.accept().await.unwrap();
        let phone_side = tokio_tungstenite::accept_async(sock).await.unwrap();
        let (relay_side, _) = connect_async(upstream.as_str()).await.unwrap();
        let (mut ps, mut pr) = phone_side.split();
        let (mut rs, mut rr) = relay_side.split();
        let a = async { while let Some(Ok(m)) = pr.next().await { if let Message::Text(t) = &m { seen2.lock().unwrap().push(t.clone()); } if rs.send(m).await.is_err() { break; } } };
        let seen3 = Arc::clone(&seen2);
        let b = async { while let Some(Ok(m)) = rr.next().await { if let Message::Text(t) = &m { seen3.lock().unwrap().push(t.clone()); } if ps.send(m).await.is_err() { break; } } };
        tokio::join!(a, b);
    });

    let id = h.identity.device_id().to_string();
    let mut p = Phone::connect(&format!("ws://{tap_addr}/"), &h, Some(&id), Mode::Resume, PHONE_A_SECRET).await.unwrap();
    p.send(json!({"type":"hello"})).await;
    let _ = p.recv().await;
    assert_eq!(p.call(1, "list_sessions").await["value"], json!(["s1", "s2"]));

    let wire = seen.lock().unwrap().join("\n");
    assert!(wire.contains("sc_init") && wire.contains("\"sc\""), "the handshake and encrypted frames do cross the relay");
    for secret in ["list_sessions", "hello_ok", "\"s1\"", "call", "fake-host"] {
        assert!(!wire.contains(secret), "relay saw plaintext `{secret}`:\n{wire}");
    }
    // 配对密钥（psk）与私钥从不上线
    let psk_b64 = aide_link::secure::b64(&OFFER_PSK);
    assert!(!wire.contains(&psk_b64));
    let _ = register_frame("x"); // 引用公开 API（注册帧不含配对码）
    assert!(!register_frame("x").contains("pairing_code"));
}

/// 回归（鸿蒙手机内网连接反复瞬断的根因）：手机走后，Host 侧的会话与总线订阅必须**立刻**结束，
/// 否则旧会话继续往线上泵旧密钥的密文，下一部手机一连上就撞到「握手前的密文」。
/// 事件一直在涌（GUI 活跃）的条件下，连续「A 订阅 → A 突然消失 → B 立刻握手」，B 每次都必须握手成功。
#[tokio::test]
async fn a_departed_phone_leaves_no_zombie_session_behind() {
    let relay_url = start_relay().await;
    let h = FakeHarness::new();
    let status = Arc::new(RelayStatus::default());
    tokio::spawn(relay::run(host(&h), relay_url.clone(), Arc::clone(&status)));
    wait_registered(&status).await;
    let ws_url = relay::ws_url(&relay_url);
    let id = h.identity.device_id().to_string();

    // GUI 一直在产生事件
    let backend = Arc::clone(&h.backend);
    let pump = tokio::spawn(async move {
        loop {
            backend.bus.emit("chat-event", json!({"type":"x","session_id":"s1"}));
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });

    for round in 0..5 {
        let mut a = Phone::connect(&ws_url, &h, Some(&id), Mode::Resume, PHONE_A_SECRET).await.expect("A resumes");
        a.send(json!({"type":"hello"})).await;
        assert_eq!(a.recv().await["type"], "hello_ok");
        a.send(json!({"type":"subscribe","sessions":null})).await;
        assert_eq!(a.recv().await["type"], "subscribed");
        drop(a); // 不发 Close：移动网络静默消失

        // B（同一部手机重连也一样）立刻握手：不许撞上旧会话的残帧
        let mut b = Phone::connect(&ws_url, &h, Some(&id), Mode::Resume, PHONE_A_SECRET)
            .await
            .unwrap_or_else(|e| panic!("round {round}: next phone's handshake was disturbed: {e}"));
        b.send(json!({"type":"hello"})).await;
        assert_eq!(b.recv().await["type"], "hello_ok", "round {round}");
        drop(b);
    }

    // 最后一部手机走后，订阅在秒级内全部退掉（旧模型要等 75 s 的 DEAD_AFTER）
    let mut left = 0;
    for _ in 0..40 {
        left = h.backend.bus.consumer_count();
        if left == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    pump.abort();
    assert_eq!(left, 0, "a departed phone's bus subscription must end with its bridge leg");
}
