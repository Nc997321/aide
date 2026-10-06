//! 一条 WebSocket 的驱动循环：读 → [`Connection`]，[`Connection`] 的输出 → 写，每秒一个 tick。

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::unbounded_channel;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::LinkHost;
use crate::secure::WireFrame;

/// 驱动循环的结局。
#[derive(Debug, PartialEq, Eq)]
pub enum End {
    /// 对端关了 / 流断了。
    PeerClosed,
    /// Host 终止了这条连接（`bye` / `sc_err` 已发完）。
    HostClosed,
    Error(String),
}

async fn send_frame<S>(sink: &mut S, f: &WireFrame) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let text = serde_json::to_string(f).map_err(|e| e.to_string())?;
    sink.send(Message::Text(text)).await.map_err(|e| e.to_string())
}

/// 驱动一条 WebSocket 直到结束：一条腿 = 一个 [`Connection`]，对端关 / Host 终止（`bye` / `sc_err`）= 这条腿的终点，
/// 返回时 `Connection` 随之丢弃（会话与总线订阅一并结束）。直连与中继桥接腿共用。
pub async fn drive<S>(ws: WebSocketStream<S>, host: &LinkHost) -> End
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut sink, mut stream) = ws.split();
    let (wire_tx, mut wire_rx) = unbounded_channel::<WireFrame>();
    let mut conn = host.connection(wire_tx);
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Text(t))) => conn.on_wire_text(&t).await,
                Some(Ok(Message::Close(_))) | None => return End::PeerClosed,
                Some(Ok(_)) => {} // ping / pong（tungstenite 自动应答）/ 二进制：忽略
                Some(Err(e)) => return End::Error(e.to_string()),
            },
            Some(frame) = wire_rx.recv() => {
                if let Err(e) = send_frame(&mut sink, &frame).await {
                    return End::Error(e);
                }
            }
            _ = tick.tick() => conn.on_tick(Instant::now()),
        }
        if conn.is_closed() {
            // 先让最后的 `bye` 加密进通道、发完剩下的，再决定关不关连接
            conn.flush().await;
            while let Ok(f) = wire_rx.try_recv() {
                if let Err(e) = send_frame(&mut sink, &f).await {
                    return End::Error(e);
                }
            }
            let _ = sink.close().await;
            return End::HostClosed;
        }
    }
}
