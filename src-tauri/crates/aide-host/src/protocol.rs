//! 桌面 ↔ aide-host 的 stdio 协议（**唯一真相源**：桌面 `src-tauri/src/remote_host/`
//! 与 aide-host 都从这里取类型，改帧 = 改这一个文件，两端编译期对齐）。
//!
//! 传输：一行一帧的 JSON（`\n` 分隔），承载于 `wsl.exe -d <distro> -- …` 或
//! `ssh <host> …` 的 stdin/stdout。stderr 只是日志，不承载协议。
//!
//! - 请求（桌面 → host）：`{"id":1,"method":"invoke","params":{…}}`
//! - 响应（host → 桌面）：`{"id":1,"ok":<value>}` 或 `{"id":1,"err":"…"}`
//! - 通知（host → 桌面）：`{"event":"file-tree-changed","payload":[…]}`
//!
//! 路径：本协议里的路径**一律是目标机原生路径**（POSIX）。桌面侧的远程路径形态
//! （`\\wsl.localhost\<distro>\…` / `\\aide-ssh\<alias>\…`）只存在于桌面，翻译在
//! 桌面做——host 不认识桌面的路径形态。
//!
//! 语言服务器同理：`aide-host lsp` 首行读 [`LspInit`]，之后 stdin/stdout 是 LSP 原生帧
//! （Content-Length 分帧），逐字节透传；URI 的桌面 ↔ 目标机翻译在桌面做。
//!
//! agent 通道**不走本协议**：`aide-host agent` 是独立进程（独立一条 wsl/ssh 管道），
//! 首行读 [`AgentInit`]，之后 stdin/stdout 就是 sidecar 原生协议，逐字节透传。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// 不兼容变更时递增。桌面在 `hello` 里比对，不等 = 视为需要重装 host。
pub const PROTOCOL_VERSION: u32 = 1;

pub const METHOD_HELLO: &str = "hello";
pub const METHOD_INVOKE: &str = "invoke";
pub const METHOD_WATCH: &str = "watch";

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

/// `invoke`：按 Tauri 命令名分派到 aide-workspace 的同一份实现。
/// `args` 是前端 invoke 的原始参数（camelCase，路径已翻译成目标机路径）；
/// `root` 是需要工作区根的命令（git 系 / get_project_info）由桌面解析好的根。
#[derive(Debug, Serialize, Deserialize)]
pub struct InvokeParams {
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

/// `watch`：文件树监听重定向（`None` = 停表）。事件以 `file-tree-changed` 通知回推。
#[derive(Debug, Serialize, Deserialize)]
pub struct WatchParams {
    #[serde(default)]
    pub root: Option<String>,
}

/// `aide-host agent` 的首行：sidecar 的进程环境（provider 凭据等敏感值走这里而不是
/// 命令行——命令行在目标机 `ps` 里对所有用户可见）。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AgentInit {
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 兜底 env：只在目标机登录环境**没有**该键时生效（如桌面探测到的代理——目标机自己
    /// 配了代理就用它自己的）。
    #[serde(default)]
    pub default_env: HashMap<String, String>,
    /// node 可执行文件；None = 用 PATH 上的 `node`。
    #[serde(default)]
    pub node: Option<String>,
    /// sidecar 入口 runtime.js；None = host 安装目录下的 `runtime/runtime.js`。
    #[serde(default)]
    pub runtime: Option<String>,
}

/// `aide-host lsp` 的首行：在目标机上起哪个语言服务器。
///
/// 服务器**在目标机上解析**（登录环境的 PATH）：桌面看不到目标机装了什么，SSH 工作区更是
/// 连文件都摸不到。桌面只给候选（与本机 PATH 发现同一份二进制名，见桌面 `LanguageId::server_binary`）。
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LspInit {
    /// 候选命令（argv），按序取第一个 `argv[0]` 在目标机登录 PATH 上找得到的。
    pub candidates: Vec<Vec<String>>,
    /// 工作目录（目标机路径，通常是工作区根）。
    pub cwd: String,
}

/// `invoke` 里的 LSP 探测命令（**不是** Tauri 命令名——桌面 LSP 层按工作区是否远程选择
/// 本机实现或向 host 要，见桌面 `lsp::workspace_access`）。
pub const LSP_COMMANDS: &[&str] = &["lsp_detect", "lsp_representatives"];
