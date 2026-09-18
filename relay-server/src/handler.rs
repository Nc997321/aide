use std::time::{Duration, Instant};

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

/// 空闲丢帧日志限频窗口：桌面未桥接期间事件帧照常到达（全量转发设计），
/// 逐条记录 = 按事件速率刷屏（2026-09-12 实测 ~5 条/秒 ≈ 30MB/天），改按窗口结算。
const DROP_LOG_WINDOW_SECS: u64 = 60;

/// 空闲丢帧日志限频器（看守任务本地态，不跨任务共享）：
/// 首条立即记（单发丢帧仍可见），窗口内静默计数，窗口到点/看守死亡退出时带计数汇总。
/// 认领交班路径不补报：`device_watcher` 的 claim 分支直接 return（连接没死、帧流归
/// 桥接），未满窗口的存量计数随之作废——诊断用途可接受，勿当账目用。
/// 时钟经参数注入（now），纯逻辑可单测。
struct IdleDropLog {
    window: Duration,
    last_emit: Option<Instant>,
    suppressed: u64,
}

impl IdleDropLog {
    fn new(window: Duration) -> Self {
        Self { window, last_emit: None, suppressed: 0 }
    }

    /// 记一次丢帧；Some(文案) = 该打日志了。计数为 1 时保持原指纹（无后缀），
    /// 否则带 `suppressed N`；两种文案都含「idle device / dropped」grep 指纹。
    fn record(&mut self, now: Instant) -> Option<String> {
        self.suppressed += 1;
        let due = match self.last_emit {
            None => true,
            Some(last) => now.duration_since(last) >= self.window,
        };
        if !due {
            return None;
        }
        let n = self.suppressed;
        self.suppressed = 0;
        self.last_emit = Some(now);
        Some(if n == 1 {
            "sent data frame, dropped".to_string()
        } else {
            format!("sent data frame, dropped (suppressed {n} in last {:?})", self.window)
        })
    }

    /// 看守退出时结算未满窗口的存量计数。
    fn flush_tail(&mut self) -> Option<String> {
        let n = std::mem::take(&mut self.suppressed);
        (n > 0).then(|| format!("sent data frame, dropped (suppressed {n} before close)"))
    }
}

/// 限频打印一条空闲丢帧（两处帧分支共用）。
fn idle_drop(log: &mut IdleDropLog, device_id: &str) {
    if let Some(msg) = log.record(Instant::now()) {
        eprintln!("relay: idle device {device_id} {msg}");
    }
}

/// 看守退出：补报存量丢帧计数。
fn idle_drop_flush(log: &mut IdleDropLog, device_id: &str) {
    if let Some(msg) = log.flush_tail() {
        eprintln!("relay: idle device {device_id} {msg}");
    }
}

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
            // 顶替探测与码宣告同锁：探测必须落在 insert_device（park_device 内）
            // 之前——旧登记被覆盖时其看守/桥接收 None 退出并丢弃连接，正是双实例
            // 互踢战争的形态，日志要能一眼看出。探测与 insert 非原子（跨锁窗口），
            // 日志用途可接受。码路由只经宣告进出（register 是首次宣告）；
            // 桥接收尾不再删路由。
            let superseded = {
                let mut st = lock_recover(&state);
                let superseded = st.devices.contains_key(&device_id);
                st.announce_code(&device_id, code);
                superseded
            };
            park_device(&state, device_id.clone(), sink, stream);
            // register 每次都是新连接新任务，限频器状态只能挂 RelayState（跨任务
            // 存活）；文案恒含 registered device 指纹，与旧裸 eprintln 的 grep 兼容。
            // 注意 RelayState 的 Instant 是 tokio 的（CodeEntry 同源），与本文件
            // IdleDropLog 的 std Instant 不同族，此处全限定避免混用。
            if let Some(line) = lock_recover(&state).note_register(
                tokio::time::Instant::now(),
                &device_id,
                superseded,
            ) {
                eprintln!("relay: {line}");
            }
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
    let mut drop_log = IdleDropLog::new(Duration::from_secs(DROP_LOG_WINDOW_SECS));
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
                    None => idle_drop(&mut drop_log, &device_id),
                },
                // 桌面优雅下线：close 应答已排队，刷出去再摘除登记
                Some(Ok(Message::Close(_))) => {
                    let _ = tokio::time::timeout(Duration::from_secs(2), sink.flush()).await;
                    break;
                }
                Some(Ok(_)) => idle_drop(&mut drop_log, &device_id),
                _ => break, // Err / None
            }
        }
    }
    idle_drop_flush(&mut drop_log, &device_id);
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

#[cfg(test)]
mod idle_drop_log_tests {
    use super::*;

    /// 分支对账表（record / flush_tail 全臂）：
    /// | 分支 | 覆盖测试 |
    /// |---|---|
    /// | record: 首条（last_emit=None）→ 立即发、素指纹 | first_drop_emits_plain_fingerprint |
    /// | record: 窗口内 → 静默 None | drops_within_window_are_suppressed |
    /// | record: 窗口到点 → 发 + 计数文案 | window_elapsed_emits_with_count |
    /// | record: 边界 == window（>= 语义）→ 发 | window_boundary_emits_plain_when_single |
    /// | record: 结算计数 == 1 → 素指纹 | window_boundary_emits_plain_when_single |
    /// | flush_tail: 存量 > 0 → 发 + 清零 | tail_flush_reports_pending_then_resets |
    /// | flush_tail: 存量 = 0 → None | tail_flush_none_when_nothing_pending |
    /// 调用点（`device_watcher` 两处薄包装，stderr 不断言，逻辑臂由上面测试兜）：
    /// | idle_drop: Some（到点）→ eprintln | 间接：集成 parked_watcher_drops_stray_data_frame |
    /// | idle_drop: None（窗口内）→ 静默 | 调用点无断言（逻辑臂同上） |
    /// | idle_drop_flush: Some / None | 调用点无断言（逻辑臂同上） |

    #[test]
    fn first_drop_emits_plain_fingerprint() {
        let mut log = IdleDropLog::new(Duration::from_secs(60));
        assert_eq!(log.record(Instant::now()).as_deref(), Some("sent data frame, dropped"));
    }

    #[test]
    fn drops_within_window_are_suppressed() {
        let mut log = IdleDropLog::new(Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(log.record(t0).is_some());
        assert_eq!(log.record(t0 + Duration::from_secs(1)), None);
        assert_eq!(log.record(t0 + Duration::from_secs(59)), None);
    }

    #[test]
    fn window_elapsed_emits_with_count() {
        let mut log = IdleDropLog::new(Duration::from_secs(60));
        let t0 = Instant::now();
        log.record(t0); // 首发清零
        for i in 1..=5 {
            log.record(t0 + Duration::from_secs(i)); // 窗口内静默，累计 5
        }
        let msg = log.record(t0 + Duration::from_secs(60)).expect("窗口到点应结算");
        // 全文断言：文案即运维 grep 指纹；缺括号/丢前缀的回归只查 contains 拦不住
        assert_eq!(msg, "sent data frame, dropped (suppressed 6 in last 60s)");
    }

    #[test]
    fn window_boundary_emits_plain_when_single() {
        let mut log = IdleDropLog::new(Duration::from_secs(60));
        let t0 = Instant::now();
        log.record(t0); // 首发
        // 边界（恰好 == window）到点；窗口内只积了 1 条 → 素指纹
        let msg = log.record(t0 + Duration::from_secs(60)).expect("边界应结算");
        assert_eq!(msg, "sent data frame, dropped");
    }

    #[test]
    fn tail_flush_reports_pending_then_resets() {
        let mut log = IdleDropLog::new(Duration::from_secs(60));
        let t0 = Instant::now();
        log.record(t0); // 首发清零
        log.record(t0 + Duration::from_secs(1));
        log.record(t0 + Duration::from_secs(2)); // 存量 2
        let msg = log.flush_tail().expect("存量应结算");
        assert_eq!(msg, "sent data frame, dropped (suppressed 2 before close)");
        assert!(log.flush_tail().is_none(), "结算后应清零");
    }

    #[test]
    fn tail_flush_none_when_nothing_pending() {
        let mut log = IdleDropLog::new(Duration::from_secs(60));
        assert!(log.flush_tail().is_none());
        log.record(Instant::now()); // 计数已随首发清零
        assert!(log.flush_tail().is_none());
    }
}
