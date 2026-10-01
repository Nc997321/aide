//! 守护进程里**一条客户端连接**的请求循环：一行一帧的 JSON（协议见 `protocol.rs`），承载在
//! 任意字节流上（Unix 套接字；测试里是内存管道）。
//!
//! 连接先要 `attach` 才能 `invoke` / `subscribe`——attach 把它登记进 Host 的事件总线（`Core::bus`），
//! 之后 Host 的所有事件按它的订阅投递；`hello` 与 `shutdown` 不需要先 attach（桥在接入前
//! 用它们探守护进程的版本、必要时让旧版本退场）。
//!
//! 并发模型：每条请求独立 spawn（慢的全树搜索不堵住文件树的 list_directory）；所有出站帧
//! （应答 + 事件）经同一个 mpsc 串行写出，保证一行一帧不交错。

use std::sync::Arc;

use aide_core::bus::{Attach, ClientId, Consumer, Event, Resume as BusResume};
use aide_core::Core;
use aide_host::protocol::{
    AttachInfo, HelloInfo, InvokeParams, Request, Response, ServeInit, ShutdownParams,
    SubscribeParams, METHOD_ATTACH, METHOD_HELLO, METHOD_INVOKE, METHOD_SHUTDOWN, METHOD_SUBSCRIBE,
    PROTOCOL_VERSION,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::Notify;

use crate::dispatch;
use crate::kit::HostKit;

/// 一条出站帧（已序列化、不含换行）。
pub type Frame = Arc<str>;

/// 守护进程的共享状态：一份 Core（事件总线在 `core.bus`）、一份随包资源。
pub struct Daemon {
    pub core: Arc<Core>,
    pub kit: Arc<HostKit>,
    /// 有人要求退出（`shutdown`）时被唤醒；daemon 主循环等它。
    pub shutdown: Notify,
}

/// 桥这条连接的事件消费者：把总线事件序列化成通知帧（带 `seq`），经本连接的写端送出。
struct BridgeConsumer(UnboundedSender<Frame>);

impl Consumer for BridgeConsumer {
    fn deliver(&self, ev: &Arc<Event>) -> bool {
        #[derive(serde::Serialize)]
        struct Notify<'a> {
            event: &'a str,
            payload: &'a Value,
            seq: u64,
        }
        match serde_json::to_string(&Notify { event: &ev.name, payload: &ev.payload, seq: ev.seq }) {
            Ok(line) => self.0.send(line.into()).is_ok(),
            Err(e) => {
                eprintln!("[aide-host] event {} not serialisable: {e}", ev.name);
                true
            }
        }
    }
}

fn frame(resp: &Response) -> Option<Frame> {
    serde_json::to_string(resp).ok().map(Frame::from)
}

fn reply(tx: &UnboundedSender<Frame>, id: u64, r: Result<Value, String>) {
    let resp = match r {
        Ok(v) => Response { id, ok: Some(v), err: None },
        Err(e) => Response { id, ok: None, err: Some(e) },
    };
    if let Some(f) = frame(&resp) {
        let _ = tx.send(f);
    }
}

fn parse<T: serde::de::DeserializeOwned>(params: Value, what: &str) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("invalid {what}: {e}"))
}

pub async fn serve_client<R, W>(d: Arc<Daemon>, reader: R, mut writer: W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = unbounded_channel::<Frame>();
    // 写端：所有 sender（本循环、事件中心里的登记、在途请求）都放掉后自然结束
    tokio::spawn(async move {
        while let Some(f) = rx.recv().await {
            if writer.write_all(f.as_bytes()).await.is_err()
                || writer.write_all(b"\n").await.is_err()
                || writer.flush().await.is_err()
            {
                break; // 对端已走
            }
        }
    });

    let mut lines = BufReader::new(reader).lines();
    let mut attached: Option<(ClientId, AttachInfo)> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[aide-host] bad frame: {e}");
                continue;
            }
        };
        match req.method.as_str() {
            METHOD_HELLO => reply(&tx, req.id, serde_json::to_value(hello(&d, attached.as_ref())).map_err(|e| e.to_string())),
            METHOD_ATTACH => {
                if attached.is_some() {
                    reply(&tx, req.id, Err("already attached".into()));
                    continue;
                }
                let init: ServeInit = match parse(req.params, "attach") {
                    Ok(i) => i,
                    Err(e) => {
                        reply(&tx, req.id, Err(e));
                        continue;
                    }
                };
                d.kit.update(ServeInit { resume: None, subscribe: None, ..init.clone() });
                let id = req.id;
                let req = Attach {
                    resume: init.resume.as_ref().map(|r| BusResume { epoch: r.daemon_id.clone(), seq: r.seq }),
                    sessions: init.subscribe.clone(),
                    allow: None,
                };
                let ack_tx = tx.clone();
                let (cid, bus_info) = d.core.bus.attach(Arc::new(BridgeConsumer(tx.clone())), req, |info| {
                    let ok = serde_json::to_value(wire_info(info)).unwrap_or(Value::Null);
                    let line = serde_json::to_string(&Response { id, ok: Some(ok), err: None }).unwrap_or_default();
                    let _ = ack_tx.send(line.into());
                });
                attached = Some((cid, wire_info(&bus_info)));
            }
            METHOD_SUBSCRIBE => {
                let r = match (&attached, parse::<SubscribeParams>(req.params, "subscribe")) {
                    (Some((cid, _)), Ok(p)) => {
                        d.core.bus.subscribe(*cid, p.sessions);
                        Ok(Value::Null)
                    }
                    (None, _) => Err("not attached".into()),
                    (_, Err(e)) => Err(e),
                };
                reply(&tx, req.id, r);
            }
            METHOD_SHUTDOWN => {
                let force = parse::<ShutdownParams>(req.params, "shutdown").map(|p| p.force).unwrap_or(false);
                let others = d.core.bus.client_count() - usize::from(attached.is_some());
                if others > 0 && !force {
                    reply(&tx, req.id, Err(format!("还有 {others} 个客户端连着")));
                } else {
                    reply(&tx, req.id, Ok(Value::Null));
                    d.shutdown.notify_one();
                }
            }
            METHOD_INVOKE if attached.is_some() => {
                let tx = tx.clone();
                let core = Arc::clone(&d.core);
                tokio::spawn(async move {
                    let r = match parse::<InvokeParams>(req.params, "invoke") {
                        Ok(p) => dispatch::invoke(core, p).await,
                        Err(e) => Err(e),
                    };
                    reply(&tx, req.id, r);
                });
            }
            METHOD_INVOKE => reply(&tx, req.id, Err("not attached".into())),
            other => reply(&tx, req.id, Err(format!("aide-host: unknown method `{other}`"))),
        }
    }
    if let Some((id, _)) = attached {
        d.core.bus.detach(id);
    }
}

fn wire_info(i: &aide_core::bus::AttachInfo) -> AttachInfo {
    AttachInfo { daemon_id: i.epoch.clone(), resumed: i.resumed, gap: i.gap, seq: i.seq, replayed: i.replayed }
}

fn hello(d: &Daemon, attached: Option<&(ClientId, AttachInfo)>) -> HelloInfo {
    HelloInfo {
        protocol: PROTOCOL_VERSION,
        version: crate::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: std::env::var("HOME").unwrap_or_default(),
        user: std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_default(),
        daemon_id: d.core.bus.epoch().to_string(),
        clients: d.core.bus.client_count() as u32,
        attach: attached.map(|(_, info)| info.clone()),
    }
}
