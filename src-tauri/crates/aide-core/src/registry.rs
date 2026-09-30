//! 命令表：命令名 → 处理器。**这张表就是 Host 的全部能力面**（可审计：读
//! [`TABLES`] 即知 Host 会做什么），本机与远程前门查的是同一张表。
//!
//! 命令名 = 前端 `invoke` 的命令名，参数 = 前端 invoke 的原样 JSON（camelCase）。
//! 处理器一律 async；阻塞 IO / CPU 必须经 [`blocking`] 离开异步线程（同桌面「同步
//! command 禁止重 IO」口径——这里没有同步命令，也就没有 trace 埋点问题）。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::Core;

/// 命令结果：绝大多数是 JSON；原始字节（图片预览）单列，前门各自按原生方式送出
/// （Tauri = `InvokeResponseBody::Raw`；aide-host = base64 包装帧）。
pub enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

pub type BoxFuture = Pin<Box<dyn Future<Output = Result<Reply, String>> + Send>>;
pub type Handler = fn(Arc<Core>, Value) -> BoxFuture;

pub struct Command {
    pub name: &'static str,
    pub run: Handler,
}

/// 各能力模块的分表。新模块迁入 = 这里加一项。
static TABLES: &[&[Command]] = &[
    crate::app_settings::COMMANDS,
    crate::commands::customizations::agents::COMMANDS,
    crate::commands::customizations::hooks::COMMANDS,
    crate::commands::customizations::instructions::COMMANDS,
    crate::commands::customizations::mcp::COMMANDS,
    crate::commands::customizations::skills::COMMANDS,
    crate::commands::fs::COMMANDS,
    crate::commands::git::COMMANDS,
    crate::commands::jdk::COMMANDS,
    crate::commands::knowledge::COMMANDS,
    crate::commands::memory_observatory::COMMANDS,
    crate::commands::migration::COMMANDS,
    crate::commands::notifications::COMMANDS,
    crate::commands::onboarding::COMMANDS,
    crate::commands::provider::COMMANDS,
    crate::commands::recent::COMMANDS,
    crate::commands::run_configs::COMMANDS,
    crate::commands::session_changes::COMMANDS,
    crate::commands::workspace::COMMANDS,
    crate::proxy::COMMANDS,
    crate::commands::watch::COMMANDS,
];

pub fn lookup(name: &str) -> Option<Handler> {
    TABLES
        .iter()
        .flat_map(|t| t.iter())
        .find(|c| c.name == name)
        .map(|c| c.run)
}

pub fn names() -> impl Iterator<Item = &'static str> {
    TABLES.iter().flat_map(|t| t.iter()).map(|c| c.name)
}

/// 参数解析：前端省略全部参数时可能是 null，按空对象解析（Option 字段取 None）。
pub fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|e| format!("invalid args: {e}"))
}

pub fn to_json<T: Serialize>(r: Result<T, String>) -> Result<Reply, String> {
    r.and_then(|v| serde_json::to_value(v).map(Reply::Json).map_err(|e| e.to_string()))
}

/// 阻塞实现搬到 blocking 线程池。
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("task panicked: {e}"))?
}

/// 登记一条命令：`command!("name", handler)`，handler 形如
/// `async fn(Arc<Core>, Args) -> Result<T, String>`（Args: Deserialize，T: Serialize）；
/// `command!(bytes "name", handler)` 的 handler 返回 `Result<Vec<u8>, String>`。
#[macro_export]
macro_rules! command {
    ($name:literal, $f:path) => {
        $crate::registry::Command {
            name: $name,
            run: |core, args| {
                Box::pin(async move {
                    let a = $crate::registry::parse_args(args)?;
                    $crate::registry::to_json($f(core, a).await)
                })
            },
        }
    };
    (bytes $name:literal, $f:path) => {
        $crate::registry::Command {
            name: $name,
            run: |core, args| {
                Box::pin(async move {
                    let a = $crate::registry::parse_args(args)?;
                    $f(core, a).await.map($crate::registry::Reply::Bytes)
                })
            },
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn command_names_are_unique() {
        let mut seen = HashSet::new();
        for n in names() {
            assert!(seen.insert(n), "duplicate command `{n}`");
        }
    }

    #[test]
    fn unknown_command_is_absent() {
        assert!(lookup("pty_spawn_shell_nope").is_none());
    }
}
