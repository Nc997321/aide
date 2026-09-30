//! agent runtime 的宿主端口。
//!
//! - [`AgentHooks`]：**GUI 侧能力**——内嵌浏览器的 agent 工具查询、桌面冻结诊断黑匣子。Host
//!   本身没有这些，由挂着 GUI 的前门（桌面）注入；不注入（aide-host）= 浏览器查询当作普通
//!   事件转发给 GUI、观测为空。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;


pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// sidecar 的命令写入端（命令与桥查询的回写共用）。
pub type AgentStdin = Arc<TokioMutex<ChildStdin>>;

pub trait AgentHooks: Send + Sync + 'static {
    /// 宿主认领的工具查询（内嵌浏览器）：认领则自行应答（写回 `stdin`）并返回 true——
    /// 事件不再转发 GUI。
    fn intercept(&self, event: &Value, stdin: &AgentStdin) -> bool;

    /// 每条转发给 GUI 的事件的旁路观察（诊断计量）。`raw_len` = sidecar 原始
    /// 行长（诊断按字节计量）。
    fn observe(&self, event: &Value, raw_len: usize);

    /// 本机 Runtime 进程整体死亡（诊断留痕）。
    fn runtime_dead(&self, reason: &str);
}
