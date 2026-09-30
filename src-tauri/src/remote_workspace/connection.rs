//! 与一台目标机上 `aide-host serve` 的长连接：请求-响应 + 通知回推。
//!
//! 生命周期：连接由 [`super::RemoteWorkspaces`] 按主机懒建、复用；子进程退出（WSL
//! 关机 / 网络断）→ 所有挂起请求立即以「连接已断开」失败，`alive` 置 false，下一次
//! 调用由注册表重连。**不做静默重试**——远程操作失败必须让用户看见。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use aide_host::protocol::{
    HelloInfo, InvokeParams, Notification, Request, Response, METHOD_HELLO, METHOD_INVOKE,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex as TokioMutex};

use super::path::HostId;

/// 单次调用的上限。最慢的合法操作是网络 git（fetch/pull/push，host 侧自带 120s
/// 超时），这里再留余量；超过即视为连接卡死。
const CALL_TIMEOUT: Duration = Duration::from_secs(180);

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>;
pub type EventHandler = Arc<dyn Fn(&HostId, Notification) + Send + Sync>;

pub struct HostConnection {
    pub host: HostId,
    pub info: HelloInfo,
    stdin: TokioMutex<ChildStdin>,
    pending: Arc<Pending>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    // 保活：drop 连接 = kill 子进程（kill_on_drop）
    _child: TokioMutex<Child>,
}

impl HostConnection {
    /// spawn 已构造好的 `aide-host serve` 命令并完成 `hello` 握手。
    pub async fn start(
        host: HostId,
        mut cmd: tokio::process::Command,
        on_event: EventHandler,
    ) -> Result<Arc<Self>, String> {
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法连接 {}：{e}", host.label()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let pending: Arc<Pending> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        {
            let tail = Arc::clone(&stderr_tail);
            let label = host.label();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(host = %label, "[aide-host stderr] {line}");
                    let mut t = tail.lock().unwrap_or_else(PoisonError::into_inner);
                    if t.len() >= 8 {
                        t.remove(0);
                    }
                    t.push(line);
                }
            });
        }
        {
            let pending = Arc::clone(&pending);
            let alive = Arc::clone(&alive);
            let host = host.clone();
            let tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    dispatch_line(&host, &line, &pending, &on_event);
                }
                alive.store(false, Ordering::Relaxed);
                let detail = tail.lock().unwrap_or_else(PoisonError::into_inner).join("\n");
                let msg = if detail.is_empty() {
                    format!("与 {} 的连接已断开", host.label())
                } else {
                    format!("与 {} 的连接已断开：{detail}", host.label())
                };
                tracing::warn!(host = %host, "{msg}");
                for (_, tx) in pending.lock().unwrap_or_else(PoisonError::into_inner).drain() {
                    let _ = tx.send(Err(msg.clone()));
                }
            });
        }

        let mut conn = HostConnection {
            host,
            info: HelloInfo {
                protocol: 0,
                version: String::new(),
                os: String::new(),
                arch: String::new(),
                home: String::new(),
                user: String::new(),
            },
            stdin: TokioMutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            alive,
            _child: TokioMutex::new(child),
        };
        let hello = tokio::time::timeout(Duration::from_secs(30), conn.call(METHOD_HELLO, Value::Null))
            .await
            .map_err(|_| format!("{} 握手超时", conn.host.label()))??;
        conn.info = serde_json::from_value(hello).map_err(|e| format!("hello 解析失败：{e}"))?;
        Ok(Arc::new(conn))
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        if !self.is_alive() {
            return Err(format!("与 {} 的连接已断开", self.host.label()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        // 先挂 pending 再写（响应可能极快到达）；写失败要摘掉，防 sender 泄漏
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, tx);
        let req = Request {
            id,
            method: method.to_string(),
            params,
        };
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');
        let write = async {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        };
        if let Err(e) = write.await {
            self.pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&id);
            return Err(format!("写入 {} 失败：{e}", self.host.label()));
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(format!("与 {} 的连接已断开", self.host.label())),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id);
                Err(format!("{} 上的 `{method}` 超时", self.host.label()))
            }
        }
    }

    pub async fn invoke(&self, cmd: &str, args: Value, root: Option<String>) -> Result<Value, String> {
        let params = serde_json::to_value(InvokeParams {
            cmd: cmd.to_string(),
            args,
            root,
        })
        .map_err(|e| e.to_string())?;
        self.call(METHOD_INVOKE, params).await
    }
}

fn dispatch_line(host: &HostId, line: &str, pending: &Pending, on_event: &EventHandler) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        // 非协议行（理论上不会有：serve 模式不经登录 shell）只留痕
        tracing::debug!(host = %host, "[aide-host] non-json stdout: {line}");
        return;
    };
    if v.get("event").is_some() {
        if let Ok(n) = serde_json::from_value::<Notification>(v) {
            on_event(host, n);
        }
        return;
    }
    let Ok(resp) = serde_json::from_value::<Response>(v) else {
        return;
    };
    let tx = pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&resp.id);
    if let Some(tx) = tx {
        let r = match (resp.ok, resp.err) {
            (_, Some(e)) => Err(e),
            (ok, None) => Ok(ok.unwrap_or(Value::Null)),
        };
        let _ = tx.send(r);
    }
}
