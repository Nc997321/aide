use std::time::Duration;

use futures_util::future::Either;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::protocol::{self, ConnectErrorReason};
use crate::state::{lock_recover, Claim, SharedState, WsSink, WsStream};

/// 桌面连接半对（看守/桥接/认领方之间交接的所有权载体）。
type Halves = (WsSink, WsStream);

/// 单连接处理：首条消息必须是 register（桌面）或 connect（手机）。
pub async fn handle_conn(stream: TcpStream, state: SharedState) -> Result<(), String> {
    let ws = accept_async(stream).await.map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();
    let first = stream
        .next()
        .await
        .ok_or("closed before first message")?
        .map_err(|e| e.to_string())?;
    let text = match first {
        Message::Text(t) => t.to_string(),
        _ => return Err("first message must be text".into()),
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("register") => {
            let device_id = v
                .get("device_id")
                .and_then(|s| s.as_str())
                .ok_or("register: missing device_id")?
                .to_string();
            let code = v
                .get("pairing_code")
                .and_then(|s| s.as_str())
                .ok_or("register: missing pairing_code")?;
            // 码路由只经宣告进出（register 是首次宣告）；桥接收尾不再删路由
            lock_recover(&state).announce_code(&device_id, code);
            park_device(&state, device_id.clone(), sink, stream);
            eprintln!("registered device {device_id}");
            Ok(())
        }
        Some("connect") => connect_arm(&state, &v, &mut sink, &mut stream).await,
        _ => Err("unknown first message type".into()),
    }
}

/// connect 分支：解析路由 → 认领桌面连接（桥接中的也可认领 = supersede）→ 桥接 → 收尾。
async fn connect_arm(
    state: &SharedState,
    v: &serde_json::Value,
    sink: &mut WsSink,
    stream: &mut WsStream,
) -> Result<(), String> {
    let device_id = match resolve_device(state, v) {
        Ok(id) => id,
        Err(reason) => return reject_connect(sink, reason).await,
    };
    let halves = match claim_device(state, &device_id).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("relay: connect -> {device_id} failed: {e}");
            return reject_connect(sink, ConnectErrorReason::DeviceOffline).await;
        }
    };
    eprintln!("bridging phone -> {device_id}");
    // 桥接期也登记路由表（新代 + 新 claim 通道）：桥接中的设备可被第二条 connect
    // 认领顶替（旧实装桥接期摘登记，重连一律 device offline）
    let (claim_tx, claim_rx) = mpsc::channel::<Claim>(1);
    let gen = lock_recover(state).insert_device(device_id.clone(), claim_tx);
    let end = bridge(sink, stream, halves, claim_rx, state, &device_id).await;
    finish_bridge(state, &device_id, gen, end);
    Ok(())
}

/// connect 首消息路由解析：码路由命中 → 设备 id；码未知/过期或凭据缺失 → 拒绝原因。
fn resolve_device(
    state: &SharedState,
    v: &serde_json::Value,
) -> Result<String, ConnectErrorReason> {
    match v.get("code").and_then(|s| s.as_str()) {
        Some(code) => state
            .lock()
            .unwrap()
            .lookup_code(code)
            .ok_or(ConnectErrorReason::UnknownCode),
        None => v
            .get("device_id")
            .and_then(|s| s.as_str())
            .map(str::to_string)
            .ok_or(ConnectErrorReason::DeviceOffline),
    }
}

/// 首消息阶段拒绝：原因帧 → 2s 超时 close。手机侧据此区分码错/离线，
/// 不再把 relay 层拒绝混成「offline 无限重试」（旧实装裸关连接）。
async fn reject_connect(sink: &mut WsSink, reason: ConnectErrorReason) -> Result<(), String> {
    sink.send(Message::Text(protocol::connect_error_frame(reason)))
        .await
        .map_err(|e| e.to_string())?;
    let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
    Ok(())
}

/// 给手机腿发原因帧后关连接（被顶替 / 桌面死亡场景）；发送失败（腿已死）即放弃
/// （生产路径：手机腿单向静默丢包；集成测试无法确定性构造，见覆盖率对账表）。
async fn notice_phone_close(sink: &mut WsSink, reason: ConnectErrorReason) {
    // 失败可吞（腿已死是常态），信号要留：relay 自身 sink 出错也走这条，丢日志就丢诊断
    if let Err(e) = sink
        .send(Message::Text(protocol::connect_error_frame(reason)))
        .await
    {
        eprintln!("relay: notice_phone_close send failed: {e}");
        return;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
}

/// 把桌面连接放进路由表（parked 态），挂看守任务。
fn park_device(state: &SharedState, device_id: String, sink: WsSink, stream: WsStream) {
    let (claim_tx, claim_rx) = mpsc::channel::<Claim>(1);
    let gen = lock_recover(state).insert_device(device_id.clone(), claim_tx);
    tokio::spawn(device_watcher(
        device_id,
        gen,
        sink,
        stream,
        claim_rx,
        state.clone(),
    ));
}

/// 从路由表领回桌面连接：请求当前持有者（看守或桥接）交还半对。
async fn claim_device(state: &SharedState, device_id: &str) -> Result<Halves, String> {
    let (gen, claim_tx) = {
        let st = lock_recover(state);
        let c = st
            .devices
            .get(device_id)
            .ok_or_else(|| "connect: device offline".to_string())?;
        (c.gen, c.claim.clone())
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    // 持有者已退（连接关闭但登记未清）→ 离线（生产路径：get 与 send 之间持有者
    // 退出的竞态窗口；集成测试无法确定性构造，见覆盖率对账表）
    if claim_tx.send(reply_tx).await.is_err() {
        lock_recover(state).remove_device_if(device_id, gen);
        return Err("connect: device offline".into());
    }
    let halves = reply_rx.await;
    lock_recover(state).remove_device_if(device_id, gen);
    halves.map_err(|_| "connect: device offline".to_string())
}

/// 看守任务：托管空闲的桌面连接。
/// - 读到 Ping：tungstenite 已自动排好 Pong，下一轮 poll 读开始时 flush 出去；
/// - 读到 update_code：桌面中途换码宣告，更新码路由（旧实装把中途帧当垃圾丢弃，
///   「刷新配对码」后的新码对 relay 永远不存在）；
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
                Some(Ok(Message::Text(t))) => match protocol::update_code_of(&t) {
                    Some(code) => lock_recover(&state).announce_code(&device_id, &code),
                    // 空闲期间不该有其他数据帧：丢弃，不掐连接
                    None => eprintln!("relay: idle device {device_id} sent data frame, dropped"),
                },
                // 桌面优雅下线：close 应答已排队，刷出去再摘除登记
                Some(Ok(Message::Close(_))) => {
                    let _ = tokio::time::timeout(Duration::from_secs(2), sink.flush()).await;
                    break;
                }
                Some(Ok(_)) => {
                    eprintln!("relay: idle device {device_id} sent data frame, dropped");
                }
                _ => break, // Err / None
            }
        }
    }
    lock_recover(&state).remove_device_if(&device_id, gen);
}

/// 桥接结束原因：决定桌面半对的归宿（交还认领方 / 重挂看守 / 丢弃）。
enum BridgeEnd {
    /// 桌面半对存活，可重挂（手机优雅断开 / 手机腿断流或静默 / 认领方已走）
    Repark(Halves),
    /// 被新 connect 顶替：桌面半对已交还认领方，本侧不再持有
    Superseded,
    /// 桌面半对死亡或被弃（桌面腿断 / Ping miss / 被新 register 顶代）：丢弃
    Discard,
}

/// 桥接循环单帧处置结论。
enum Step {
    Continue,
    End(BridgeReason),
}

/// 桥接结束的内部原因（loop 内 break 携带，loop 后统一映射到 BridgeEnd + 手机通知）。
enum BridgeReason {
    PhoneClosed,
    PhoneDead,
    /// 携带被顶替桥接的认领回应（loop 后交还半对）。
    Superseded(Claim),
    /// 桥接期间同 device_id 来了新 register，claim 通道被顶掉。
    Replaced,
    DesktopGone,
}

/// 双向转发循环，带双向活体检测：
/// - 手机腿：keepalive 消费不转发并武装 60s 静默超时（opt-in：没见过 keepalive 的
///   老客户端不启用，保持旧行为）；武装后任何帧重置时钟；超时 = 手机腿死；
/// - 桌面腿：每 30s 发 Ping，Pong 消费不转发（旧实装把 Pong 转给手机），连 3 次
///   miss 判桌面腿死——合盖静默丢包不再劫持手机；
/// - 桌面腿 update_code 消费（更新码路由）不转发；
/// - 两腿解析失败/非控制帧一律原样转发（哑管道契约）。
async fn bridge(
    phone_sink: &mut WsSink,
    phone_stream: &mut WsStream,
    halves: Halves,
    mut claim_rx: mpsc::Receiver<Claim>,
    state: &SharedState,
    device_id: &str,
) -> BridgeEnd {
    let (mut d_sink, mut d_stream) = halves;
    let lv = lock_recover(state).liveness;
    let mut silence_deadline: Option<tokio::time::Instant> = None;
    let mut ping_tick = tokio::time::interval(lv.desktop_ping);
    ping_tick.tick().await; // 吞掉立即首 tick：首个 Ping 落在 30s
    let mut ping_miss = 0u32;

    let reason = loop {
        let silence = match silence_deadline {
            Some(dl) => Either::Left(tokio::time::sleep_until(dl)),
            None => Either::Right(futures_util::future::pending::<()>()),
        };
        tokio::select! {
            _ = silence => break BridgeReason::PhoneDead,
            claimed = claim_rx.recv() => match claimed {
                Some(reply) => break BridgeReason::Superseded(reply),
                None => break BridgeReason::Replaced,
            },
            _ = ping_tick.tick() => {
                // 生产路径：tick 时刻桌面腿恰半死；集成测试无法确定性构造
                if d_sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break BridgeReason::DesktopGone;
                }
                ping_miss += 1;
                if ping_miss >= lv.ping_max_miss {
                    break BridgeReason::DesktopGone;
                }
            },
            // 手机腿读 → 转发给桌面腿（forward = d_sink）
            msg = phone_stream.next() => match phone_frame(msg, &mut d_sink, &mut silence_deadline, lv.phone_silence).await {
                Step::Continue => {}
                Step::End(r) => break r,
            },
            // 桌面腿读 → 转发给手机腿（forward = phone_sink）
            msg = d_stream.next() => match desktop_frame(msg, phone_sink, &mut ping_miss, state, device_id).await {
                Step::Continue => {}
                Step::End(r) => break r,
            },
        }
    };

    match reason {
        BridgeReason::Superseded(reply) => match reply.send((d_sink, d_stream)) {
            Ok(()) => {
                notice_phone_close(phone_sink, ConnectErrorReason::Superseded).await;
                BridgeEnd::Superseded
            }
            // 认领方已走（oneshot 退还半对）：桌面连接健康，按手机腿断处理重挂
            // （生产路径：claim 应答期间认领方连接死亡；集成测试无法确定性构造）
            Err(h) => BridgeEnd::Repark(h),
        },
        BridgeReason::PhoneClosed => {
            // 手机优雅断开：把 tungstenite 排队的 close 应答刷出去，握手收尾
            let _ = tokio::time::timeout(Duration::from_secs(2), phone_sink.close()).await;
            BridgeEnd::Repark((d_sink, d_stream))
        }
        BridgeReason::PhoneDead => BridgeEnd::Repark((d_sink, d_stream)),
        BridgeReason::Replaced => {
            notice_phone_close(phone_sink, ConnectErrorReason::DeviceOffline).await;
            BridgeEnd::Discard
        }
        BridgeReason::DesktopGone => {
            notice_phone_close(phone_sink, ConnectErrorReason::DeviceOffline).await;
            // 桌面优雅下线时 close 应答已排队：刷出去再丢弃半对
            let _ = tokio::time::timeout(Duration::from_secs(2), d_sink.close()).await;
            BridgeEnd::Discard
        }
    }
}

/// 手机腿单帧处置（forward = 桌面腿写侧）：Close → 交给 loop 后刷应答；
/// keepalive → 武装/重置静默时钟并消费；其余帧在已武装时重置时钟后原样转发
/// （解析失败也转发，哑管道契约）；转发写失败 = 桌面腿死。
async fn phone_frame(
    msg: Option<Result<Message, WsError>>,
    forward: &mut WsSink,
    silence: &mut Option<tokio::time::Instant>,
    phone_silence: Duration,
) -> Step {
    let m = match msg {
        Some(Ok(m)) => m,
        _ => return Step::End(BridgeReason::PhoneDead),
    };
    if let Message::Close(_) = m {
        return Step::End(BridgeReason::PhoneClosed);
    }
    let deadline = || Some(tokio::time::Instant::now() + phone_silence);
    if let Message::Text(t) = &m {
        if protocol::is_keepalive(t) {
            *silence = deadline(); // 首帧 keepalive 武装静默超时（opt-in 入口）
            return Step::Continue;
        }
    }
    if silence.is_some() {
        *silence = deadline(); // 已武装：任何手机腿帧都是活体证据
    }
    // 生产路径：转发瞬间桌面腿半死；集成测试无法确定性构造，见覆盖率对账表
    if forward.send(m).await.is_err() {
        return Step::End(BridgeReason::DesktopGone);
    }
    Step::Continue
}

/// 桌面腿单帧处置（forward = 手机腿写侧）：Pong 清零 miss；Ping 不转发（自动 Pong
/// 已排队）；Close/断流 → 桌面死（应答 loop 后刷）；update_code 消费更新码路由；
/// 其余原样转发，转发写失败 = 手机腿死。
async fn desktop_frame(
    msg: Option<Result<Message, WsError>>,
    forward: &mut WsSink,
    ping_miss: &mut u32,
    state: &SharedState,
    device_id: &str,
) -> Step {
    let m = match msg {
        Some(Ok(m)) => m,
        _ => return Step::End(BridgeReason::DesktopGone),
    };
    match m {
        Message::Pong(_) => {
            *ping_miss = 0;
            Step::Continue
        }
        Message::Ping(_) => Step::Continue,
        Message::Close(_) => Step::End(BridgeReason::DesktopGone),
        m => {
            let code = match &m {
                Message::Text(t) => protocol::update_code_of(t),
                _ => None,
            };
            match code {
                Some(code) => {
                    lock_recover(state).announce_code(device_id, &code);
                    Step::Continue
                }
                None => {
                    // 生产路径：转发瞬间手机腿半死；集成测试无法确定性构造
                    if forward.send(m).await.is_err() {
                        Step::End(BridgeReason::PhoneDead)
                    } else {
                        Step::Continue
                    }
                }
            }
        }
    }
}

/// 桥接收尾：摘本代登记；仅 Repark 且桥接期间无人重登（新代已占表）才重挂看守
/// （保留既存守卫：盲重挂会把桥接期间的新登记覆盖成僵尸）。
/// 配对码路由在此不动：码生命周期 = 桌面宣告 + TTL（旧实装 teardown 删光码路由，
/// 桌面仍展示的未过期码会话一结束即失效）。
fn finish_bridge(state: &SharedState, device_id: &str, gen: u64, end: BridgeEnd) {
    let halves = {
        let mut st = lock_recover(state);
        st.remove_device_if(device_id, gen);
        match end {
            BridgeEnd::Repark(h) if !st.devices.contains_key(device_id) => Some(h),
            _ => None,
        }
    };
    if let Some((sink, stream)) = halves {
        park_device(state, device_id.to_string(), sink, stream);
    }
}
