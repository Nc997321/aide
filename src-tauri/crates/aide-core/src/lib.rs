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

pub mod app_settings;
pub mod bus;
pub mod automation;
pub mod lsp;
pub mod codegraph;
pub mod commands;
pub mod host;
pub mod paths;
pub mod policy;
pub mod provider;
pub mod proxy;
pub mod pty;
pub mod registry;
pub mod resources;
pub mod runtime;
pub mod session_store;
pub mod settings;
pub mod skills;
pub mod workspace;

use std::sync::Arc;

use aide_workspace::watch::FileWatchService;
use serde_json::Value;

use resources::HostResources;
use settings::SettingsService;

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
    /// 分层设置（managed / user / project）+ 密钥端口。
    pub settings: Arc<SettingsService>,
    /// 文件树监听（同一时刻只盯一个根：一个窗口一棵树）。
    pub(crate) watch: FileWatchService,
    /// 终端 / 运行配置的 PTY 会话。
    pub pty: pty::ShellManager,
    /// 代码索引（runner 进程的代理：惰性拉起 / 空闲回收）。
    pub codegraph: Arc<codegraph::CodeGraphService>,
    /// 语言服务器（按 工作区 × 语言 各一台）。
    pub lsp: Arc<lsp::LspState>,
    /// agent runtime（sidecar 进程、会话路由与存活表、事件泵）。
    pub runtime: runtime::AgentRuntimeManager,
    /// 自动化任务调度（常驻 tick；运行与蒸馏写 `runtime`）。`start` 后才调度。
    pub automation: Arc<automation::AutomationService>,
    /// 随包资源在哪（前门回答）。
    pub resources: Arc<dyn HostResources>,
    /// Host 的事件总线：全部事件在这里编号、留底、按订阅投给前门 / 网关（见 `bus.rs`）。
    pub bus: Arc<bus::Bus>,
    events: Arc<dyn EventSink>,
}

impl Core {
    pub fn new(
        workspace: Arc<WorkspaceState>,
        settings: Arc<SettingsService>,
        events: Arc<dyn EventSink>,
        resources: Arc<dyn HostResources>,
    ) -> Arc<Self> {
        // 前门给的出口被总线包一层：事件先编号 / 留底，再交给前门
        let bus = Arc::new(bus::Bus::new(bus::new_epoch()));
        let events: Arc<dyn EventSink> = Arc::new(bus::Tee { bus: Arc::clone(&bus), inner: events });
        Arc::new(Self {
            codegraph: Arc::new(codegraph::CodeGraphService::new(
                resources.clone(),
                settings.clone(),
            )),
            lsp: Arc::new(lsp::LspState::new()),
            runtime: runtime::AgentRuntimeManager::new(),
            automation: Arc::new(automation::AutomationService::new()),
            resources,
            workspace,
            settings,
            watch: FileWatchService::default(),
            pty: pty::ShellManager::new(),
            bus,
            events,
        })
    }

    pub fn emit(&self, event: &str, payload: Value) {
        self.events.emit(event, payload);
    }

    /// 系统通知：Host 不弹窗（它可能跑在没有桌面的机器上），只发 `system-notification`
    /// 事件，由连着它的 GUI 前门弹出（桌面 = `TauriSink` 就地转系统通知）。
    pub fn notify(&self, title: &str, body: &str) {
        self.emit(
            "system-notification",
            serde_json::json!({ "title": title, "body": body }),
        );
    }

    /// 一个与本机真实数据隔离的 Host：设置落在 `root` 下、密钥只在内存（测试用）。
    pub fn isolated(root: std::path::PathBuf, events: Arc<dyn EventSink>) -> Arc<Self> {
        let settings = SettingsService::new(
            settings::SettingsPaths::for_test(root),
            Arc::new(settings::MemorySecretStore::default()),
        );
        let _ = settings.initialize_blocking();
        Self::new(
            Arc::new(WorkspaceState::new()),
            Arc::new(settings),
            events,
            Arc::new(resources::NoResources),
        )
    }

    /// 事件出口本身（给长寿的后台线程持有——持 `Arc<Core>` 会让 Core 与它的线程互相引用）。
    pub fn events(&self) -> Arc<dyn EventSink> {
        Arc::clone(&self.events)
    }
}

/// 测试用：每次一个独立目录的隔离 Host。
#[cfg(test)]
pub(crate) fn test_core(events: Arc<dyn EventSink>) -> Arc<Core> {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "aide-core-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    Core::isolated(dir, events)
}
