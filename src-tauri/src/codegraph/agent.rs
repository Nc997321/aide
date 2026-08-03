use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::codegraph::types::SymbolDef;
use super::CodeGraphState;

pub const FIND_SYMBOL_CAP: usize = 20;
pub const SEMANTIC_DEFAULT_LIMIT: usize = 5;
pub const SEMANTIC_MAX_LIMIT: usize = 10;
/// Semantic snippets are trimmed to this many chars — signature + body start,
/// never a whole function body (token discipline for agent-facing output).
pub const SNIPPET_CAP: usize = 300;

/// Normalize an agent-supplied symbol name to the leaf segment.
/// Models naturally pass qualified forms ("PermissionManager.makeCallback",
/// "this.save", "UserService::save") and sometimes call forms ("save()",
/// "obj->save"); the index keys bare names. 2026-07-26 real-app A/B: 2 of the
/// first 3 tool calls missed purely on this form mismatch, teaching the model
/// the index was incomplete. Strictly better than no normalization: the index
/// is name-keyed anyway, so a full-form query can only miss, while the leaf
/// yields the candidate set (ambiguity is annotated via `candidates`).
fn leaf_name(name: &str) -> &str {
    // 先剥调用形式的尾巴："save()" → "save"
    let name = name.trim().trim_end_matches("()");
    // 再取叶段："A.b" / "A::b" / "a->b" → "b"
    name.rsplit(['.', ':'])
        .next()
        .unwrap_or(name)
        .rsplit("->")
        .next()
        .unwrap_or(name)
        .trim()
}

/// One intercepted `codegraph_query` event, validated.
pub struct AgentQueryRequest {
    pub request_id: String,
    pub tool: String,
    pub args: Value,
    pub project_root: String,
}

/// Validate + extract an agent query event. None → not a codegraph_query, or
/// malformed (missing request_id) — caller ignores it.
pub fn parse_codegraph_query(event: &Value) -> Option<AgentQueryRequest> {
    if event.get("type").and_then(|t| t.as_str()) != Some("codegraph_query") {
        return None;
    }
    Some(AgentQueryRequest {
        request_id: event.get("request_id")?.as_str()?.to_string(),
        tool: event.get("tool").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        args: event.get("args").cloned().unwrap_or(Value::Null),
        project_root: event
            .get("project_root")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Assemble the stdin command line payload: base payload + request_id + cmd tag.
pub fn build_result_command(request_id: &str, payload: Value) -> Value {
    let mut v = payload;
    v["cmd"] = Value::String("codegraph_result".into());
    v["request_id"] = Value::String(request_id.into());
    v
}

fn err_payload(msg: impl Into<String>) -> Value {
    json!({"ok": false, "status": "error", "error": msg.into()})
}

/// Execute one agent tool query against the live index. Designed to run inside
/// `spawn_blocking` (in-memory reads + optional shard search + optional embed).
/// Every outcome is a payload — this function never panics into the reader
/// task and never blocks on anything but the embedder mutex.
pub fn execute_agent_query(
    st: &CodeGraphState,
    tool: &str,
    args: &Value,
    project_root: &str,
    score_threshold: f32,
) -> Value {
    let root = PathBuf::from(project_root);
    match tool {
        "find_symbol" | "call_graph" => {
            let guard = match st.inner.read() {
                Ok(g) => g,
                Err(_) => return err_payload("index lock poisoned"),
            };
            let pi = match guard.as_ref() {
                None => return json!({"ok": true, "status": "no_index", "results": []}),
                Some(pi) => pi,
            };
            if pi.project_root != root {
                return json!({"ok": true, "status": "wrong_project", "results": []});
            }
            if tool == "find_symbol" {
                let name = leaf_name(args.get("name").and_then(|v| v.as_str()).unwrap_or(""));
                let hits = super::query::structure::structure_lookup(name, &pi.symbols, 0);
                // Collect owned candidates under the lock, then drop the lock
                // before the file-IO slice below — slicing reads source files
                // (blocking IO) and must not extend the read lock hold for
                // other queries (plan §7.2).
                let candidates: Vec<SymbolDef> = hits
                    .into_iter()
                    .take(FIND_SYMBOL_CAP)
                    .map(|r| r.symbol)
                    .collect();
                drop(guard);
                let results: Vec<Value> = candidates
                    .iter()
                    .map(|s| {
                        let source = super::query::structure::read_symbol_source(s, &root);
                        json!({
                            "kind": format!("{:?}", s.kind),
                            "name": s.name,
                            "file": s.file,
                            "line": s.line,
                            "end_line": s.end_line,
                            "parent": s.parent,
                            "source": source,
                        })
                    })
                    .collect();
                return json!({"ok": true, "status": "ready", "results": results});
            } else {
                let name = leaf_name(args.get("name").and_then(|v| v.as_str()).unwrap_or(""));
                let direction = args.get("direction").and_then(|v| v.as_str()).unwrap_or("callers");
                let r = if direction == "callees" {
                    super::query::calls::callees(name, &pi.edges, &pi.symbols)
                } else {
                    super::query::calls::callers(name, &pi.edges, &pi.symbols)
                };
                json!({
                    "ok": true,
                    "status": "ready",
                    "results": r.sites,
                    "candidates": r.candidates,
                    "truncated": r.truncated,
                })
            }
        }
        "semantic_search" => {
            // Clone shard + read embed_ready under the read lock, then DROP it
            // before the embed (same TOCTOU-safe pattern as codegraph_goto_definition).
            let (shard, embed_ready, root_ok, has_index) = {
                let guard = match st.inner.read() {
                    Ok(g) => g,
                    Err(_) => return err_payload("index lock poisoned"),
                };
                match guard.as_ref() {
                    None => (None, false, false, false),
                    Some(pi) => (
                        Some(pi.shard.clone()),
                        pi.embed_ready.load(Ordering::Relaxed),
                        pi.project_root == root,
                        true,
                    ),
                }
            };
            if !has_index {
                return json!({"ok": true, "status": "no_index", "results": []});
            }
            if !root_ok {
                return json!({"ok": true, "status": "wrong_project", "results": []});
            }
            if !embed_ready {
                return json!({"ok": true, "status": "structure_only", "results": []});
            }
            let shard = match shard {
                Some(s) => s,
                None => return err_payload("shard missing"),
            };
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|n| (n as usize).clamp(1, SEMANTIC_MAX_LIMIT))
                .unwrap_or(SEMANTIC_DEFAULT_LIMIT);
            let emb = match st.embedder.lock() {
                Ok(e) => e,
                Err(_) => return err_payload("embedder lock poisoned"),
            };
            let embedder = match emb.as_ref() {
                Some(e) => e,
                None => return json!({"ok": true, "status": "structure_only", "results": []}),
            };
            match super::query::semantic::semantic_search(query, embedder.as_ref(), &shard, limit, score_threshold) {
                Ok(hits) => {
                    let results: Vec<Value> = hits
                        .into_iter()
                        .map(|r| {
                            let snippet_full = r.snippet.unwrap_or_default();
                            let mut snippet = snippet_full.chars().take(SNIPPET_CAP).collect::<String>();
                            if snippet_full.chars().count() > SNIPPET_CAP {
                                snippet.push('…');
                            }
                            json!({
                                "name": r.symbol.name,
                                "kind": format!("{:?}", r.symbol.kind),
                                "file": r.symbol.file,
                                "line": r.symbol.line,
                                "end_line": r.symbol.end_line,
                                "score": r.score,
                                "snippet": snippet,
                            })
                        })
                        .collect();
                    json!({"ok": true, "status": "ready", "results": results})
                }
                Err(e) => err_payload(format!("semantic search failed: {e}")),
            }
        }
        other => err_payload(format!("unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::edges::EdgeTable;
    use crate::codegraph::symbols::SymbolTable;
    use crate::codegraph::types::{CallEdge, SymbolDef, SymbolKind};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AOrdering};
    use std::sync::Arc;

    fn sym(name: &str, kind: SymbolKind, file: &str, line: usize) -> SymbolDef {
        SymbolDef { name: name.into(), kind, file: file.into(), line, column: 1, parent: None, end_line: 0 }
    }

    /// 造一个只含结构层（embed_ready=false）的活跃索引。
    /// shard 目录按调用序号唯一——cargo test 默认多线程并行，共享同一目录
    /// 会让多个 CodeShard::create 抢同一个 wal/ 目录（os error 183）。
    fn state_with_index(root: &str) -> (CodeGraphState, PathBuf) {
        static DIR_SEQ: AtomicUsize = AtomicUsize::new(0);
        let seq = DIR_SEQ.fetch_add(1, AOrdering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cg_agent_{}_{}_{}", root, std::process::id(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = crate::codegraph::shard::CodeShard::create(&dir, 4).unwrap();
        let mut table = SymbolTable::new();
        table.insert(sym("save", SymbolKind::Method, "a.ts", 42));
        let mut edges = EdgeTable::new();
        edges.insert(CallEdge { caller: "main".into(), callee: "save".into(), file: "b.ts".into(), line: 88 });
        let st = CodeGraphState::new();
        *st.inner.write().unwrap() = Some(crate::codegraph::ProjectIndex {
            project_root: PathBuf::from(root),
            symbols: table,
            edges,
            shard: Arc::new(shard),
            indexed_at: std::time::SystemTime::now(),
            embed_ready: Arc::new(AtomicBool::new(false)),
        });
        (st, dir)
    }

    #[test]
    fn build_result_command_tags_cmd_and_request_id() {
        let v = build_result_command("r1", json!({"ok": true, "status": "ready", "results": []}));
        assert_eq!(v["cmd"], "codegraph_result");
        assert_eq!(v["request_id"], "r1");
        assert_eq!(v["status"], "ready");
    }

    #[test]
    fn parse_requires_request_id() {
        assert!(parse_codegraph_query(&json!({"type":"codegraph_query","tool":"find_symbol","args":{},"project_root":"/x"})).is_none());
        let r = parse_codegraph_query(&json!({"type":"codegraph_query","request_id":"r1","tool":"find_symbol","args":{"name":"x"},"project_root":"/x"})).unwrap();
        assert_eq!(r.request_id, "r1");
        assert_eq!(r.tool, "find_symbol");
        assert!(parse_codegraph_query(&json!({"type":"text_delta"})).is_none());
    }

    #[test]
    fn no_index_and_wrong_project_statuses() {
        let st = CodeGraphState::new();
        let r = execute_agent_query(&st, "find_symbol", &json!({"name":"save"}), "/proj", 0.35);
        assert_eq!(r["status"], "no_index");

        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "find_symbol", &json!({"name":"save"}), "projB", 0.35);
        assert_eq!(r["status"], "wrong_project");
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_symbol_ready_with_results() {
        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "find_symbol", &json!({"name":"save"}), "projA", 0.35);
        assert_eq!(r["status"], "ready");
        let results = r["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["file"], "a.ts");
        assert_eq!(results[0]["line"], 42);
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_symbol_zero_hits_stays_ready() {
        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "find_symbol", &json!({"name":"nope"}), "projA", 0.35);
        assert_eq!(r["status"], "ready", "zero hits ≠ index unavailable");
        assert_eq!(r["results"].as_array().unwrap().len(), 0);
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn call_graph_callers_direction() {
        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "call_graph", &json!({"name":"save","direction":"callers"}), "projA", 0.35);
        assert_eq!(r["status"], "ready");
        let results = r["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["peer"], "main");
        assert_eq!(results[0]["call_file"], "b.ts");
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn semantic_blocked_until_embed_ready() {
        let (st, dir) = state_with_index("projA"); // embed_ready=false
        let r = execute_agent_query(&st, "semantic_search", &json!({"query":"auth"}), "projA", 0.35);
        assert_eq!(r["status"], "structure_only");
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_tool_is_error() {
        let st = CodeGraphState::new();
        let r = execute_agent_query(&st, "nonsense", &json!({}), "/x", 0.35);
        assert_eq!(r["ok"], false);
        assert_eq!(r["status"], "error");
    }

    #[test]
    fn qualified_names_normalize_to_leaf() {
        assert_eq!(leaf_name("PermissionManager.makeCallback"), "makeCallback");
        assert_eq!(leaf_name("UserService::save"), "save");
        assert_eq!(leaf_name("this.save"), "save");
        assert_eq!(leaf_name("save"), "save");
        // 调用形式与箭头分隔也要剥
        assert_eq!(leaf_name("save()"), "save");
        assert_eq!(leaf_name("this->save"), "save");
        assert_eq!(leaf_name("SomeClass.save()"), "save");
        // 端到端：带类名前缀的查询也要命中
        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "find_symbol", &json!({"name": "SomeClass.save"}), "projA", 0.35);
        assert_eq!(r["status"], "ready");
        assert_eq!(r["results"].as_array().unwrap().len(), 1);
        let r = execute_agent_query(&st, "call_graph", &json!({"name": "SomeClass.save", "direction": "callers"}), "projA", 0.35);
        assert_eq!(r["results"].as_array().unwrap().len(), 1);
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }
}
