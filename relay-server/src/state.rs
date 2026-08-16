use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use futures_util::stream::{SplitSink, SplitStream};

pub type Ws = WebSocketStream<TcpStream>;
pub type WsSink = SplitSink<Ws, Message>;
pub type WsStream = SplitStream<Ws>;

/// 路由表：device_id → 桌面连接（split 后的 sink/stream）；pairing_code → device_id。
/// 哑管道——不理解应用协议，只做路由 + 双向帧转发。
#[derive(Default)]
pub struct RelayState {
    pub devices: HashMap<String, (WsSink, WsStream)>,
    pub codes: HashMap<String, String>,
}

pub type SharedState = Arc<Mutex<RelayState>>;
