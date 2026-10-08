//! 经中继：Host **主动出站**连中继（Host 不用开任何端口），分两种连接：
//!
//! - **控制腿**：`register{device_id, proto:2}` 注册后常驻，只收中继的 `incoming{bridge_id}` 通知，不承载任何业务字节；
//! - **桥接腿**：每来一部手机，中继发 `incoming`，Host **新开一条**出站连接、首帧 `attach{bridge_id}`，
//!   中继把它与手机腿桥接。桥接结束中继关掉这条腿，**永不复用**。
//!
//! 所以一次手机连接 = 一条专属腿 = 一个 [`Connection`](crate::Connection)，与直连 WebSocket 完全同构：
//! 会话生命周期就是腿的生命周期，不存在「手机走了、会话还挂在总线上、往下一部手机的腿里泵旧密钥密文」的窗口
//! （旧模型：腿被顺序复用，靠下一个 `sc_init` 才发现手机换了——僵尸会话把旧密文塞进新手机的握手里，手机瞬断重连循环）。
//!
//! 单设备模型在 Host 侧同样成立：同一时刻至多一条桥接任务，新的 `incoming` 到来先终止旧的。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use super::driver::drive;
use super::LinkHost;

/// 连接存活 ≥ 该时长才重置退避；短命连接（被同 device_id 的新注册顶替 / 注册后秒断）并入指数退避，
/// 免得互踢放大成热循环（2026-09-18 旧网关的教训）。
const STABLE_CONN: Duration = Duration::from_secs(30);
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// 控制腿多久没收到中继任何帧（含 Ping）就判死：中继每 30 s 发 Ping，容 3 次（对称于中继对 Host 的活体判据）。
/// 没有它，半开连接（NAT 超时 / 中继被杀不发 FIN）会让 Host 一直显示「已连接」而手机永远 device_offline。
const CONTROL_DEAD_AFTER: Duration = Duration::from_secs(100);
/// 拨回桥接腿（连接 + attach）的上限：与中继等 attach 的上限同量级，超了手机那边已经放弃了。
const ATTACH_DIAL_TIMEOUT: Duration = Duration::from_secs(8);

/// 中继连接状态（给 Host 设置面板显示）。
#[derive(Default)]
pub struct RelayStatus {
    connected: AtomicBool,
    last_error: Mutex<String>,
}

impl RelayStatus {
    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn last_error(&self) -> String {
        self.last_error.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn set(&self, connected: bool, error: Option<String>) {
        self.connected.store(connected, Ordering::Relaxed);
        if let Some(e) = error {
            *self.last_error.lock().unwrap_or_else(PoisonError::into_inner) = e;
        } else if connected {
            self.last_error.lock().unwrap_or_else(PoisonError::into_inner).clear();
        }
    }
}

/// 中继的 WebSocket 地址（与手机一致：`<relay>/ws`）。设置里填的若已带 `/ws` 就不再重复追加
/// （2026-10-01 真机：填了 `ws://127.0.0.1:8787/ws`，被拼成 `…/ws/ws`）。
pub fn ws_url(relay: &str) -> String {
    let base = relay.trim_end_matches('/');
    if base.ends_with("/ws") {
        base.to_string()
    } else {
        format!("{base}/ws")
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_control, ws_url, Control};

    #[test]
    fn control_frames_parse() {
        assert_eq!(parse_control(r#"{"type":"incoming","bridge_id":"ab12"}"#), Control::Incoming("ab12".into()));
        assert_eq!(
            parse_control(r#"{"type":"register_error","reason":"unsupported_proto"}"#),
            Control::RegisterError("unsupported_proto".into())
        );
        assert_eq!(parse_control(r#"{"type":"incoming"}"#), Control::Unknown);
        assert_eq!(parse_control("not json"), Control::Unknown);
    }

    #[test]
    fn the_ws_path_is_appended_once() {
        assert_eq!(ws_url("ws://relay.example"), "ws://relay.example/ws");
        assert_eq!(ws_url("ws://relay.example/"), "ws://relay.example/ws");
        assert_eq!(ws_url("ws://relay.example/ws"), "ws://relay.example/ws");
        assert_eq!(ws_url("wss://relay.example/ws/"), "wss://relay.example/ws");
    }
}

/// 中继层注册帧（Link 的 Host 不带配对码）。`proto:2` = 控制腿 + 一次性桥接腿的连接模型，
/// 与中继版本不匹配时中继回 `register_error{unsupported_proto}`。
pub fn register_frame(device_id: &str) -> String {
    serde_json::json!({ "type": "register", "device_id": device_id, "proto": 2 }).to_string()
}

/// 拨回桥接腿的首帧：认领中继 `incoming` 里给的那次桥接。
pub fn attach_frame(bridge_id: &str) -> String {
    serde_json::json!({ "type": "attach", "bridge_id": bridge_id }).to_string()
}

/// 当前桥接任务的持有者：至多一个（单设备模型）；被丢弃（`run` 被取消）时一并终止，不留孤儿桥接。
#[derive(Default)]
struct BridgeSlot(Mutex<Option<JoinHandle<()>>>);

impl BridgeSlot {
    /// 换上新桥接，终止旧的（旧桥接的 `Connection` 随 future 一起被丢弃 → 会话与订阅结束）。
    fn replace(&self, next: JoinHandle<()>) {
        let old = self.0.lock().unwrap_or_else(PoisonError::into_inner).replace(next);
        if let Some(old) = old {
            old.abort();
        }
    }
}

impl Drop for BridgeSlot {
    fn drop(&mut self) {
        if let Some(h) = self.0.get_mut().unwrap_or_else(PoisonError::into_inner).take() {
            h.abort();
        }
    }
}

/// 主循环：连中继 → 注册控制腿 → 按 `incoming` 拨回桥接腿；控制腿断开后指数退避重连。永不返回（取消 = 停）。
pub async fn run(host: LinkHost, relay_url: String, status: Arc<RelayStatus>) {
    let slot = BridgeSlot::default();
    let mut backoff = BACKOFF_START;
    loop {
        let started = Instant::now();
        let err = connect_once(&host, &relay_url, &status, &slot).await;
        tracing::info!("link relay: {err}");
        status.set(false, Some(err));
        // 活过 STABLE_CONN 的连接断开 = 一次新的偶发故障，从头退避；短命连接才累加
        if started.elapsed() >= STABLE_CONN {
            backoff = BACKOFF_START;
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// 一次控制腿的生命周期；返回的是它结束的原因（控制腿本身永不「成功」结束）。
async fn connect_once(host: &LinkHost, relay_url: &str, status: &RelayStatus, slot: &BridgeSlot) -> String {
    let url = ws_url(relay_url);
    let mut ws = match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok((ws, _)) => ws,
        Err(e) => return format!("无法连接中继 {url}：{e}"),
    };
    if let Err(e) = ws.send(Message::Text(register_frame(host.identity.device_id()))).await {
        return format!("向中继注册失败：{e}");
    }
    status.set(true, None);
    tracing::info!("link relay: registered as {} at {url}", host.identity.device_id());
    loop {
        let msg = match tokio::time::timeout(CONTROL_DEAD_AFTER, ws.next()).await {
            Err(_) => return format!("中继 {}s 没有任何响应，判定连接已死", CONTROL_DEAD_AFTER.as_secs()),
            Ok(None) => return "与中继的连接已断开".into(),
            Ok(Some(Err(e))) => return format!("与中继的连接出错：{e}"),
            Ok(Some(Ok(m))) => m,
        };
        match msg {
            Message::Text(t) => match parse_control(&t) {
                Control::Incoming(bridge_id) => {
                    slot.replace(tokio::spawn(bridge(host.clone(), url.clone(), bridge_id)));
                }
                Control::RegisterError(reason) => return format!("中继拒绝了注册：{reason}"),
                Control::Unknown => {}
            },
            Message::Close(_) => return "与中继的连接已断开".into(),
            _ => {} // Ping（tungstenite 自动应答）/ Pong / 二进制：只当活体证据
        }
    }
}

/// 控制腿上中继发来的帧。
#[derive(Debug, PartialEq, Eq)]
enum Control {
    /// 有手机来了：拨回并 `attach{bridge_id}`。
    Incoming(String),
    /// 中继拒绝了注册（`unsupported_proto` = 中继版本与本 Host 的连接模型不匹配）。
    RegisterError(String),
    Unknown,
}

fn parse_control(text: &str) -> Control {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return Control::Unknown };
    let field = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    match v.get("type").and_then(|t| t.as_str()) {
        Some("incoming") => field("bridge_id").map_or(Control::Unknown, Control::Incoming),
        Some("register_error") => Control::RegisterError(field("reason").unwrap_or_default()),
        _ => Control::Unknown,
    }
}

/// 一次桥接：新开一条出站连接、`attach`，然后像直连一样驱动到结束。腿断 = 这次桥接的一切结束。
async fn bridge(host: LinkHost, url: String, bridge_id: String) {
    let dial = async {
        let (mut ws, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|e| e.to_string())?;
        ws.send(Message::Text(attach_frame(&bridge_id))).await.map_err(|e| e.to_string())?;
        Ok::<_, String>(ws)
    };
    let ws = match tokio::time::timeout(ATTACH_DIAL_TIMEOUT, dial).await {
        Ok(Ok(ws)) => ws,
        Ok(Err(e)) => return tracing::info!("link relay: attach failed: {e}"),
        Err(_) => return tracing::info!("link relay: attach timed out"),
    };
    let end = drive(ws, &host).await;
    tracing::debug!("link relay: bridge ended: {end:?}");
}
