//! `lsp_query` 的**执行体**：把 sidecar 的查询翻成 LspManager 调用，结果经 stdin 回写。
//!
//! **为什么单独一个文件**：`runtime/mod.rs` 有 1000 行拆分线，内联这段会撞线
//! （同 `runtime/browser_agent.rs` 的既有理由）。这里也是唯一能同时拿到
//! `AppHandle`（取 LspState）与 stdin 回写通道的地方。
//!
//! **失败纪律**：不 panic、不静默。任何失败都折成 `{ok:false, status, error}` 回给
//! sidecar，由工具层转成模型可读文本（照 codegraph 的「失败返回文本不抛错」）。
//!
//! **与 codegraph 的区别**：查询本体**不跳 runner**——`LspManager` 就在主进程，
//! 直接就地执行。

use std::sync::Arc;

use serde_json::Value;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

use crate::lsp::agent_bridge::{build_result_command, LspQueryRequest};

/// 执行一条 agent LSP 查询并回写结果。
///
/// `host` = 该车道所在的远程主机（None = 本机车道）。远程车道的 sidecar 跑在目标机上，
/// 它给的路径是目标机 POSIX 路径、它要读回的结果路径也必须是——语言服务器虽然也在目标机上，
/// 但 LspManager 在桌面、按桌面形态（`\\wsl.localhost\…`）管理工作区，所以进出各译一次。
pub async fn handle(
    app: AppHandle,
    stdin: Arc<TokioMutex<ChildStdin>>,
    mut req: LspQueryRequest,
    host: Option<crate::remote_workspace::path::HostId>,
) {
    if let Some(h) = &host {
        to_desktop_request(h, &mut req);
    }
    // 可观测性：桥被拦截后既不转发前端也不回任何 UI，没有这行就只剩「成功或 15s
    // 超时」两种可见状态，出错时无从定位（同 browser_agent 的既有教训）。
    let tool = req.tool.clone();
    let request_id = req.request_id.clone();
    let body = run(&app, &req).await;

    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        tracing::info!(tool, %request_id, "lsp bridge: replied ok");
    } else {
        let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
        tracing::warn!(tool, %request_id, error, "lsp bridge: replied with error");
    }

    let mut body = body;
    if host.is_some() {
        to_posix_result(&mut body);
    }
    let payload = build_result_command(&req.request_id, body);
    if let Ok(mut line) = serde_json::to_string(&payload) {
        line.push('\n');
        let mut guard = stdin.lock().await;
        let _ = guard.write_all(line.as_bytes()).await;
    }
}

/// 取 state → 执行。state 缺失（不该发生：lib.rs 无条件 manage）也要回一个
/// 可读的 no_server，而不是让 sidecar 干等超时。
async fn run(app: &AppHandle, req: &LspQueryRequest) -> Value {
    crate::lsp::agent_query::run_agent_query(app, &req.tool, &req.args, &req.workspace_root).await
}

/// 远程车道：请求里的目标机路径 → 桌面形态。
fn to_desktop_request(host: &crate::remote_workspace::path::HostId, req: &mut LspQueryRequest) {
    use crate::remote_workspace::path::to_desktop;
    req.workspace_root = to_desktop(host, &req.workspace_root);
    if let Some(f) = req.args.get("file").and_then(Value::as_str).map(str::to_string) {
        req.args["file"] = Value::String(to_desktop(host, &f));
    }
}

/// 远程车道：结果里的桌面形态绝对路径 → 目标机路径（`symbol.file` / 候选的 `file_path`）。
/// 文本兜底的 `matches[].file` 是相对路径，两端同形，不动。
fn to_posix_result(v: &mut Value) {
    let posix = |s: &str| crate::remote_workspace::path::parse(s).map(|(_, p)| p);
    if let Some(results) = v.get_mut("results").and_then(Value::as_array_mut) {
        for r in results {
            if let Some(f) = r.pointer("/symbol/file").and_then(Value::as_str).and_then(posix) {
                r["symbol"]["file"] = Value::String(f);
            }
        }
    }
    if let Some(cands) = v.get_mut("candidates").and_then(Value::as_array_mut) {
        for c in cands {
            if let Some(f) = c.get("file_path").and_then(Value::as_str).and_then(posix) {
                c["file_path"] = Value::String(f);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_workspace::path::HostId;
    use serde_json::json;

    #[test]
    fn remote_request_and_result_paths_round_trip() {
        let host = HostId::Wsl("Debian".into());
        let mut req = LspQueryRequest {
            request_id: "r".into(),
            tool: "references".into(),
            args: json!({"file": "/home/u/p/src/a.ts", "line": 3, "character": 5}),
            workspace_root: "/home/u/p".into(),
        };
        to_desktop_request(&host, &mut req);
        assert_eq!(req.workspace_root, "\\\\wsl.localhost\\Debian\\home\\u\\p");
        assert_eq!(req.args["file"], "\\\\wsl.localhost\\Debian\\home\\u\\p\\src\\a.ts");

        // LspManager 回的是 URI 解出来的正斜杠 UNC
        let mut body = json!({
            "ok": true, "status": "ready",
            "results": [{"symbol": {"file": "//wsl.localhost/Debian/home/u/p/src/b.ts", "line": 1}}],
            "candidates": [{"file_path": "//wsl.localhost/Debian/home/u/p/c.ts"}],
            "matches": [{"file": "src/d.ts"}],
        });
        to_posix_result(&mut body);
        assert_eq!(body["results"][0]["symbol"]["file"], "/home/u/p/src/b.ts");
        assert_eq!(body["candidates"][0]["file_path"], "/home/u/p/c.ts");
        assert_eq!(body["matches"][0]["file"], "src/d.ts");
    }
}
