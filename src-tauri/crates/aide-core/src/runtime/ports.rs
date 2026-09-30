//! agent runtime 的宿主端口。
//!
//! - [`AgentHooks`]：**GUI 侧能力**——内嵌浏览器的 agent 工具查询、桌面冻结诊断黑匣子。Host
//!   本身没有这些，由挂着 GUI 的前门（桌面）注入；不注入（aide-host）= 浏览器查询当作普通
//!   事件转发给 GUI、观测为空。
//! - [`LaneRouter`] / [`LaneAdapter`]：**过渡端口（P1 前）**——旧模型「远程工作区」的会话跑在
//!   目标机 sidecar 上（车道），命令按会话绑定路由、事件路径译回桌面形态。实现在桌面
//!   `remote_workspace/lanes.rs`；P1（窗口连 Host）后 Host 只有本机车道，连同实现一起删除。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::lsp::agent_bridge::LspQueryRequest;
use crate::Core;

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

/// 旧模型远程车道的路由（桌面实现）。
pub trait LaneRouter: Send + Sync + 'static {
    /// 会话绑在某条远程车道上 → 那条车道的 stdin（车道已断 = Err，文案给用户看）；
    /// None = 本机车道。
    fn stdin_for(&self, session_id: &str) -> Option<Result<AgentStdin, String>>;

    /// send 发出前：`cwd` 是远程工作区 → 确保车道（首次安装远程套件）、绑定会话、把命令里的
    /// 路径译成目标机形态、附上扩展镜像。本机工作区原样返回。
    fn prepare_send<'a>(
        &'a self,
        core: &'a Arc<Core>,
        session_id: &'a str,
        cwd: &'a str,
        cmd: &'a mut Value,
    ) -> BoxFuture<'a, Result<(), String>>;

    /// 杀掉全部远程车道（app 退出）。
    fn kill_all(&self) -> BoxFuture<'_, ()>;
}

/// 一条远程车道在事件泵里的分叉点（本机车道没有这些）。
pub trait LaneAdapter: Send + Sync + 'static {
    /// 日志标签（stderr 前缀）。
    fn tag(&self) -> String;

    /// 该车道就地应答的桥查询（远程不支持的，如 codegraph）：已应答返回 true。
    fn answer_locally<'a>(&'a self, event: &'a Value, stdin: &'a AgentStdin) -> BoxFuture<'a, bool>;

    /// LSP 桥查询进来：目标机路径 → 桌面形态（LspManager 按桌面形态管理工作区）。
    fn lsp_request_in(&self, req: &mut LspQueryRequest);

    /// LSP 桥结果出去：桌面形态 → 目标机路径。
    fn lsp_result_out(&self, body: &mut Value);

    /// 事件结构化字段里的目标机路径 → 桌面形态。
    fn map_event_paths(&self, event: &mut Value);

    /// 车道进程死亡：只波及绑在它上面的会话。
    fn on_dead(&self, core: &Core, stderr_tail: Vec<String>, reason: &str);
}
