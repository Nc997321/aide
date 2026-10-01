//! 桌面 ↔ aide-host 的 stdio 协议（**唯一真相源**：桌面 `src-tauri/src/remote_workspace/`
//! 与 aide-host 都从这里取类型，改帧 = 改这一个文件，两端编译期对齐）。
//!
//! 传输：一行一帧的 JSON（`\n` 分隔），承载于 `wsl.exe -d <distro> -- …` 或
//! `ssh <host> …` 的 stdin/stdout。stderr 只是日志，不承载协议。
//!
//! - 请求（桌面 → host）：`{"id":1,"method":"invoke","params":{…}}`
//! - 响应（host → 桌面）：`{"id":1,"ok":<value>}` 或 `{"id":1,"err":"…"}`
//! - 通知（host → 桌面）：`{"event":"file-tree-changed","payload":[…]}`——Host 核心
//!   （aide-core `EventSink`）发出的**任何**事件都以这一帧送达，事件名 / payload 原样。
//!
//! 首行（连接建立后桌面先写）：[`ServeInit`]。
//!
//! 路径：本协议里的路径**一律是 Host 原生路径**（WSL / SSH 上即 POSIX），前端直接用，不翻译
//! （一个窗口 = 一个 Host，见 docs/host-model.md）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// 不兼容变更时递增。桌面在 `hello` 里比对，不等 = 拒绝连接（套件按内容哈希安装，
/// 正常路径下两端必然同版本；不等说明装错了东西，要大声失败而不是半通不通）。
///
/// v2（2026-09-30）：删除 `watch` 方法——文件监听改为 aide-core 命令 `file_tree_watch`
/// （经 `invoke`），事件经通知帧回推。
/// v3（2026-09-30）：`serve` 首行 [`ServeInit`]——serve 成为完整 Host（agent runtime /
/// 自动化 / LSP 都在它里面），进程级环境随连接给。
/// v4（2026-09-30）：删除旧模型——`invoke` 去掉 `root`（前端自带 `cwd`），删除 `agent` /
/// `lsp` 两个独立通道与 `transcript_*` / `lsp_detect` 等桌面取原料的命令。
/// v5（2026-09-30）：Host 常驻（`aide-host daemon`），`serve` 退为连到它的桥——通知帧带全局
/// 序号 `seq`，[`ServeInit::resume`] 凭它断线重连后回放；新增 `attach` / `subscribe` /
/// `shutdown`；`hello` 带守护进程身份与当前连接的 [`AttachInfo`]。
pub const PROTOCOL_VERSION: u32 = 5;

pub const METHOD_HELLO: &str = "hello";
pub const METHOD_INVOKE: &str = "invoke";
/// 守护进程套接字上的第一个动作：登记为客户端（桥替桌面发，桌面不直接见到它）。
pub const METHOD_ATTACH: &str = "attach";
/// 改本连接的事件订阅：只收某些会话的 `chat-event`（其余事件照常全收）。
pub const METHOD_SUBSCRIBE: &str = "subscribe";
/// 让守护进程退出（桥在版本不符且守护进程空闲时用；将来「重启 Host」也走它）。
pub const METHOD_SHUTDOWN: &str = "shutdown";

/// 二进制结果的包装键：`{"$bytes":"<base64>"}`（如 `read_file_binary`）。桌面据此
/// 还原成 `tauri::ipc::Response` 原始字节。
pub const BYTES_KEY: &str = "$bytes";

#[derive(Debug, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Notification {
    pub event: String,
    pub payload: Value,
    /// Host 全局事件序号（单调递增，守护进程发的帧都带）：客户端记下最后收到的，断线重连时
    /// 经 [`Resume`] 要回错过的部分。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

/// `hello` 的结果：目标机画像。桌面用 `home` 推导默认目录，用 `version` 判定是否需要重装。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HelloInfo {
    pub protocol: u32,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub home: String,
    pub user: String,
    /// 守护进程身份（每次启动随机）：它变了 = Host 进程换了，上面的会话都没了。
    #[serde(default)]
    pub daemon_id: String,
    /// 此刻连着守护进程的客户端数（含发起 `hello` 的这一个，若它已 attach）。
    #[serde(default)]
    pub clients: u32,
    /// 本连接的接入结果（attach 之后的 `hello` 才有）。
    #[serde(default)]
    pub attach: Option<AttachInfo>,
}

/// 断线重连的凭据：上次连的是哪个守护进程、收到哪一号事件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resume {
    pub daemon_id: String,
    pub seq: u64,
}

/// 一次 attach 的结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachInfo {
    pub daemon_id: String,
    /// 带了 [`Resume`] 且守护进程还是原来那个（会话都在）。
    pub resumed: bool,
    /// 想回放但环形缓冲已覆盖不到（错过的事件有丢失）：会话仍在，界面需要重新同步。
    pub gap: bool,
    /// 守护进程当前的最新事件序号。
    pub seq: u64,
    /// 本次回放了多少条。
    pub replayed: u64,
}

/// `subscribe` 的参数。`sessions = None` = 全收（默认）；`Some(列表)` = 只收这些会话的
/// `chat-event`（不带会话号的事件——文件变更 / LSP / 系统通知…——照常全收）。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SubscribeParams {
    #[serde(default)]
    pub sessions: Option<Vec<String>>,
}

/// `shutdown` 的参数：还有别的客户端连着时，只有 `force` 才退。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ShutdownParams {
    #[serde(default)]
    pub force: bool,
}

/// `invoke`：按前端 invoke 的命令名查 aide-core 命令表。`args` 是前端 invoke 的原始参数
/// （camelCase，Host 原生路径）。
#[derive(Debug, Serialize, Deserialize)]
pub struct InvokeParams {
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
}

/// `aide-host serve` 的首行：Host 进程级的设定（敏感值走 stdin 不走命令行——命令行在目标机
/// `ps` 里对所有用户可见）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServeInit {
    /// 给 agent sidecar 的 env（桌面上的工具开关等），覆盖 Host 自己的同名值。
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 兜底 env：只在 Host 登录环境**没有**该键时生效（如桌面探测到的代理）。
    #[serde(default)]
    pub default_env: HashMap<String, String>,
    /// node 可执行文件；None = 登录 PATH 上的 `node`。
    #[serde(default)]
    pub node: Option<String>,
    /// 原生 claude CLI（套件安装的那份）；None = 不设（SDK 自己找）。
    #[serde(default)]
    pub claude_exe: Option<String>,
    /// 断线重连：带上次的守护进程身份与最后收到的事件序号，守护进程认得就回放错过的。
    #[serde(default)]
    pub resume: Option<Resume>,
    /// attach 时的初始订阅：`None` = 全收（桌面）；`Some` = 只收这些会话的 `chat-event`
    /// （回放也按它过滤）。
    #[serde(default)]
    pub subscribe: Option<Vec<String>>,
}
