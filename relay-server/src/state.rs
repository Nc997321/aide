use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::stream::{SplitSink, SplitStream};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

pub type Ws = WebSocketStream<TcpStream>;
pub type WsSink = SplitSink<Ws, Message>;
pub type WsStream = SplitStream<Ws>;

/// connect 向某设备的看守任务请求交回连接
pub type Claim = oneshot::Sender<(WsSink, WsStream)>;

/// 一条已注册桌面连接在路由表中的登记项：
/// gen 是代数号（同 device_id 重连后自增，旧看守凭它避免误删新连接）；
/// claim 用来请看守任务把连接交还给 connect 桥接。
pub struct DeviceConn {
    pub gen: u64,
    pub claim: mpsc::Sender<Claim>,
}

/// 路由表：device_id → 桌面连接（看守任务托管，经 claim 领回）；pairing_code → device_id。
/// 哑管道——不理解应用协议，只做路由 + 双向帧转发。
#[derive(Default)]
pub struct RelayState {
    pub devices: HashMap<String, DeviceConn>,
    pub codes: HashMap<String, String>,
    next_gen: u64,
}

impl RelayState {
    /// 登记一条新代连接，返回其代数号
    pub fn insert_device(&mut self, device_id: String, claim: mpsc::Sender<Claim>) -> u64 {
        let gen = self.next_gen;
        self.next_gen += 1;
        self.devices.insert(device_id, DeviceConn { gen, claim });
        gen
    }

    /// 摘除指定代数的连接登记；代数不匹配（已重连换新）则不动
    pub fn remove_device_if(&mut self, device_id: &str, gen: u64) {
        if self.devices.get(device_id).map_or(false, |c| c.gen == gen) {
            self.devices.remove(device_id);
        }
    }
}

pub type SharedState = Arc<Mutex<RelayState>>;
