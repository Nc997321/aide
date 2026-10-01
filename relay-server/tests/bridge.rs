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
    }
}

fn register(device_id: &str) -> Message {
    Message::Text(format!(r#"{{"type":"register","device_id":"{device_id}"}}"#))
}

fn connect_code(code: &str) -> Message {
    Message::Text(format!(r#"{{"type":"connect","code":"{code}"}}"#))
}

fn connect_device(device_id: &str) -> Message {
    Message::Text(format!(r#"{{"type":"connect","device_id":"{device_id}"}}"#))
}

const KEEPALIVE: &str = r#"{"type":"keepalive"}"#;

/// 控制帧发送后等服务器处理完：register/announce 与后续 connect 走不同连接，
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
async fn bridges_frames_between_desktop_and_phone() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-1")).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-1")).await.unwrap();
    // 手机 → 桌面（非 JSON 帧：parse 失败必须原样转发，哑管道契约）
    p_ws.send(Message::Text("hello-desktop".into()))
        .await
        .unwrap();
    expect_text(&mut d_ws, "hello-desktop").await;
    // 桌面 → 手机
    d_ws.send(Message::Text("hello-phone".into()))
        .await
        .unwrap();
    expect_text(&mut p_ws, "hello-phone").await;
}

#[tokio::test]
async fn connect_by_device_id_after_pairing() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-2")).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(
        r#"{"type":"connect","device_id":"dev-2","token":"opaque"}"#.into(),
    ))
    .await
    .unwrap();
    p_ws.send(Message::Text("ping".into())).await.unwrap();
    expect_text(&mut d_ws, "ping").await;
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

/// 回归：手机优雅断开（close 帧）后，桌面端连接必须保持，且可被下一台
/// 手机再次 connect 桥接——桌面端连接是持久服务连接，不该被手机断开拖垮。
#[tokio::test]
async fn phone_disconnect_keeps_desktop_connection_for_next_phone() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-3")).await.unwrap();
    settle().await;
    // 手机 1：connect → 确认桥接 → 优雅断开
    let (mut p1_ws, _) = connect_async(&url).await.unwrap();
    p1_ws.send(connect_device("dev-3")).await.unwrap();
    p1_ws.send(Message::Text("first".into())).await.unwrap();
    expect_text(&mut d_ws, "first").await;
    p1_ws.close(None).await.unwrap();
    // 等中继处理 close（桥接结束、桌面连接归还）
    tokio::time::sleep(Duration::from_millis(300)).await;
    // 手机 2：同一桌面连接必须还能再次桥接
    let (mut p2_ws, _) = connect_async(&url).await.unwrap();
    p2_ws.send(connect_device("dev-3")).await.unwrap();
    p2_ws.send(Message::Text("second".into())).await.unwrap();
    expect_text(&mut d_ws, "second").await;
}

/// 回归：桌面连接空闲（未桥接）期间发的 Ping 必须被自动回 Pong。
/// tungstenite 读到 Ping 只是把 Pong 排进 additional 队列，真正刷出
/// socket 要等下一次 read poll——空闲连接必须有人持续 poll。
#[tokio::test]
async fn idle_desktop_ping_gets_ponged() {
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

/// 回归：桌面空闲期间主动 close（下线），路由表必须及时清掉该连接，
/// 之后手机的 connect 得到 device_offline 原因帧，而不是桥到僵尸连接上。
#[tokio::test]
async fn idle_desktop_close_evicts_entry() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-6")).await.unwrap();
    // 桌面优雅下线；close() 能返回本身就证明看守在 poll 并刷出了 close 应答
    d_ws.close(None).await.unwrap();
    // 等看守摘除登记
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-6")).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
}

/// supersede：桥接中的设备可被第二条 connect 认领——旧手机腿先收
/// superseded 原因帧再被关（旧实装：桥接期摘登记，重连一律 device offline）。
#[tokio::test]
async fn second_connect_supersedes_active_bridge() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-12")).await.unwrap();
    settle().await;
    let (mut p1_ws, _) = connect_async(&url).await.unwrap();
    p1_ws.send(connect_device("dev-12")).await.unwrap();
    p1_ws.send(Message::Text("p1-live".into())).await.unwrap();
    expect_text(&mut d_ws, "p1-live").await;
    // 手机 2 顶替
    let (mut p2_ws, _) = connect_async(&url).await.unwrap();
    p2_ws.send(connect_device("dev-12")).await.unwrap();
    // 旧手机腿：原因帧 + 关
    expect_connect_error(&mut p1_ws, "superseded").await;
    expect_closed(&mut p1_ws).await;
    // 新手机腿桥接成立
    p2_ws.send(Message::Text("p2-live".into())).await.unwrap();
    expect_text(&mut d_ws, "p2-live").await;
}

/// 桥接期间同 device_id 来了新 register（桌面重连）：旧桥 claim 通道被顶 →
/// 旧手机腿收 device_offline 原因帧被关；新桌面登记可被认领。
#[tokio::test]
async fn new_register_while_bridged_replaces_old_bridge() {
    let url = start_server().await;
    let (mut d1_ws, _) = connect_async(&url).await.unwrap();
    d1_ws.send(register("dev-13")).await.unwrap();
    settle().await;
    let (mut p1_ws, _) = connect_async(&url).await.unwrap();
    p1_ws.send(connect_device("dev-13")).await.unwrap();
    p1_ws
        .send(Message::Text("old-bridge".into()))
        .await
        .unwrap();
    expect_text(&mut d1_ws, "old-bridge").await;
    // 桌面「重连」：新连接同 device_id 注册
    let (mut d2_ws, _) = connect_async(&url).await.unwrap();
    d2_ws.send(register("dev-13")).await.unwrap();
    settle().await;
    expect_connect_error(&mut p1_ws, "device_offline").await;
    expect_closed(&mut p1_ws).await;
    // 新桌面连接可被手机认领
    let (mut p2_ws, _) = connect_async(&url).await.unwrap();
    p2_ws.send(connect_device("dev-13")).await.unwrap();
    p2_ws
        .send(Message::Text("new-bridge".into()))
        .await
        .unwrap();
    expect_text(&mut d2_ws, "new-bridge").await;
}

/// 手机腿静默超时（opt-in）：发过 keepalive 武装后断流过静默线 → 桥结束、
/// 桌面半连接重挂可再认领（旧实装：僵尸桥劫持桌面连接分钟级）。
#[tokio::test]
async fn armed_phone_leg_silence_timeout_releases_desktop() {
    let url = start_server_with(short_liveness()).await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-14")).await.unwrap();
    settle().await;
    let (mut p1_ws, _) = connect_async(&url).await.unwrap();
    p1_ws.send(connect_device("dev-14")).await.unwrap();
    // keepalive 武装 + 紧跟普通帧证明桥接已处理到 keepalive（顺序保证）
    p1_ws.send(Message::Text(KEEPALIVE.into())).await.unwrap();
    p1_ws.send(Message::Text("proof".into())).await.unwrap();
    expect_text(&mut d_ws, "proof").await;
    // 手机「静默丢包」：不再有任何帧；真实时钟等过 1s 静默线
    tokio::time::sleep(Duration::from_millis(1500)).await;
    // 桌面半连接已重挂：新手机可认领
    let (mut p2_ws, _) = connect_async(&url).await.unwrap();
    p2_ws.send(connect_device("dev-14")).await.unwrap();
    p2_ws
        .send(Message::Text("after-silence".into()))
        .await
        .unwrap();
    expect_text_skipping_pings(&mut d_ws, "after-silence").await;
}

/// opt-in 回归臂：从未发过 keepalive 的手机腿不启用静默超时——等过静默线
/// 数倍（桌面腿 Ping 往返持续进行）桥接仍然活着。
#[tokio::test]
async fn unarmed_phone_leg_never_times_out() {
    let url = start_server_with(short_liveness()).await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-15")).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-15")).await.unwrap();
    p_ws.send(Message::Text("ordinary".into())).await.unwrap();
    expect_text(&mut d_ws, "ordinary").await;
    // 桌面腿 Ping 每 500ms 一跳：读掉 Ping 并回一帧（send 顺带刷出自动 Pong）
    for i in 0..5 {
        let msg = tokio::time::timeout(Duration::from_secs(3), d_ws.next())
            .await
            .expect("桌面腿 Ping 未到达")
            .unwrap()
            .unwrap();
        assert!(matches!(msg, Message::Ping(_)));
        d_ws.send(Message::Text(format!("tick-{i}"))).await.unwrap();
        expect_text(&mut p_ws, &format!("tick-{i}")).await;
    }
    // 已远超 1s 静默线：未武装 → 桥接必须还活着
    p_ws.send(Message::Text("still-here".into())).await.unwrap();
    expect_text(&mut d_ws, "still-here").await;
}

/// 桌面腿活体：桥接期 relay 按配置间隔发 Ping（Pong 由 tungstenite 自动回）。
#[tokio::test]
async fn desktop_leg_gets_periodic_ping_while_bridged() {
    let url = start_server_with(short_liveness()).await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-16")).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-16")).await.unwrap();
    let msg = tokio::time::timeout(Duration::from_secs(3), d_ws.next())
        .await
        .expect("桥接期桌面腿未收到 Ping")
        .unwrap()
        .unwrap();
    assert!(matches!(msg, Message::Ping(_)));
    // 回一帧（send 顺带刷出自动 Pong）→ miss 清零，桥接存活
    d_ws.send(Message::Text("pong-trigger".into()))
        .await
        .unwrap();
    expect_text(&mut p_ws, "pong-trigger").await;
    let msg = tokio::time::timeout(Duration::from_secs(3), d_ws.next())
        .await
        .expect("第二个 Ping 未到达")
        .unwrap()
        .unwrap();
    assert!(matches!(msg, Message::Ping(_)));
    p_ws.send(Message::Text("alive".into())).await.unwrap();
    expect_text(&mut d_ws, "alive").await;
}

/// 桌面腿桥接期间优雅下线：手机腿收 device_offline 原因帧，路由表摘除
/// （后继 connect 不再桥到僵尸桌面连接）。
#[tokio::test]
async fn desktop_close_while_bridged_notifies_phone_and_evicts() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-18")).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-18")).await.unwrap();
    p_ws.send(Message::Text("before-close".into()))
        .await
        .unwrap();
    expect_text(&mut d_ws, "before-close").await;
    d_ws.close(None).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
    // 桌面半对已死：不重挂；后继 connect 得 device_offline
    let (mut p2_ws, _) = connect_async(&url).await.unwrap();
    p2_ws.send(connect_device("dev-18")).await.unwrap();
    expect_connect_error(&mut p2_ws, "device_offline").await;
}

/// 看守期桌面发来非 update_code 的数据帧：丢弃不掐连接（桥接仍可用）。
#[tokio::test]
async fn parked_watcher_drops_stray_data_frame() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-19")).await.unwrap();
    settle().await;
    d_ws.send(Message::Text("stray".into())).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-19")).await.unwrap();
    p_ws.send(Message::Text("still-bridgeable".into()))
        .await
        .unwrap();
    expect_text(&mut d_ws, "still-bridgeable").await;
}

/// 看守期桌面 abrupt drop（无 Close 帧）：看守流 Err 退出并摘除登记。
#[tokio::test]
async fn parked_watcher_exits_on_abrupt_desktop_drop() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-25")).await.unwrap();
    settle().await;
    drop(d_ws);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-25")).await.unwrap();
    expect_connect_error(&mut p_ws, "device_offline").await;
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
    p_ws.send(Message::Text(r#"{"type":"bogus"}"#.into()))
        .await
        .unwrap();
    let next = tokio::time::timeout(Duration::from_secs(3), p_ws.next())
        .await
        .expect("未知首消息应关连接")
        .unwrap();
    assert!(next.is_err() || matches!(next, Ok(Message::Close(_))));
}

/// 看守期桌面发非 Text 帧：丢弃不掐连接（Binary 走非 Text 丢弃臂）。
#[tokio::test]
async fn parked_watcher_drops_stray_binary_frame() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-20")).await.unwrap();
    settle().await;
    d_ws.send(Message::Binary(vec![9, 9])).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-20")).await.unwrap();
    p_ws.send(Message::Text("after-stray".into()))
        .await
        .unwrap();
    expect_text(&mut d_ws, "after-stray").await;
}

/// 手机腿非 Text 帧原样转发；手机 abrupt drop（无 Close 帧）→ PhoneDead 重挂。
#[tokio::test]
async fn phone_non_text_forwarded_and_abrupt_drop_reparks() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-21")).await.unwrap();
    settle().await;
    let (mut p1_ws, _) = connect_async(&url).await.unwrap();
    p1_ws.send(connect_device("dev-21")).await.unwrap();
    p1_ws.send(Message::Ping(vec![7])).await.unwrap();
    let msg = tokio::time::timeout(Duration::from_secs(3), d_ws.next())
        .await
        .expect("非 Text 帧应原样转发")
        .unwrap()
        .unwrap();
    assert_eq!(msg, Message::Ping(vec![7]));
    // abrupt drop：不送 Close 帧，模拟移动网络静默丢包
    drop(p1_ws);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut p2_ws, _) = connect_async(&url).await.unwrap();
    p2_ws.send(connect_device("dev-21")).await.unwrap();
    p2_ws
        .send(Message::Text("after-abrupt".into()))
        .await
        .unwrap();
    expect_text(&mut d_ws, "after-abrupt").await;
}

/// 桌面腿 Ping 被消费不转发；Binary 原样转发到手机。
#[tokio::test]
async fn desktop_ping_consumed_and_binary_forwarded() {
    let url = start_server_with(short_liveness()).await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-22")).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-22")).await.unwrap();
    // 探针坐实桥接（帧在 socket 缓冲等桥接读，不受服务器调度饥饿影响）
    p_ws.send(Message::Text("probe".into())).await.unwrap();
    expect_text(&mut d_ws, "probe").await;
    d_ws.send(Message::Ping(vec![3])).await.unwrap();
    d_ws.send(Message::Binary(vec![8])).await.unwrap();
    // 手机收到的第一帧必须是 Binary（Ping 被看守/桥接消费，不泄漏到手机）
    let msg = tokio::time::timeout(Duration::from_secs(3), p_ws.next())
        .await
        .expect("Binary 应转发到手机")
        .unwrap()
        .unwrap();
    assert_eq!(msg, Message::Binary(vec![8]));
}

/// 桌面 abrupt drop（无 Close 帧）→ 手机腿收 device_offline 原因帧。
#[tokio::test]
async fn desktop_abrupt_drop_notifies_phone() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-23")).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-23")).await.unwrap();
    p_ws.send(Message::Text("pre-drop".into())).await.unwrap();
    expect_text(&mut d_ws, "pre-drop").await;
    drop(d_ws);
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
}

/// 桌面腿静默丢包（合盖）：连续 3 次 Ping 无 Pong → 桥结束，
/// 手机腿收 device_offline 原因帧（旧实装：手机被僵尸桌面腿劫持分钟级）。
#[tokio::test]
async fn desktop_ping_miss_evicts_bridge_and_notifies_phone() {
    let url = start_server_with(LivenessCfg {
        desktop_ping: Duration::from_millis(300),
        ..short_liveness()
    })
    .await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(register("dev-17")).await.unwrap();
    settle().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-17")).await.unwrap();
    // 桌面腿「静默丢包」：不再 poll（无自动 Pong）；等过 3 个 Ping 周期
    tokio::time::sleep(Duration::from_millis(1500)).await;
    expect_connect_error(&mut p_ws, "device_offline").await;
    expect_closed(&mut p_ws).await;
}

/// 旧协议的码路由已删除：旧版桌面带着 `pairing_code` 注册也只会被按 device_id 登记（码字段被忽略）；
/// `connect{code}` 恒得到类型化的 unknown_code（旧手机端不会被裸断），按 device_id 寻址照常桥接。
#[tokio::test]
async fn legacy_code_routing_is_gone_but_device_id_routing_works() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(Message::Text(
        r#"{"type":"register","device_id":"dev-legacy","pairing_code":"111222"}"#.into(),
    ))
    .await
    .unwrap();
    settle().await;

    let (mut q_ws, _) = connect_async(&url).await.unwrap();
    q_ws.send(connect_code("111222")).await.unwrap();
    expect_connect_error(&mut q_ws, "unknown_code").await;
    expect_closed(&mut q_ws).await;

    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(connect_device("dev-legacy")).await.unwrap();
    p_ws.send(Message::Text("hello-link".into())).await.unwrap();
    expect_text(&mut d_ws, "hello-link").await;
}
