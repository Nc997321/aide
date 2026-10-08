use std::time::Duration;

use futures_util::future::Either;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::protocol::{self, ConnectErrorReason};
use crate::state::{lock_recover, HostLeg, SharedState, WsSink, WsStream};

/// 单连接处理：首条消息决定这条连接的角色——
/// - `register`：Host **控制腿**（只传 `incoming` 通知，不承载业务字节）；
/// - `attach`：Host 应 `incoming` 拨回的**桥接腿**（一次性，桥接结束即关）；
/// - `connect`：手机腿。
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
        Some("register") => register_arm(&state, &v, sink, stream).await,
        Some("attach") => attach_arm(&state, &v, sink, stream),
        Some("connect") => connect_arm(&state, &v, &mut sink, &mut stream).await,
        _ => Err("unknown first message type".into()),
    }
}

// ───────────────────────── Host 控制腿 ─────────────────────────

/// register 分支：校验连接模型版本 → 登记控制腿 → 挂控制任务。
/// 旧模型的 Host（腿被顺序复用）不被接纳：两种模型混用就是僵尸会话的温床，宁可明确拒绝。
async fn register_arm(
    state: &SharedState,
    v: &serde_json::Value,
    mut sink: WsSink,
    stream: WsStream,
) -> Result<(), String> {
    let device_id = v
        .get("device_id")
        .and_then(|s| s.as_str())
        .ok_or("register: missing device_id")?
        .to_string();
    if v.get("proto").and_then(|p| p.as_u64()) != Some(protocol::HOST_PROTO) {
        eprintln!("relay: register {device_id} rejected: unsupported proto (host too old)");
        let _ = sink
            .send(Message::Text(protocol::register_error_frame("unsupported_proto")))
            .await;
        let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
        return Ok(());
    }
    // 旧协议 v2 的 `pairing_code` 字段被忽略：码路由已删除，配对靠二维码里的 device_id + 密钥，
    // 中继既不需要也不该知道任何配对秘密。
    // 顶替探测必须落在 insert_host 之前：旧登记被覆盖时其控制任务收 None 退出，
    // 正是双实例互踢战争的形态，日志要能一眼看出（探测与 insert 非原子，日志用途可接受）。
    let superseded = lock_recover(state).host_registered(&device_id);
    let (incoming_tx, incoming_rx) = mpsc::channel::<String>(4);
    let gen = lock_recover(state).insert_host(device_id.clone(), incoming_tx);
    tokio::spawn(control_task(
        device_id.clone(),
        gen,
        sink,
        stream,
        incoming_rx,
        state.clone(),
    ));
    // register 每次都是新连接新任务，限频器状态只能挂 RelayState（跨任务存活）；
    // 文案恒含 registered device 指纹。RelayState 的 Instant 是 tokio 的，此处全限定。
    if let Some(line) =
        lock_recover(state).note_register(tokio::time::Instant::now(), &device_id, superseded)
    {
        eprintln!("relay: {line}");
    }
    Ok(())
}

/// 控制腿任务：只做三件事——
/// - 把 `incoming{bridge_id}` 递给 Host；
/// - 每 `desktop_ping` 发 Ping、连 `ping_max_miss` 次无 Pong 判死（合盖静默丢包也能及时摘登记，
///   手机的 connect 立刻得 device_offline，而不是桥到一条半死的腿上等 attach 超时）；
/// - 读侧持续 poll（tungstenite 的自动 Pong 要靠读 poll 才刷出）。
///
/// 控制腿上 Host 不该发业务帧：收到的文本/二进制一律忽略（不转发给任何人）。
async fn control_task(
    device_id: String,
    gen: u64,
    mut sink: WsSink,
    mut stream: WsStream,
    mut incoming_rx: mpsc::Receiver<String>,
    state: SharedState,
) {
    let lv = lock_recover(&state).liveness;
    let mut ping_tick = tokio::time::interval(lv.desktop_ping);
    ping_tick.tick().await; // 吞掉立即首 tick
    let mut miss = 0u32;
    loop {
        tokio::select! {
            bridge_id = incoming_rx.recv() => match bridge_id {
                Some(id) => {
                    if sink.send(Message::Text(protocol::incoming_frame(&id))).await.is_err() {
                        break;
                    }
                }
                // 登记被同 device_id 的新控制腿覆盖（Host 重连 / 双实例）：本腿退役
                None => {
                    let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
                    break;
                }
            },
            _ = ping_tick.tick() => {
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
                miss += 1;
                if miss >= lv.ping_max_miss {
                    break;
                }
            }
            msg = stream.next() => match msg {
                Some(Ok(Message::Pong(_))) => miss = 0,
                Some(Ok(Message::Close(_))) => {
                    // 优雅下线：close 应答已排队，刷出去再摘登记
                    let _ = tokio::time::timeout(Duration::from_secs(2), sink.flush()).await;
                    break;
                }
                Some(Ok(_)) => {} // Ping（自动应答）/ 控制腿上不该有的业务帧：忽略
                _ => break,       // Err / None
            }
        }
    }
    lock_recover(&state).remove_host_if(&device_id, gen);
}

// ───────────────────────── Host 桥接腿 ─────────────────────────

/// attach 分支：Host 应某次 `incoming` 拨回。认领 = 把这条腿交给等待中的手机连接任务。
/// bridge_id 不存在（超时已撤 / 重复 / 乱猜）→ 直接关，不给原因（无人该收到）。
fn attach_arm(
    state: &SharedState,
    v: &serde_json::Value,
    sink: WsSink,
    stream: WsStream,
) -> Result<(), String> {
    let bridge_id = v
        .get("bridge_id")
        .and_then(|s| s.as_str())
        .ok_or("attach: missing bridge_id")?;
    let claim = lock_recover(state)
        .take_pending(bridge_id)
        .ok_or("attach: unknown or expired bridge_id")?;
    // 手机连接任务已放弃（oneshot 收端没了）：腿随 Err 里退还的两半一起丢弃 = 关闭
    let _ = claim.send((sink, stream));
    Ok(())
}

// ───────────────────────── 手机腿 ─────────────────────────

/// connect 分支：解析路由 → 顶替该设备此前的桥接 → 经控制腿叫 Host 拨回 → 桥接 → 收尾。
async fn connect_arm(
    state: &SharedState,
    v: &serde_json::Value,
    sink: &mut WsSink,
    stream: &mut WsStream,
) -> Result<(), String> {
    let device_id = match resolve_device(v) {
        Ok(id) => id,
        Err(reason) => return reject_connect(sink, reason).await,
    };
    let (incoming, lv) = {
        let st = lock_recover(state);
        (st.host_incoming(&device_id), st.liveness)
    };
    let Some(incoming) = incoming else {
        eprintln!("relay: connect -> {device_id} failed: device offline");
        return reject_connect(sink, ConnectErrorReason::DeviceOffline).await;
    };

    // 先占桥接位（顶替旧桥），再叫 Host 拨回：占位之后的任何新 connect 都会顶替本次，
    // 本次在等待期间也要能响应被顶替。
    let (gen, mut kick_rx) = lock_recover(state).begin_bridge(&device_id);
    let bridge_id = protocol::new_bridge_id();
    let leg_rx = lock_recover(state).add_pending(bridge_id.clone());

    let outcome = async {
        if tokio::time::timeout(lv.attach_timeout, incoming.send(bridge_id.clone()))
            .await
            .map_or(true, |r| r.is_err())
        {
            return Err(ConnectErrorReason::DeviceOffline);
        }
        tokio::select! {
            leg = tokio::time::timeout(lv.attach_timeout, leg_rx) => match leg {
                Ok(Ok(leg)) => Ok(leg),
                _ => Err(ConnectErrorReason::DeviceOffline),
            },
            _ = kick_rx.recv() => Err(ConnectErrorReason::Superseded),
        }
    }
    .await;
    // 控制腿的发送端不能在桥接期间一直捏在手里：被新 register 覆盖的旧控制腿要靠它全部释放才会退役
    drop(incoming);
    lock_recover(state).drop_pending(&bridge_id);

    match outcome {
        Ok(leg) => {
            eprintln!("bridging phone -> {device_id}");
            bridge(sink, stream, leg, kick_rx, lv).await;
        }
        Err(reason) => {
            eprintln!("relay: connect -> {device_id} not bridged ({})", reason_label(reason));
            notice_phone_close(sink, reason).await;
        }
    }
    lock_recover(state).end_bridge_if(&device_id, gen);
    Ok(())
}

fn reason_label(r: ConnectErrorReason) -> &'static str {
    match r {
        ConnectErrorReason::UnknownCode => "unknown_code",
        ConnectErrorReason::DeviceOffline => "device_offline",
        ConnectErrorReason::Superseded => "superseded",
    }
}

/// connect 首消息路由解析：只按 device_id；旧协议的 `connect{code}` 恒 unknown_code，缺 device_id → 拒绝。
fn resolve_device(v: &serde_json::Value) -> Result<String, ConnectErrorReason> {
    if v.get("code").is_some() {
        return Err(ConnectErrorReason::UnknownCode);
    }
    v.get("device_id")
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .ok_or(ConnectErrorReason::DeviceOffline)
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

/// 给手机腿发原因帧后关连接（被顶替 / Host 离线场景）；发送失败（腿已死）即放弃
/// （生产路径：手机腿单向静默丢包；集成测试无法确定性构造）。
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

// ───────────────────────── 桥接 ─────────────────────────

/// 桥接结束的原因。
enum BridgeEnd {
    PhoneClosed,
    PhoneDead,
    /// 被同设备的新 connect 顶替。
    Superseded,
    /// Host 桥接腿断 / Ping miss。
    HostGone,
}

/// 桥接循环单帧处置结论。
enum Step {
    Continue,
    End(BridgeEnd),
}

/// 双向转发循环，带双向活体检测：
/// - 手机腿：keepalive 消费不转发并武装静默超时（opt-in：没见过 keepalive 的老客户端不启用，
///   保持旧行为）；武装后任何帧重置时钟；超时 = 手机腿死；
/// - Host 腿：每 `desktop_ping` 发 Ping，Pong 消费不转发，连 `ping_max_miss` 次 miss 判死——
///   合盖静默丢包不再劫持手机；
/// - 两腿解析失败/非控制帧一律原样转发（哑管道契约）。
///
/// **桥接腿一次性**：循环退出后无论原因，Host 腿一律关闭、永不复用——Host 侧据此在同一时刻
/// 结束这次桥接对应的整条协议栈（会话 / 总线订阅 / 泵），不可能有「手机走了会话还活着」的窗口。
async fn bridge(
    phone_sink: &mut WsSink,
    phone_stream: &mut WsStream,
    leg: HostLeg,
    mut kick_rx: mpsc::Receiver<()>,
    lv: crate::state::LivenessCfg,
) {
    let (mut h_sink, mut h_stream) = leg;
    let mut silence_deadline: Option<tokio::time::Instant> = None;
    let mut ping_tick = tokio::time::interval(lv.desktop_ping);
    ping_tick.tick().await; // 吞掉立即首 tick：首个 Ping 落在一个间隔后
    let mut ping_miss = 0u32;

    let end = loop {
        let silence = match silence_deadline {
            Some(dl) => Either::Left(tokio::time::sleep_until(dl)),
            None => Either::Right(futures_util::future::pending::<()>()),
        };
        tokio::select! {
            _ = silence => break BridgeEnd::PhoneDead,
            // 发送端只在被顶替时用掉（登记只有本桥自己会摘），收到任何结果都是「被顶替」
            _ = kick_rx.recv() => break BridgeEnd::Superseded,
            _ = ping_tick.tick() => {
                // 生产路径：tick 时刻 Host 腿恰半死；集成测试无法确定性构造
                if h_sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break BridgeEnd::HostGone;
                }
                ping_miss += 1;
                if ping_miss >= lv.ping_max_miss {
                    break BridgeEnd::HostGone;
                }
            },
            // 手机腿读 → 转发给 Host 腿
            msg = phone_stream.next() => match phone_frame(msg, &mut h_sink, &mut silence_deadline, lv.phone_silence).await {
                Step::Continue => {}
                Step::End(r) => break r,
            },
            // Host 腿读 → 转发给手机腿
            msg = h_stream.next() => match host_frame(msg, phone_sink, &mut ping_miss).await {
                Step::Continue => {}
                Step::End(r) => break r,
            },
        }
    };

    match end {
        BridgeEnd::Superseded => notice_phone_close(phone_sink, ConnectErrorReason::Superseded).await,
        // 手机优雅断开：把 tungstenite 排队的 close 应答刷出去，握手收尾
        BridgeEnd::PhoneClosed => {
            let _ = tokio::time::timeout(Duration::from_secs(2), phone_sink.close()).await;
        }
        BridgeEnd::PhoneDead => {}
        BridgeEnd::HostGone => notice_phone_close(phone_sink, ConnectErrorReason::DeviceOffline).await,
    }
    // 一次性腿：关掉（Host 驱动循环读到 Close 即结束整条协议栈）。已死的腿 close 只是空转。
    let _ = tokio::time::timeout(Duration::from_secs(2), h_sink.close()).await;
}

/// 手机腿单帧处置（forward = Host 腿写侧）：Close → 交给 loop 后刷应答；
/// keepalive → 武装/重置静默时钟并消费；其余帧在已武装时重置时钟后原样转发
/// （解析失败也转发，哑管道契约）；转发写失败 = Host 腿死。
async fn phone_frame(
    msg: Option<Result<Message, WsError>>,
    forward: &mut WsSink,
    silence: &mut Option<tokio::time::Instant>,
    phone_silence: Duration,
) -> Step {
    let m = match msg {
        Some(Ok(m)) => m,
        _ => return Step::End(BridgeEnd::PhoneDead),
    };
    if let Message::Close(_) = m {
        return Step::End(BridgeEnd::PhoneClosed);
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
    // 生产路径：转发瞬间 Host 腿半死；集成测试无法确定性构造
    if forward.send(m).await.is_err() {
        return Step::End(BridgeEnd::HostGone);
    }
    Step::Continue
}

/// Host 腿单帧处置（forward = 手机腿写侧）：Pong 清零 miss；Ping 不转发（自动 Pong
/// 已排队）；Close/断流 → Host 死；其余原样转发，转发写失败 = 手机腿死。
async fn host_frame(
    msg: Option<Result<Message, WsError>>,
    forward: &mut WsSink,
    ping_miss: &mut u32,
) -> Step {
    let m = match msg {
        Some(Ok(m)) => m,
        _ => return Step::End(BridgeEnd::HostGone),
    };
    match m {
        Message::Pong(_) => {
            *ping_miss = 0;
            Step::Continue
        }
        Message::Ping(_) => Step::Continue,
        Message::Close(_) => Step::End(BridgeEnd::HostGone),
        m => {
            // 生产路径：转发瞬间手机腿半死；集成测试无法确定性构造
            if forward.send(m).await.is_err() {
                Step::End(BridgeEnd::PhoneDead)
            } else {
                Step::Continue
            }
        }
    }
}
