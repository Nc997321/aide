//! Aide Host 核心：**一张命令表 + Host 自持状态**，所有前门共用。
//!
//! Host 模型（设计见 docs/host-model.md）：一个 Host = 一整个 Aide 后端；GUI 只是连到
//! 某个 Host 的屏幕。同一份 [`Core`] 与 [`registry`] 跑在两处：
//!
//! - 本机 Host：桌面进程内直调（Tauri 的通用分派器查表，零额外跳数——本机零退化）
//! - 远程 Host：`aide-host serve` 在 WSL / SSH 目标机上查同一张表
//!
//! 因此本 crate **禁止依赖 Tauri**：它需要的宿主能力（发事件、资源路径…）一律经
//! [`Core`] 的字段由前门注入。新命令 = [`registry`] 表里加一行，两处前门同时获得。

pub mod commands;
pub mod registry;
pub mod workspace;

use std::sync::Arc;

use aide_workspace::watch::FileWatchService;
use serde_json::Value;

pub use registry::{lookup, Reply};
pub use workspace::WorkspaceState;

/// 事件出口：Host 内部状态变化广播给连着它的 GUI（本机 = Tauri emit；远程 = 协议通知帧）。
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: Value);
}

/// 不接任何 GUI 的出口（测试 / 纯命令行场景）。
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: &str, _payload: Value) {}
}

/// 一个 Host 的全部自持状态。命令处理器拿到的是 `Arc<Core>`，不认识任何前门。
pub struct Core {
    /// 活动工作区（全局单例语义沿用桌面现状；按会话的归属走命令参数 `cwd`）。
    pub workspace: Arc<WorkspaceState>,
    /// 文件树监听（同一时刻只盯一个根：一个窗口一棵树）。
    pub(crate) watch: FileWatchService,
    events: Arc<dyn EventSink>,
}

impl Core {
    pub fn new(workspace: Arc<WorkspaceState>, events: Arc<dyn EventSink>) -> Arc<Self> {
        Arc::new(Self {
            workspace,
            watch: FileWatchService::default(),
            events,
        })
    }

    pub fn emit(&self, event: &str, payload: Value) {
        self.events.emit(event, payload);
    }

    /// 事件出口本身（给长寿的后台线程持有——持 `Arc<Core>` 会让 Core 与它的线程互相引用）。
    pub fn events(&self) -> Arc<dyn EventSink> {
        Arc::clone(&self.events)
    }
}
