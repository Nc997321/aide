//! `aide-host serve`：stdio JSON-RPC 主循环。
//!
//! 并发模型：每条请求独立 spawn（慢的全树搜索不堵住文件树的 list_directory）；
//! 所有出站帧（响应 + 通知）经同一个 mpsc 串行写 stdout，保证一行一帧不交错。
//! stdin EOF = 桌面断开（wsl/ssh 管道关闭）→ 进程退出，监听线程随之消亡。

use std::path::Path;
use std::sync::Arc;

use aide_host::protocol::{
    HelloInfo, InvokeParams, Notification, Request, Response, WatchParams, METHOD_HELLO,
    METHOD_INVOKE, METHOD_WATCH, PROTOCOL_VERSION,
};
use aide_workspace::watch::{FileWatchService, WatchSink, EVENT_NAME};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::dispatch;

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

    let watch = Arc::new(FileWatchService::default());
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
        let watch = Arc::clone(&watch);
        tokio::spawn(async move {
            let result = handle(req.method.as_str(), req.params, &tx, watch).await;
            let resp = match result {
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
    drop(tx);
    let _ = writer.await;
    0
}

async fn handle(
    method: &str,
    params: Value,
    tx: &UnboundedSender<String>,
    watch: Arc<FileWatchService>,
) -> Result<Value, String> {
    match method {
        METHOD_HELLO => serde_json::to_value(hello()).map_err(|e| e.to_string()),
        METHOD_INVOKE => {
            let p: InvokeParams =
                serde_json::from_value(params).map_err(|e| format!("invalid invoke: {e}"))?;
            dispatch::invoke(p).await
        }
        METHOD_WATCH => {
            let p: WatchParams =
                serde_json::from_value(params).map_err(|e| format!("invalid watch: {e}"))?;
            let sink = notify_sink(tx.clone());
            // inotify 全树 add_watch 是重 IO（node_modules 规模），离开 async 线程。
            tokio::task::spawn_blocking(move || {
                watch.retarget(p.root.as_deref().map(Path::new), &sink)
            })
            .await
            .map_err(|e| format!("watch task panicked: {e}"))??;
            Ok(Value::Null)
        }
        other => Err(format!("aide-host: unknown method `{other}`")),
    }
}

fn notify_sink(tx: UnboundedSender<String>) -> WatchSink {
    Arc::new(move |dirs: Vec<String>| {
        let n = Notification {
            event: EVENT_NAME.to_string(),
            payload: Value::from(dirs),
        };
        let s = serde_json::to_string(&n).map_err(|e| e.to_string())?;
        tx.send(s).map_err(|_| "desktop disconnected".to_string())
    })
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
