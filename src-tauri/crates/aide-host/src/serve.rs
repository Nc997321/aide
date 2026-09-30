//! `aide-host serve`：stdio JSON-RPC 主循环。
//!
//! 并发模型：每条请求独立 spawn（慢的全树搜索不堵住文件树的 list_directory）；
//! 所有出站帧（响应 + 通知）经同一个 mpsc 串行写 stdout，保证一行一帧不交错；
//! 通知 = Host 核心（aide-core）经 `EventSink` 发出的事件。
//! stdin EOF = 桌面断开（wsl/ssh 管道关闭）→ 进程退出，监听线程随之消亡。

use std::sync::Arc;

use aide_core::{Core, EventSink, WorkspaceState};
use aide_host::protocol::{
    HelloInfo, InvokeParams, Notification, Request, Response, METHOD_HELLO, METHOD_INVOKE,
    PROTOCOL_VERSION,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::dispatch;

/// Host 核心的事件出口 = stdout 通知帧（与响应帧同一条串行写出通道）。
struct NotifySink(UnboundedSender<String>);

impl EventSink for NotifySink {
    fn emit(&self, event: &str, payload: Value) {
        let n = Notification {
            event: event.to_string(),
            payload,
        };
        match serde_json::to_string(&n) {
            // 发送失败 = 桌面已断开，进程即将随 stdin EOF 退出，无处可报
            Ok(s) => {
                let _ = self.0.send(s);
            }
            Err(e) => eprintln!("[aide-host] event {event} not serialisable: {e}"),
        }
    }
}

pub async fn run() -> i32 {
    let (tx, mut rx) = unbounded_channel::<String>();

    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if out.write_all(line.as_bytes()).await.is_err() || out.flush().await.is_err() {
                break; // 桌面已断开
            }
        }
    });

    let core = Core::new(Arc::new(WorkspaceState::new()), Arc::new(NotifySink(tx.clone())));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
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
        let tx = tx.clone();
        let core = Arc::clone(&core);
        tokio::spawn(async move {
            let resp = match handle(req.method.as_str(), req.params, core).await {
                Ok(v) => Response {
                    id: req.id,
                    ok: Some(v),
                    err: None,
                },
                Err(e) => Response {
                    id: req.id,
                    ok: None,
                    err: Some(e),
                },
            };
            if let Ok(s) = serde_json::to_string(&resp) {
                let _ = tx.send(s);
            }
        });
    }
    // 停掉监听线程（它经 NotifySink 持有 tx 的克隆，不停表 writer 永远等不到通道关闭）
    let _ = tokio::task::spawn_blocking(move || aide_core::commands::watch::retarget(&core, None)).await;
    drop(tx);
    let _ = writer.await;
    0
}

async fn handle(method: &str, params: Value, core: Arc<Core>) -> Result<Value, String> {
    match method {
        METHOD_HELLO => serde_json::to_value(hello()).map_err(|e| e.to_string()),
        METHOD_INVOKE => {
            let p: InvokeParams =
                serde_json::from_value(params).map_err(|e| format!("invalid invoke: {e}"))?;
            dispatch::invoke(core, p).await
        }
        other => Err(format!("aide-host: unknown method `{other}`")),
    }
}

fn hello() -> HelloInfo {
    HelloInfo {
        protocol: PROTOCOL_VERSION,
        version: crate::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: std::env::var("HOME").unwrap_or_default(),
        user: std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_default(),
    }
}
