use aide_relay::run;
use aide_relay::state::{LivenessCfg, RelayState};
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// connect_async 的客户端流型（ws:// 走 MaybeTlsStream 的 Plain 臂）。
type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start_server_with(liveness: LivenessCfg) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state: Arc<Mutex<RelayState>> = Arc::new(Mutex::new(RelayState::with_liveness(liveness)));
    tokio::spawn(async move {
        run(listener, state).await;
    });
    format!("ws://{addr}")
}

async fn start_server() -> String {
    start_server_with(LivenessCfg::default()).await
}

/// TTL/活体测试用短参：真实时钟秒级跑完，不依赖虚拟时钟与 IO 就绪的竞态。
fn short_liveness() -> LivenessCfg {
    LivenessCfg {
        phone_silence: Duration::from_secs(1),
        desktop_ping: Duration::from_millis(500),
        ping_max_miss: 3,
        attach_timeout: Duration::from_secs(1),
    }
}

fn register(device_id: &str) -> Message {
    Message::Text(format!(r#"{{"type":"register","device_id":"{device_id}","proto":2}}"#))
}

/// 控制腿：Host 的 register 连接；收 `incoming{bridge_id}`，再「拨回」一条桥接腿。
struct Host {
    url: String,
    ctrl: Client,
}

impl Host {
    async fn register(url: &str, device_id: &str) -> Host {
        let (mut ctrl, _) = connect_async(url).await.unwrap();
        ctrl.send(register(device_id)).await.unwrap();
        settle().await;
        Host { url: url.to_string(), ctrl }
    }

    /// 等控制腿上的下一条 `incoming`（跳过 Ping），返回 bridge_id。
    async fn next_incoming(&mut self) -> String {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(3), self.ctrl.next())
                .await
                .expect("控制腿没等到 incoming")
                .unwrap()
                .unwrap();
            match msg {
                Message::Text(t) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                    assert_eq!(v["type"], "incoming", "控制腿上只该有 incoming：{t}");
                    return v["bridge_id"].as_str().unwrap().to_string();
                }
                Message::Ping(_) | Message::Pong(_) => continue,
                other => panic!("控制腿上的意外帧 {other:?}"),
            }
        }
    }

    /// 按 bridge_id 拨回桥接腿。
    async fn attach(&self, bridge_id: &str) -> Client {
        let (mut leg, _) = connect_async(&self.url).await.unwrap();
        leg.send(Message::Text(format!(r#"{{"type":"attach","bridge_id":"{bridge_id}"}}"#)))
            .await
            .unwrap();
        leg
    }

    /// 等 incoming 并拨回——一次完整的「手机来了，Host 接上」。
    async fn accept(&mut self) -> Client {
        let id = self.next_incoming().await;
        self.attach(&id).await
    }
}

/// 一条连接在 `ms` 内是否已被对端关闭（Close 帧 / 流结束 / 传输错误）。
async fn closed_within(ws: &mut Client, ms: u64) -> bool {
    tokio::time::timeout(Duration::from_millis(ms), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await
    .is_ok()
}

/// 一条连接在 `ms` 内**没有**收到业务帧（Ping/Pong 不算）。
async fn silent_for(ws: &mut Client, ms: u64) -> bool {
    tokio::time::timeout(Duration::from_millis(ms), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                other => return other,
            }
        }
    })
    .await
    .is_err()
}

fn connect_code(code: &str) -> Message {
    Message::Text(format!(r#"{{"type":"connect","code":"{code}"}}"#))
}

fn connect_device(device_id: &str) -> Message {
    Message::Text(format!(r#"{{"type":"connect","device_id":"{device_id}"}}"#))
}

const KEEPALIVE: &str = r#"{"type":"keepalive"}"#;

/// 控制帧发送后等服务器处理完：register 与后续 connect 走不同连接，
/// 不留窗口则后继断言与服务器处理竞态。
async fn settle() {
    // 并行测试负载下服务器任务可能被调度延迟，窗口留足
    tokio::time::sleep(Duration::from_millis(400)).await;
}

/// 超时收一帧文本并比对（挂死比收错帧更难查）。
async fn expect_text(ws: &mut Client, expected: &str) {
    let msg = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("收帧挂死")
        .unwrap()
        .unwrap();
    assert_eq!(msg, Message::Text(expected.to_string()));
}

/// 收文本帧，跳过期间到达的 Ping（桥接期桌面腿活体帧会先于业务帧积压）。
async fn expect_text_skipping_pings(ws: &mut Client, expected: &str) {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("收帧挂死")
            .unwrap()
            .unwrap();
        match msg {
            Message::Ping(_) | Message::Pong(_) => continue,
            other => {
                assert_eq!(other, Message::Text(expected.to_string()));
                return;
            }
        }
    }
}

/// 关连接前的原因帧（relay → 手机）。
async fn expect_connect_error(ws: &mut Client, reason: &str) {
    expect_text(
        ws,
        &format!(r#"{{"type":"connect_error","reason":"{reason}"}}"#),
    )
    .await;
}

/// 原因帧之后连接应收尾：Close 帧 / 流结束 / 传输层错误都算关。
async fn expect_closed(ws: &mut Client) {
    match ws.next().await {
        None | Some(Err(_)) | Some(Ok(Message::Close(_))) => {}
        Some(Ok(m)) => panic!("原因帧后应关连接，却收到 {m:?}"),
    }
}

#[tokio::test]
async fn bridges_frames_between_host_and_phone() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-1").await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-1")).await.unwrap();
    // 手机在 Host 拨回之前就发帧（真实手机 connect 后立刻 sc_init）：必须在 socket 缓冲里等桥接，不丢
    p_ws.send(Message::Text("hello-host".into())).await.unwrap();
    let mut leg = host.accept().await;
    // 非 JSON 帧：parse 失败必须原样转发，哑管道契约
    expect_text(&mut leg, "hello-host").await;
    leg.send(Message::Text("hello-phone".into())).await.unwrap();
    expect_text(&mut p_ws, "hello-phone").await;
}

#[tokio::test]
async fn connect_by_device_id_after_pairing() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-2").await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(
        r#"{"type":"connect","device_id":"dev-2","token":"opaque"}"#.into(),
    ))
    .await
    .unwrap();
    p_ws.send(Message::Text("ping".into())).await.unwrap();
    let mut leg = host.accept().await;
    expect_text(&mut leg, "ping").await;
}

/// 旧协议的 `connect{code}`：原因帧 unknown_code 先于 close 到达（码路由已删除，恒如此；
/// 旧实装裸关，手机把码错混成 offline 无限重试）。
#[tokio::test]
async fn connect_to_unknown_device_closes() {
    let url = start_server().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_code("000000")).await.unwrap();
    expect_connect_error(&mut p_ws, "unknown_code").await;
    expect_closed(&mut p_ws).await;
}

/// 没注册过的设备：device_offline 原因帧 + 关。
#[tokio::test]
async fn connect_to_unregistered_device_is_offline() {
    let url = start_server().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("nobody")).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
}

/// 旧连接模型的 Host（register 不带 proto:2，腿被顺序复用）不被接纳：明确的 register_error，不静默混用。
#[tokio::test]
async fn legacy_host_without_proto_is_rejected() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(Message::Text(r#"{"type":"register","device_id":"dev-old"}"#.into()))
        .await
        .unwrap();
    expect_text(&mut d_ws, r#"{"type":"register_error","reason":"unsupported_proto"}"#).await;
    expect_closed(&mut d_ws).await;
    // 没登记上：手机得 device_offline
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-old")).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
}

/// 核心不变量：**手机走 = 桥接腿被关**。Host 侧据此立刻结束这次桥接的整条协议栈，
/// 没有「手机走了、会话还活着、往下一部手机的腿里泵旧帧」的窗口。
#[tokio::test]
async fn phone_gone_closes_the_bridge_leg() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-3").await;
    let (mut p1, _) = connect_async(&url).await.unwrap();
    p1.send(connect_device("dev-3")).await.unwrap();
    p1.send(Message::Text("first".into())).await.unwrap();
    let mut leg1 = host.accept().await;
    expect_text(&mut leg1, "first").await;
    p1.close(None).await.unwrap();
    assert!(closed_within(&mut leg1, 2000).await, "手机优雅离开后，桥接腿必须被中继关掉");
}

/// 同上，手机 abrupt drop（无 Close 帧，移动网络静默丢包）；并且——
/// 旧腿上即便还有人写（僵尸会话），下一部手机也绝不会收到：新手机拿到的是**另一条**腿。
#[tokio::test]
async fn zombie_writes_on_a_dead_leg_never_reach_the_next_phone() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-21").await;
    let (mut p1, _) = connect_async(&url).await.unwrap();
    p1.send(connect_device("dev-21")).await.unwrap();
    p1.send(Message::Ping(vec![7])).await.unwrap(); // 非 Text 帧原样转发
    let mut leg1 = host.accept().await;
    let msg = tokio::time::timeout(Duration::from_secs(3), leg1.next())
        .await
        .expect("非 Text 帧应原样转发")
        .unwrap()
        .unwrap();
    assert_eq!(msg, Message::Ping(vec![7]));
    drop(p1);
    assert!(closed_within(&mut leg1, 2000).await, "手机 abrupt drop 后桥接腿必须被关");
    // 「僵尸」继续往旧腿写（写不写得进去都无所谓）
    for i in 0..5 {
        let _ = leg1.send(Message::Text(format!("zombie-{i}"))).await;
    }
    // 下一部手机：独立的新腿，只收得到新腿上的帧
    let (mut p2, _) = connect_async(&url).await.unwrap();
    p2.send(connect_device("dev-21")).await.unwrap();
    p2.send(Message::Text("after-abrupt".into())).await.unwrap();
    let mut leg2 = host.accept().await;
    expect_text(&mut leg2, "after-abrupt").await;
    assert!(silent_for(&mut p2, 400).await, "新手机不该收到旧腿上的任何帧");
    leg2.send(Message::Text("fresh".into())).await.unwrap();
    expect_text(&mut p2, "fresh").await;
}

/// 每次桥接的 bridge_id 都不同（一次性、不可预测）。
#[tokio::test]
async fn every_bridge_gets_a_fresh_bridge_id() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-id").await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        let (mut p, _) = connect_async(&url).await.unwrap();
        p.send(connect_device("dev-id")).await.unwrap();
        let id = host.next_incoming().await;
        assert_eq!(id.len(), 32);
        let mut leg = host.attach(&id).await;
        p.send(Message::Text("x".into())).await.unwrap();
        expect_text(&mut leg, "x").await;
        p.close(None).await.unwrap();
        assert!(closed_within(&mut leg, 2000).await);
        ids.push(id);
    }
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 3);
}

/// bridge_id 是一次性的：重复 attach / 乱猜 / 过期，一律被关，且不影响正在进行的桥接。
#[tokio::test]
async fn attach_with_unknown_or_reused_bridge_id_is_closed() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-att").await;
    let mut bogus = host.attach("00000000000000000000000000000000").await;
    assert!(closed_within(&mut bogus, 2000).await);

    let (mut p, _) = connect_async(&url).await.unwrap();
    p.send(connect_device("dev-att")).await.unwrap();
    let id = host.next_incoming().await;
    let mut leg = host.attach(&id).await;
    let mut dup = host.attach(&id).await; // 重放同一个 id
    assert!(closed_within(&mut dup, 2000).await);
    p.send(Message::Text("still-ok".into())).await.unwrap();
    expect_text(&mut leg, "still-ok").await;
}

/// Host 收到 incoming 却不拨回（崩了 / 网络断）：手机在 attach 超时后得 device_offline，不会无限挂着。
#[tokio::test]
async fn host_that_never_attaches_gives_device_offline() {
    let url = start_server_with(short_liveness()).await;
    let mut host = Host::register(&url, "dev-slow").await;
    let (mut p, _) = connect_async(&url).await.unwrap();
    p.send(connect_device("dev-slow")).await.unwrap();
    let _ = host.next_incoming().await; // 收到但不拨回
    expect_connect_error(&mut p, "device_offline").await;
    expect_closed(&mut p).await;
}

/// 回归：控制腿空闲期间发的 Ping 必须被自动回 Pong（空闲连接必须有人持续 poll）。
#[tokio::test]
async fn idle_control_leg_ping_gets_ponged() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-5")).await.unwrap();
    d_ws.send(Message::Ping(vec![1, 2, 3])).await.unwrap();
    let msg = tokio::time::timeout(Duration::from_secs(3), d_ws.next())
        .await
        .expect("空闲连接上没有收到 Pong")
        .unwrap()
        .unwrap();
    assert_eq!(msg, Message::Pong(vec![1, 2, 3]));
}

/// 控制腿空闲期间主动 close（下线），登记必须及时清掉：之后手机的 connect 得 device_offline。
#[tokio::test]
async fn control_close_evicts_registration() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-6")).await.unwrap();
    d_ws.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-6")).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
}

/// 控制腿 abrupt drop（无 Close 帧）：登记摘除。
#[tokio::test]
async fn control_abrupt_drop_evicts_registration() {
    let url = start_server().await;
    let host = Host::register(&url, "dev-25").await;
    drop(host);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-25")).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
}

/// 控制腿静默丢包（合盖）：连续 3 次 Ping 无 Pong → 登记摘除，手机立刻得 device_offline
/// （旧实装：空闲腿无活体检测，手机被桥到半死的腿上）。
#[tokio::test]
async fn silent_control_leg_is_evicted_by_ping_miss() {
    let url = start_server_with(LivenessCfg {
        desktop_ping: Duration::from_millis(300),
        ..short_liveness()
    })
    .await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-cm")).await.unwrap();
    settle().await;
    // 不再 poll d_ws：无自动 Pong；等过 3 个 Ping 周期
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-cm")).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
    drop(d_ws);
}

/// 控制腿上不该有业务帧：收到的文本 / 二进制被忽略，不转发给任何人，也不掐连接。
#[tokio::test]
async fn stray_frames_on_the_control_leg_are_ignored() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-19").await;
    host.ctrl.send(Message::Text("stray".into())).await.unwrap();
    host.ctrl.send(Message::Binary(vec![9, 9])).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-19")).await.unwrap();
    p_ws.send(Message::Text("still-bridgeable".into())).await.unwrap();
    let mut leg = host.accept().await;
    expect_text(&mut leg, "still-bridgeable").await;
    assert!(silent_for(&mut p_ws, 300).await, "控制腿上的杂帧不能漏给手机");
}

/// supersede：第二条 connect 顶替桥接中的手机——旧手机腿先收 superseded 原因帧再被关，
/// 旧桥接腿被关；新手机拿到**新的**桥接腿。
#[tokio::test]
async fn second_connect_supersedes_active_bridge() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-12").await;
    let (mut p1, _) = connect_async(&url).await.unwrap();
    p1.send(connect_device("dev-12")).await.unwrap();
    p1.send(Message::Text("p1-live".into())).await.unwrap();
    let mut leg1 = host.accept().await;
    expect_text(&mut leg1, "p1-live").await;
    // 手机 2 顶替
    let (mut p2, _) = connect_async(&url).await.unwrap();
    p2.send(connect_device("dev-12")).await.unwrap();
    expect_connect_error(&mut p1, "superseded").await;
    expect_closed(&mut p1).await;
    assert!(closed_within(&mut leg1, 2000).await, "被顶替的桥接腿必须被关");
    let mut leg2 = host.accept().await;
    p2.send(Message::Text("p2-live".into())).await.unwrap();
    expect_text(&mut leg2, "p2-live").await;
}

/// 等 attach 期间被第三条 connect 顶替：中途的那条得 superseded，且晚到的 attach 不会被误认领。
#[tokio::test]
async fn connect_superseded_while_waiting_for_attach() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-w").await;
    let (mut p1, _) = connect_async(&url).await.unwrap();
    p1.send(connect_device("dev-w")).await.unwrap();
    let id1 = host.next_incoming().await; // 先不拨回
    let (mut p2, _) = connect_async(&url).await.unwrap();
    p2.send(connect_device("dev-w")).await.unwrap();
    expect_connect_error(&mut p1, "superseded").await;
    let mut late = host.attach(&id1).await; // 晚到的旧 attach
    assert!(closed_within(&mut late, 2000).await, "已撤销的 bridge_id 不能再认领");
    let mut leg2 = host.accept().await;
    p2.send(Message::Text("p2".into())).await.unwrap();
    expect_text(&mut leg2, "p2").await;
}

/// Host 控制腿重连（新 register 同 device_id）：旧控制腿被退役；**进行中的桥接不受影响**
/// （旧实装：旧桥被连带踢掉）；之后的手机经新控制腿。
#[tokio::test]
async fn re_register_retires_old_control_leg_but_keeps_the_bridge() {
    let url = start_server().await;
    let mut host1 = Host::register(&url, "dev-13").await;
    let (mut p1, _) = connect_async(&url).await.unwrap();
    p1.send(connect_device("dev-13")).await.unwrap();
    p1.send(Message::Text("old-bridge".into())).await.unwrap();
    let mut leg1 = host1.accept().await;
    expect_text(&mut leg1, "old-bridge").await;
    let mut host2 = Host::register(&url, "dev-13").await;
    assert!(closed_within(&mut host1.ctrl, 2000).await, "旧控制腿应被退役");
    // 旧桥接照常
    p1.send(Message::Text("still-bridged".into())).await.unwrap();
    expect_text(&mut leg1, "still-bridged").await;
    // 新手机走新控制腿
    let (mut p2, _) = connect_async(&url).await.unwrap();
    p2.send(connect_device("dev-13")).await.unwrap();
    let mut leg2 = host2.accept().await;
    p2.send(Message::Text("new-bridge".into())).await.unwrap();
    expect_text(&mut leg2, "new-bridge").await;
}

/// 手机腿静默超时（opt-in）：发过 keepalive 武装后断流过静默线 → 桥结束、桥接腿被关。
#[tokio::test]
async fn armed_phone_leg_silence_timeout_closes_the_bridge_leg() {
    let url = start_server_with(short_liveness()).await;
    let mut host = Host::register(&url, "dev-14").await;
    let (mut p1, _) = connect_async(&url).await.unwrap();
    p1.send(connect_device("dev-14")).await.unwrap();
    // keepalive 武装 + 紧跟普通帧证明桥接已处理到 keepalive（顺序保证）
    p1.send(Message::Text(KEEPALIVE.into())).await.unwrap();
    p1.send(Message::Text("proof".into())).await.unwrap();
    let mut leg1 = host.accept().await;
    expect_text_skipping_pings(&mut leg1, "proof").await;
    // 手机「静默丢包」：不再有任何帧；真实时钟等过 1s 静默线
    assert!(closed_within(&mut leg1, 3000).await, "静默超时后桥接腿必须被关");
    let (mut p2, _) = connect_async(&url).await.unwrap();
    p2.send(connect_device("dev-14")).await.unwrap();
    p2.send(Message::Text("after-silence".into())).await.unwrap();
    let mut leg2 = host.accept().await;
    expect_text_skipping_pings(&mut leg2, "after-silence").await;
}

/// opt-in 回归臂：从未发过 keepalive 的手机腿不启用静默超时——等过静默线数倍桥接仍然活着。
#[tokio::test]
async fn unarmed_phone_leg_never_times_out() {
    let url = start_server_with(short_liveness()).await;
    let mut host = Host::register(&url, "dev-15").await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-15")).await.unwrap();
    p_ws.send(Message::Text("ordinary".into())).await.unwrap();
    let mut leg = host.accept().await;
    expect_text_skipping_pings(&mut leg, "ordinary").await;
    // 桥接腿 Ping 每 500ms 一跳：读掉 Ping 并回一帧（send 顺带刷出自动 Pong）
    for i in 0..5 {
        let msg = tokio::time::timeout(Duration::from_secs(3), leg.next())
            .await
            .expect("桥接腿 Ping 未到达")
            .unwrap()
            .unwrap();
        assert!(matches!(msg, Message::Ping(_)));
        leg.send(Message::Text(format!("tick-{i}"))).await.unwrap();
        expect_text(&mut p_ws, &format!("tick-{i}")).await;
    }
    // 已远超 1s 静默线：未武装 → 桥接必须还活着
    p_ws.send(Message::Text("still-here".into())).await.unwrap();
    expect_text_skipping_pings(&mut leg, "still-here").await;
}

/// 桥接腿活体：桥接期 relay 按配置间隔发 Ping（Pong 由 tungstenite 自动回）。
#[tokio::test]
async fn bridge_leg_gets_periodic_ping() {
    let url = start_server_with(short_liveness()).await;
    let mut host = Host::register(&url, "dev-16").await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-16")).await.unwrap();
    let mut leg = host.accept().await;
    let msg = tokio::time::timeout(Duration::from_secs(3), leg.next())
        .await
        .expect("桥接期桥接腿未收到 Ping")
        .unwrap()
        .unwrap();
    assert!(matches!(msg, Message::Ping(_)));
    leg.send(Message::Text("pong-trigger".into())).await.unwrap();
    expect_text(&mut p_ws, "pong-trigger").await;
    let msg = tokio::time::timeout(Duration::from_secs(3), leg.next())
        .await
        .expect("第二个 Ping 未到达")
        .unwrap()
        .unwrap();
    assert!(matches!(msg, Message::Ping(_)));
    p_ws.send(Message::Text("alive".into())).await.unwrap();
    expect_text(&mut leg, "alive").await;
}

/// 桥接腿优雅下线：手机腿收 device_offline 原因帧；控制腿仍在，下一部手机可再连。
#[tokio::test]
async fn bridge_leg_close_notifies_phone_and_control_leg_survives() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-18").await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-18")).await.unwrap();
    p_ws.send(Message::Text("before-close".into())).await.unwrap();
    let mut leg = host.accept().await;
    expect_text(&mut leg, "before-close").await;
    leg.close(None).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
    let (mut p2, _) = connect_async(&url).await.unwrap();
    p2.send(connect_device("dev-18")).await.unwrap();
    p2.send(Message::Text("next".into())).await.unwrap();
    let mut leg2 = host.accept().await;
    expect_text(&mut leg2, "next").await;
}

/// 桥接腿 abrupt drop（无 Close 帧）→ 手机腿收 device_offline 原因帧。
#[tokio::test]
async fn bridge_leg_abrupt_drop_notifies_phone() {
    let url = start_server().await;
    let mut host = Host::register(&url, "dev-23").await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-23")).await.unwrap();
    p_ws.send(Message::Text("pre-drop".into())).await.unwrap();
    let mut leg = host.accept().await;
    expect_text(&mut leg, "pre-drop").await;
    drop(leg);
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
}

/// 桥接腿静默丢包（合盖）：连续 3 次 Ping 无 Pong → 桥结束，手机腿收 device_offline 原因帧。
#[tokio::test]
async fn bridge_leg_ping_miss_evicts_bridge_and_notifies_phone() {
    let url = start_server_with(LivenessCfg {
        desktop_ping: Duration::from_millis(300),
        ..short_liveness()
    })
    .await;
    let mut host = Host::register(&url, "dev-17").await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-17")).await.unwrap();
    let _leg = host.accept().await; // 之后不再 poll：无自动 Pong
    // host.ctrl 同样不 poll；只关心手机腿
    tokio::time::sleep(Duration::from_millis(1500)).await;
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
}

/// 桥接腿的 Ping 被消费不转发；Binary 原样转发到手机。
#[tokio::test]
async fn bridge_leg_ping_consumed_and_binary_forwarded() {
    let url = start_server_with(short_liveness()).await;
    let mut host = Host::register(&url, "dev-22").await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-22")).await.unwrap();
    p_ws.send(Message::Text("probe".into())).await.unwrap();
    let mut leg = host.accept().await;
    expect_text_skipping_pings(&mut leg, "probe").await;
    leg.send(Message::Ping(vec![3])).await.unwrap();
    leg.send(Message::Binary(vec![8])).await.unwrap();
    // 手机收到的第一帧必须是 Binary（Ping 被桥接消费，不泄漏到手机）
    let msg = tokio::time::timeout(Duration::from_secs(3), p_ws.next())
        .await
        .expect("Binary 应转发到手机")
        .unwrap()
        .unwrap();
    assert_eq!(msg, Message::Binary(vec![8]));
}

/// 首消息非 Text：直接 Err 关连接（协议要求首条为文本帧）。
#[tokio::test]
async fn first_message_non_text_closes() {
    let url = start_server().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Ping(vec![1])).await.unwrap();
    let next = tokio::time::timeout(Duration::from_secs(3), p_ws.next())
        .await
        .expect("首消息非 Text 应关连接")
        .unwrap();
    assert!(next.is_err() || matches!(next, Ok(Message::Close(_))));
}

/// 首消息类型未知：Err 关连接（不给原因帧——客户端坏帧非路由问题）。
#[tokio::test]
async fn first_message_unknown_type_closes() {
    let url = start_server().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(r#"{"type":"bogus"}"#.into())).await.unwrap();
    let next = tokio::time::timeout(Duration::from_secs(3), p_ws.next())
        .await
        .expect("未知首消息应关连接")
        .unwrap();
    assert!(next.is_err() || matches!(next, Ok(Message::Close(_))));
}

/// 旧协议的码路由已删除：register 带着 `pairing_code` 也只按 device_id 登记（码字段被忽略）；
/// `connect{code}` 恒得到类型化的 unknown_code，按 device_id 寻址照常桥接。
#[tokio::test]
async fn legacy_code_routing_is_gone_but_device_id_routing_works() {
    let url = start_server().await;
    let (mut ctrl, _) = connect_async(&url).await.unwrap();
    ctrl.send(Message::Text(
        r#"{"type":"register","device_id":"dev-legacy","proto":2,"pairing_code":"111222"}"#.into(),
    ))
    .await
    .unwrap();
    settle().await;
    let mut host = Host { url: url.clone(), ctrl };

    let (mut q_ws, _) = connect_async(&url).await.unwrap();
    q_ws.send(connect_code("111222")).await.unwrap();
    expect_connect_error(&mut q_ws, "unknown_code").await;
    expect_closed(&mut q_ws).await;

    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-legacy")).await.unwrap();
    p_ws.send(Message::Text("hello-link".into())).await.unwrap();
    let mut leg = host.accept().await;
    expect_text(&mut leg, "hello-link").await;
}
