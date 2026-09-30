//! `lsp_query` 的**执行体**：把 sidecar 的查询翻成 LspManager 调用，结果经 stdin 回写。
//!
//! **为什么单独一个文件**：`runtime/mod.rs` 有 1000 行拆分线，内联这段会撞线。
//!
//! **失败纪律**：不 panic、不静默。任何失败都折成 `{ok:false, status, error}` 回给
//! sidecar，由工具层转成模型可读文本（照 codegraph 的「失败返回文本不抛错」）。
//!
//! **与 codegraph 的区别**：查询本体**不跳 runner**——`LspManager` 就在主进程，
//! 直接就地执行。

use std::sync::Arc;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use super::ports::LaneAdapter;
use crate::lsp::agent_bridge::{build_result_command, LspQueryRequest};
use crate::Core;

/// 执行一条 agent LSP 查询并回写结果。
///
/// `lane` = 旧模型远程车道（None = 本机车道）。远程车道的 sidecar 跑在目标机上，
/// 它给的路径是目标机 POSIX 路径、它要读回的结果路径也必须是——语言服务器虽然也在目标机上，
/// 但 LspManager 在桌面、按桌面形态（`\\wsl.localhost\…`）管理工作区，所以进出各译一次。
pub async fn handle(
    core: Arc<Core>,
    stdin: Arc<TokioMutex<ChildStdin>>,
    mut req: LspQueryRequest,
    lane: Option<Arc<dyn LaneAdapter>>,
) {
    if let Some(l) = &lane {
        l.lsp_request_in(&mut req);
    }
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

    let mut body = body;
    if let Some(l) = &lane {
        l.lsp_result_out(&mut body);
    }
    let payload = build_result_command(&req.request_id, body);
    if let Ok(mut line) = serde_json::to_string(&payload) {
        line.push('\n');
        let mut guard = stdin.lock().await;
        let _ = guard.write_all(line.as_bytes()).await;
    }
}

