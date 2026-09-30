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
pub const PROTOCOL_VERSION: u32 = 4;

pub const METHOD_HELLO: &str = "hello";
pub const METHOD_INVOKE: &str = "invoke";

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
}

/// `hello` 的结果：目标机画像。桌面用 `home` 推导默认目录，用 `version` 判定是否需要重装。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloInfo {
    pub protocol: u32,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub home: String,
    pub user: String,
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
#[derive(Debug, Default, Serialize, Deserialize)]
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
}
