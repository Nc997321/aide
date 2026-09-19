//! agent 查询服务层：把「工具名 + 参数」变成一次或几次 LSP 往返。
//!
//! 流程固定三步，顺序不可调换：
//!   1. **定性**（trusted / server 在不在）——不满足就早退，不白等探测
//!   2. **执行**——调 `jump::` 的公共零件；空结果时才回头探测就绪
//!   3. **判定**——`ready` 的空才是「可信的没有」，否则是「未验证」
//!
//! 任一步失败都返回**带状态的结果**，绝不返回裸空数组。

use crate::lsp::agent_readiness::{await_ready, ReadinessBudget};
use crate::lsp::agent_status::AgentLspStatus;
use crate::lsp::jump;
use crate::lsp::manager::{RequestOutcome, ServerHandle};
use crate::lsp::workspace_symbol::SymbolCandidate;
use crate::lsp::LspState;
use serde_json::{json, Value};
use std::sync::Arc;

/// 已解析出的查询位置（1-based，与命令行/前端一致）。
pub struct Position {
    pub file: String,
    pub line: usize,
    pub character: usize,
}

pub struct AgentQueryOutcome {
    pub ok: bool,
    pub status: AgentLspStatus,
    pub payload: Value,
}

/// 显式坐标（三个字段齐全）才算数；只给名字不算。
pub fn resolve_position(args: &Value) -> Option<Position> {
    let file = args.get("file")?.as_str()?.to_string();
    let line = args.get("line")?.as_u64()? as usize;
    let character = args.get("character")?.as_u64()? as usize;
    Some(Position {
        file,
        line,
        character,
    })
}

/// `LspManager::get` → `get`。server 的符号索引按**裸名**建，带限定路径直接查会返回空
/// ——而空会被误读成「没有」，所以这里必须剥。
pub fn symbol_query_name(name: &str) -> &str {
    name.rsplit("::").next().unwrap_or(name)
}

fn fail(status: AgentLspStatus, msg: &str) -> AgentQueryOutcome {
    AgentQueryOutcome {
        ok: false,
        status,
        payload: json!({ "ok": false, "status": status.as_str(), "error": msg }),
    }
}

/// agent 语义查询入口。
pub async fn run_agent_query(
    state: &LspState,
    tool: &str,
    args: &Value,
    workspace_root: &str,
) -> AgentQueryOutcome {
    if !crate::commands::workspace::is_path_trusted(workspace_root) {
        return fail(AgentLspStatus::Untrusted, "workspace not trusted");
    }
    let pos = match resolve_position(args) {
        Some(p) => p,
        None => {
            let Some(name) = args.get("name").and_then(|v| v.as_str()) else {
                return fail(AgentLspStatus::NoSymbol, "missing `name` or `{file,line,character}`");
            };
            match lookup_symbol(state, symbol_query_name(name), workspace_root).await {
                Ok(Some(c)) => Position {
                    file: c.file_path,
                    line: c.line,
                    character: c.column,
                },
                Ok(None) => {
                    return fail(
                        AgentLspStatus::NoSymbol,
                        &format!("no symbol named `{}`", symbol_query_name(name)),
                    )
                }
                Err(s) => return fail(s, "symbol lookup failed"),
            }
        }
    };
    run_jump(state, tool, &pos, workspace_root).await
}

/// 按名字解析坐标。`Err(Indexing)` 与非空的 `Ok(None)` 是**两件事**：
/// 前者是「还没索引好，什么都没查成」，后者是「索引是好的，真没这个符号」。
async fn lookup_symbol(
    state: &LspState,
    name: &str,
    workspace_root: &str,
) -> Result<Option<SymbolCandidate>, AgentLspStatus> {
    let langs = crate::lsp::detector::detect_languages(std::path::Path::new(workspace_root));
    if langs.is_empty() {
        return Err(AgentLspStatus::NoServer);
    }
    let mgr = state.0.lock().await;
    let mut answered = false;
    for lang_id in langs {
        let Some(h) = mgr.get(workspace_root, lang_id).await else {
            continue;
        };
        let params = json!({ "query": name });
        let outcome = match jump::issue(
            &h,
            "workspace/symbol",
            params,
            crate::lsp::manager::DEFINITION_TIMEOUT,
        )
        .await
        {
            Ok(o) => o,
            Err(_) => continue,
        };
        if let RequestOutcome::Ok(v) = outcome {
            answered = true;
            let hit = crate::lsp::workspace_symbol::parse_workspace_symbols(&v, lang_id.id_str())
                .into_iter()
                .next();
            if hit.is_some() {
                return Ok(hit);
            }
        }
    }
    if answered {
        Ok(None)
    } else {
        Err(AgentLspStatus::Indexing)
    }
}

/// 执行跳转类查询。先按当前状态直接发；**只有结果为空时才回头探测就绪**
/// ——非空结果本身就是「server 可用」的铁证，探测一次都不必花。
async fn run_jump(
    state: &LspState,
    tool: &str,
    pos: &Position,
    workspace_root: &str,
) -> AgentQueryOutcome {
    let Some(h) = server_for(state, workspace_root, &pos.file).await else {
        // 语言认不出、或 server 没能 ensure 起来——都是「这条路径没有 server」，
        // 不是「还没好」（后者是 indexing）。两句话对用户的可操作性不同。
        return fail(AgentLspStatus::NoServer, "no language server for this file");
    };
    let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, &pos.file);
    let (method, params) = match tool {
        "references" => (
            "textDocument/references",
            jump::references_params(&uri, pos.line, pos.character),
        ),
        "definition" => (
            "textDocument/definition",
            jump::position_params(&uri, pos.line, pos.character),
        ),
        "implementations" => (
            "textDocument/implementation",
            jump::position_params(&uri, pos.line, pos.character),
        ),
        other => return fail(AgentLspStatus::NoSymbol, &format!("unknown tool `{other}`")),
    };
    let outcome = match jump::issue(&h, method, params, crate::lsp::manager::DEFINITION_TIMEOUT).await
    {
        Ok(o) => o,
        Err(e) => return fail(AgentLspStatus::Error, &e),
    };
    let (status, results) = jump::map_outcome(outcome, "", workspace_root);
    if status != crate::lsp::JumpStatus::Ok || !results.is_empty() {
        // 结果非空 → ready 铁证；status 非 Ok → 直接透传（不冒充 ready）。
        let agent_status = match status {
            crate::lsp::JumpStatus::Ok => AgentLspStatus::Ready,
            crate::lsp::JumpStatus::Timeout => AgentLspStatus::Timeout,
            crate::lsp::JumpStatus::NotReady => AgentLspStatus::Indexing,
            crate::lsp::JumpStatus::Gone => AgentLspStatus::Gone,
        };
        return ok_with(agent_status, results);
    }
    // 空且 Ok —— 唯一需要探测的岔路：到底是「真没有」还是「还没索引好」。
    let confirmed = probe_ready(&h, &pos.file, workspace_root).await;
    ok_with(
        if confirmed {
            AgentLspStatus::Ready
        } else {
            AgentLspStatus::Indexing
        },
        results,
    )
}

fn ok_with(status: AgentLspStatus, results: Vec<crate::codegraph::types::QueryResult>) -> AgentQueryOutcome {
    let ready = status == AgentLspStatus::Ready;
    AgentQueryOutcome {
        ok: ready || !results.is_empty(),
        status,
        payload: json!({
            "ok": ready || !results.is_empty(),
            "status": status.as_str(),
            "count": results.len(),
            "results": results,
        }),
    }
}

/// 就绪判定：对一个**已知存在于磁盘的文件**做 `documentSymbol`。
/// 返回 true = 语义层可用（空结果可信）；false = 还没好（空结果不可信）。
async fn probe_ready(h: &Arc<ServerHandle>, file: &str, workspace_root: &str) -> bool {
    let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, file);
    let probe = || async {
        matches!(
            h.request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": uri } }),
                crate::lsp::manager::REQUEST_TIMEOUT,
            )
            .await,
            Ok(RequestOutcome::Ok(ref v)) if v.as_array().is_some_and(|a| !a.is_empty())
        )
    };
    await_ready(
        AgentLspStatus::Ready,
        probe,
        ReadinessBudget {
            total: std::time::Duration::from_secs(30),
            interval: std::time::Duration::from_secs(2),
        },
    )
    .await
        == AgentLspStatus::Ready
}

async fn server_for(
    state: &LspState,
    workspace_root: &str,
    file_path: &str,
) -> Option<Arc<ServerHandle>> {
    let lang_id = crate::lsp::lang_from_ext_of(file_path)?;
    let mgr = state.0.lock().await;
    mgr.get(workspace_root, lang_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_position_wins() {
        let p = resolve_position(&json!({"file":"/a/b.rs","line":216,"character":19})).unwrap();
        assert_eq!(p.file, "/a/b.rs");
        assert_eq!(p.line, 216);
        assert_eq!(p.character, 19);
    }

    #[test]
    fn bare_name_is_not_a_position() {
        assert!(resolve_position(&json!({"name":"LspManager::get"})).is_none());
    }

    #[test]
    fn partial_position_is_rejected() {
        assert!(resolve_position(&json!({"file":"/a/b.rs","line":1})).is_none());
    }

    /// 名字里带 `::` 时取最后一段做 workspace/symbol 的 query——
    /// server 的符号索引按裸名建，`LspManager::get` 直接查会空。
    #[test]
    fn symbol_query_name_takes_last_segment() {
        assert_eq!(symbol_query_name("LspManager::get"), "get");
        assert_eq!(symbol_query_name("is_excluded"), "is_excluded");
        assert_eq!(symbol_query_name("a::b::c"), "c");
    }

    /// 空 results 时 `ok` 必须是 false——`ok:true` + 空会被读成「查到了，就是没有」。
    #[test]
    fn empty_results_never_claim_ok_unless_ready() {
        let indexing = ok_with(AgentLspStatus::Indexing, vec![]);
        assert!(!indexing.ok);
        assert_eq!(indexing.payload["status"], "indexing");

        let ready = ok_with(AgentLspStatus::Ready, vec![]);
        assert!(ready.ok, "ready + 空 = 可信的「没有」");
    }
}
