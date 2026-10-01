//! 经中继：Host **主动出站**连中继、用 `device_id` 注册，然后在这条连接上等手机（Host 不用开任何端口）。
//!
//! 中继把空闲的 Host 连接「挂起」；手机 `connect{device_id}` 后，中继把两端字节桥接起来。手机优雅离开
//! 时中继会把 Host 这条连接重新挂起（**不通知 Host**），所以这里的 [`Connection`](crate::Connection) 是
//! *可重启*的：下一次 `sc_init` 到来就是新手机会话的开始。连接本身断了（中继重启 / 网络）才重连。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

use super::driver::drive;
use super::LinkHost;

/// 连接存活 ≥ 该时长才重置退避；短命连接（被同 device_id 的新注册顶替 / 注册后秒断）并入指数退避，
/// 免得互踢放大成热循环（2026-09-18 旧网关的教训）。
const STABLE_CONN: Duration = Duration::from_secs(30);
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

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

/// 中继的 WebSocket 地址（与手机一致：`<relay>/ws`）。
pub fn ws_url(relay: &str) -> String {
    format!("{}/ws", relay.trim_end_matches('/'))
}

/// 中继层注册帧（Link 的 Host 不带配对码）。
pub fn register_frame(device_id: &str) -> String {
    serde_json::json!({ "type": "register", "device_id": device_id }).to_string()
}

/// 主循环：连中继 → 注册 → 驱动，断开后指数退避重连。永不返回（取消 = 停）。
pub async fn run(host: LinkHost, relay_url: String, status: Arc<RelayStatus>) {
    let mut backoff = BACKOFF_START;
    loop {
        let started = Instant::now();
        match connect_once(&host, &relay_url, &status).await {
            Ok(()) if started.elapsed() >= STABLE_CONN => backoff = BACKOFF_START,
            Ok(()) => {}
            Err(e) => {
                tracing::info!("link relay: {e}");
                status.set(false, Some(e));
            }
        }
        status.connected.store(false, Ordering::Relaxed);
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

async fn connect_once(host: &LinkHost, relay_url: &str, status: &RelayStatus) -> Result<(), String> {
    let url = ws_url(relay_url);
    let (mut ws, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .map_err(|e| format!("无法连接中继 {url}：{e}"))?;
    ws.send(Message::Text(register_frame(host.identity.device_id())))
        .await
        .map_err(|e| format!("向中继注册失败：{e}"))?;
    status.set(true, None);
    tracing::info!("link relay: registered as {} at {url}", host.identity.device_id());
    let end = drive(ws, host, true).await;
    Err(format!("与中继的连接已断开（{end:?}）"))
}
