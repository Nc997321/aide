//! `lsp_query` 的**执行体**：把 sidecar 的查询翻成 LspManager 调用，结果经 stdin 回写。
//!
//! **为什么单独一个文件**：`runtime/mod.rs` 有 1000 行拆分线，内联这段会撞线。
//!
//! **失败纪律**：不 panic、不静默。任何失败都折成 `{ok:false, status, error}` 回给
//! sidecar，由工具层转成模型可读文本（「失败返回文本不抛错」）。
//!
//! 查询本体就地执行——`LspManager` 就在主进程。

use std::sync::Arc;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::lsp::agent_bridge::{build_result_command, LspQueryRequest};
use crate::Core;

/// 执行一条 agent LSP 查询并回写结果。
pub async fn handle(
    core: Arc<Core>,
    stdin: Arc<TokioMutex<ChildStdin>>,
    req: LspQueryRequest,
) {
    // 可观测性：桥被拦截后既不转发前端也不回任何 UI，没有这行就只剩「成功或 15s
    // 超时」两种可见状态，出错时无从定位（同 browser_agent 的既有教训）。
    let tool = req.tool.clone();
    let request_id = req.request_id.clone();
    let body: Value =
        crate::lsp::agent_query::run_agent_query(&core, &req.tool, &req.args, &req.workspace_root).await;

    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        tracing::info!(tool, %request_id, "lsp bridge: replied ok");
    } else {
        let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
        tracing::warn!(tool, %request_id, error, "lsp bridge: replied with error");
    }

    let payload = build_result_command(&req.request_id, body);
    if let Ok(mut line) = serde_json::to_string(&payload) {
        line.push('\n');
        let mut guard = stdin.lock().await;
        let _ = guard.write_all(line.as_bytes()).await;
    }
}

