use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLockReadGuard};

use serde_json::{json, Value};

use crate::codegraph::types::SymbolDef;
use super::shard::CodeShard;
use super::state::ProjectIndex;
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

/// A query's project-index source: either the live singleton (`inner`) when
/// its root matches the query root, or an on-demand-loaded index held in
/// `query_cache`. Both arms expose a `&ProjectIndex` to the tool functions;
/// the wrapper owns the read guard (`Inner`) or an `Arc` clone (`Cached`) so
/// the caller can drop it at the right moment — before file IO for find_symbol,
/// before the embedder lock for semantic — exactly as the pre-refactor code did.
enum QueryPi<'a> {
    Inner(RwLockReadGuard<'a, Option<ProjectIndex>>),
    Cached(Arc<ProjectIndex>),
}

impl<'a> QueryPi<'a> {
    /// The project index backing this query.
    fn pi(&self) -> &ProjectIndex {
        match self {
            // Invariant: `Inner` is only constructed when `inner` holds `Some`.
            QueryPi::Inner(g) => g.as_ref().expect("QueryPi::Inner must wrap Some"),
            QueryPi::Cached(a) => a.as_ref(),
        }
    }
}

/// Resolve which `ProjectIndex` answers this query.
///
/// 1. **Live singleton hit** (`inner` `project_root == root`) — the existing
///    path with zero behavior change; the frontend `ensureIndex` keeps it warm
///    for the active workspace and `codegraph_goto_definition` shares it.
/// 2. **On-demand path (A2)** otherwise: trusted gate → `query_cache` hit →
///    else `load_index_for_query` from `<root>/.aide/index/` and store the cache.
///    Returns `None` ⇒ `wrong_project` (untrusted / embedder not yet initialized
///    / no disk index / incompatible or still-embedding shard).
///
/// The singleton (`inner`) is **never written** on path 2 — that is the point of
/// A2: agent queries on a non-active workspace load their own root's index into
/// a throwaway cache without thrashing or polluting the singleton that the
/// active workspace's goto-definition depends on.
fn resolve_query_pi<'a>(
    st: &'a CodeGraphState,
    project_root: &str,
    root: &Path,
) -> Option<QueryPi<'a>> {
    let trusted = crate::commands::workspace::is_path_trusted(project_root);
    resolve_query_pi_with_trusted(st, root, trusted)
}

/// `resolve_query_pi` with the trusted gate injected. The production path
/// (`resolve_query_pi` above) computes `trusted` from `is_path_trusted`, which
/// reads the global on-disk `state.json` — non-deterministic across dev
/// machines / CI. The test harness calls this directly to control the gate;
/// nothing else should.
fn resolve_query_pi_with_trusted<'a>(
    st: &'a CodeGraphState,
    root: &Path,
    trusted: bool,
) -> Option<QueryPi<'a>> {
    // 1. Live singleton hit — existing behavior, unchanged. A poisoned lock is
    //    treated as "no usable singleton" and falls through to the on-demand
    //    path (a poisoned `inner` must not block an independent disk load).
    {
        if let Ok(g) = st.inner.read() {
            if let Some(pi) = g.as_ref() {
                if pi.project_root == root {
                    return Some(QueryPi::Inner(g));
                }
            }
        }
    }
    // 2. Trusted gate — untrusted workspaces never read their on-disk index
    //    (red line, mirrors `build.rs`). Applied to both the cache and the disk
    //    load: an untrusted root must never observe a previously-cached index.
    if !trusted {
        return None;
    }
    // 3. query_cache hit — same root, reuse the temp index, skip the disk load.
    {
        if let Ok(cache) = st.query_cache.lock() {
            if let Some((cached_root, pi_arc)) = cache.as_ref() {
                if cached_root == root {
                    return Some(QueryPi::Cached(pi_arc.clone()));
                }
            }
        }
    }
    // 4. Load from disk. `embedder_model` must be initialized (model+dim from
    //    the last build); `None` ⇒ app restarted before any build ⇒ return
    //    `None` (→ `wrong_project`) so the frontend `ensureIndex` initializes.
    let (model, dim) = {
        match st.embedder_model.lock() {
            Ok(em) => em.clone(),
            Err(_) => return None,
        }
    }?;
    let pi = super::indexer::load_index_for_query(root, &model, dim)?;
    let pi_arc = Arc::new(pi);
    store_query_cache(st, root.to_path_buf(), pi_arc.clone());
    Some(QueryPi::Cached(pi_arc))
}

/// Store a freshly-loaded temp index in the single-slot `query_cache`, evicting
/// the old slot. The evicted `Arc<ProjectIndex>` (and, if the cache is
/// poisoned, the freshly-loaded one we couldn't store) is dropped OUTSIDE the
/// mutex via `drop_catching_panics`: a `CodeShard` drop can panic on flush IO,
/// which would poison `query_cache` (and must never propagate into the reader
/// task — `execute_agent_query` is documented never to panic).
fn store_query_cache(st: &CodeGraphState, root: PathBuf, pi_arc: Arc<ProjectIndex>) {
    let evicted = match st.query_cache.lock() {
        Ok(mut cache) => cache.replace((root, pi_arc)),
        Err(_) => {
            // Cache poisoned: can't store. Drop the freshly-loaded index
            // catching panics so we never propagate into the reader task.
            super::guard::drop_catching_panics(pi_arc, "uncached query index");
            return;
        }
    };
    if let Some((old_root, old_pi)) = evicted {
        drop(old_root); // PathBuf, never panics.
        super::guard::drop_catching_panics(old_pi, "old query_cache index");
    }
}

/// find_symbol, lock-held part: collect owned candidate symbols under the read
/// lock (pure memory). The caller drops the lock before `find_symbol_results`
/// does file IO — slicing source files is blocking IO and must not extend the
/// read lock hold for other queries (plan §7.2).
fn find_symbol_collect(pi: &ProjectIndex, args: &Value) -> Vec<SymbolDef> {
    let name = leaf_name(args.get("name").and_then(|v| v.as_str()).unwrap_or(""));
    let hits = super::query::structure::structure_lookup(name, &pi.symbols, 0);
    hits.into_iter().take(FIND_SYMBOL_CAP).map(|r| r.symbol).collect()
}

/// find_symbol, lock-released part: read source slices (blocking IO) and
/// assemble the result payload. Runs with no lock held.
fn find_symbol_results(candidates: &[SymbolDef], root: &Path) -> Value {
    let results: Vec<Value> = candidates
        .iter()
        .map(|s| {
            let source = super::query::structure::read_symbol_source(s, root);
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
    json!({"ok": true, "status": "ready", "results": results})
}

/// call_graph: pure memory (edges + symbols lookup), returns an owned payload.
/// Safe to run under the read lock; the caller drops the wrapper right after
/// for uniformity, but no IO is pending.
fn call_graph_on(pi: &ProjectIndex, args: &Value) -> Value {
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

/// Owned snapshot of the semantic-relevant fields of a `ProjectIndex`, taken
/// under the read lock so the lock can be released before the embedder mutex is
/// acquired (same TOCTOU-safe pattern as `codegraph_goto_definition`).
struct SemanticSnapshot {
    shard: Arc<CodeShard>,
    embed_ready: bool,
    symbol_count: usize,
}

fn semantic_snapshot(pi: &ProjectIndex) -> SemanticSnapshot {
    SemanticSnapshot {
        shard: pi.shard.clone(),
        embed_ready: pi.embed_ready.load(Ordering::Relaxed),
        symbol_count: pi.symbols.len(),
    }
}

/// semantic_search, lock-released part: embedder lock + shard search. The old
/// `has_index` / `root_ok` checks lived on the singleton path; here
/// `resolve_query_pi` already gated those (`None` ⇒ `wrong_project` upstream),
/// so this only handles embed_ready / degraded / embedder-missing / search.
fn semantic_results(
    snap: &SemanticSnapshot,
    args: &Value,
    st: &CodeGraphState,
    score_threshold: f32,
) -> Value {
    if !snap.embed_ready {
        return json!({"ok": true, "status": "structure_only", "results": []});
    }
    // Degraded shard: the loaders are supposed to reject a vector-less
    // "complete" shard, but defense-in-depth — if point_count is far below the
    // symbol count, surface "degraded" so the agent/user rebuilds instead of
    // trusting a 0-result "index is healthy".
    let pc = snap.shard.point_count();
    if snap.symbol_count > 0 && pc < snap.symbol_count / 2 {
        return json!({
            "ok": true,
            "status": "degraded",
            "results": [],
            "health": format!("shard_point_count={} vs symbols={}", pc, snap.symbol_count),
        });
    }
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
    match super::query::semantic::semantic_search(query, embedder.as_ref(), &snap.shard, limit, score_threshold) {
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

/// Execute one agent tool query against the resolved project index. Designed
/// to run inside `spawn_blocking` (in-memory reads + optional shard search +
/// optional embed). Every outcome is a payload — this function never panics
/// into the reader task and never blocks on anything but the embedder mutex.
///
/// Index resolution is decoupled from the singleton (A2): when the session cwd
/// (the query root) ≠ the singleton's root, the query root's on-disk index is
/// loaded on demand into a single-slot cache — the singleton stays untouched,
/// so the frontend `ensureIndex`-managed active workspace and
/// `codegraph_goto_definition` are never disturbed by agent queries on another
/// workspace. Untrusted query roots never read their disk index.
pub fn execute_agent_query(
    st: &CodeGraphState,
    tool: &str,
    args: &Value,
    project_root: &str,
    score_threshold: f32,
) -> Value {
    let root = PathBuf::from(project_root);
    // Validate the tool before resolving an index, so an unknown tool name
    // never triggers a disk load.
    if !matches!(tool, "find_symbol" | "call_graph" | "semantic_search") {
        return err_payload(format!("unknown tool: {tool}"));
    }
    let query_pi = match resolve_query_pi(st, project_root, &root) {
        Some(qp) => qp,
        None => return json!({"ok": true, "status": "wrong_project", "results": []}),
    };
    match tool {
        "find_symbol" => {
            let candidates = find_symbol_collect(query_pi.pi(), args);
            // Drop the lock/Arc before file IO (slicing source files — blocking
            // IO must not extend the read lock hold for other queries).
            drop(query_pi);
            find_symbol_results(&candidates, &root)
        }
        "call_graph" => {
            let v = call_graph_on(query_pi.pi(), args);
            drop(query_pi);
            v
        }
        "semantic_search" => {
            let snap = semantic_snapshot(query_pi.pi());
            drop(query_pi);
            semantic_results(&snap, args, st, score_threshold)
        }
        // Unreachable: tool validated above. Kept for exhaustiveness.
        _ => err_payload("unreachable tool branch"),
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
        *st.inner.write().unwrap() = Some(crate::codegraph::state::ProjectIndex {
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
    fn empty_state_untrusted_returns_wrong_project() {
        // A2: empty inner + untrusted → wrong_project（原 no_index 统一进
        // wrong_project——对 agent 而言「没索引」与「索引不属于本项目」都意味着
        // 自动 load 失败）。用 `resolve_query_pi_with_trusted` 直接注入 trusted：
        // `is_path_trusted` 读全局 state.json，跨开发机/CI 不确定。
        let st = CodeGraphState::new();
        let pi = resolve_query_pi_with_trusted(&st, std::path::Path::new("/proj"), false);
        assert!(pi.is_none(), "empty inner + untrusted → wrong_project");
    }

    #[test]
    fn inner_miss_untrusted_end_to_end_wrong_project() {
        // execute_agent_query 端到端：inner=projA 不匹配 projB + 未信任 →
        // wrong_project 负载（而非 no_index）。"projB" 非真实路径，测试环境
        // state.json 不含它 → is_path_trusted=false。
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

    // ── A2: 按需 load / query_cache / trusted 门控 ──

    /// 落盘一个完整索引（embed_complete=true + 1 符号 + 空 shard），模拟「会话
    /// cwd 的磁盘索引完好」。symbol_count=1 使 `shard_point_count_broken` 的
    /// `pc(0) < 1/2=0` 判定为未损坏（整数除法），`load_compatible_index` 能读回。
    fn write_disk_index(root: &std::path::Path, model: &str, dim: usize) -> PathBuf {
        let base = crate::codegraph::indexer::index_dir(root);
        std::fs::create_dir_all(&base).unwrap();
        let shard_dir_name = "qdrant-test";
        let shard_dir = base.join(shard_dir_name);
        let _ = std::fs::remove_dir_all(&shard_dir);
        let _shard = crate::codegraph::shard::CodeShard::create(&shard_dir, dim).unwrap();
        let mut table = SymbolTable::new();
        table.insert(sym("save", SymbolKind::Method, "a.ts", 42));
        let mut edges = EdgeTable::new();
        edges.insert(CallEdge {
            caller: "main".into(),
            callee: "save".into(),
            file: "b.ts".into(),
            line: 88,
        });
        table.save_json(&base.join("symbols.json")).unwrap();
        edges.save_json(&base.join("edges.json")).unwrap();
        let meta = crate::codegraph::meta::Meta {
            version: crate::codegraph::meta::META_VERSION,
            model_name: model.to_string(),
            indexed_at: crate::codegraph::meta::now_epoch(),
            symbol_count: table.len(),
            dim,
            shard_dir: shard_dir_name.to_string(),
            embed_complete: true,
        };
        meta.save(&base.join("meta.json")).unwrap();
        base
    }

    fn set_embedder_model(st: &CodeGraphState, model: &str, dim: usize) {
        *st.embedder_model.lock().unwrap() = Some((model.to_string(), dim));
    }

    #[test]
    fn trusted_disk_index_auto_loads_when_inner_misses() {
        // A2 核心：inner 空 + trusted + 磁盘索引完好 → 自动 load 进 query_cache，
        // 查询 ready（不再是 wrong_project）。
        let dir = std::env::temp_dir().join(format!("cg_agent_autoload_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_disk_index(&dir, "m", 4);
        let st = CodeGraphState::new();
        set_embedder_model(&st, "m", 4);
        let resolved = resolve_query_pi_with_trusted(&st, &dir, true);
        assert!(resolved.is_some(), "trusted + disk index → auto-load");
        let r = find_symbol_results(
            &find_symbol_collect(resolved.as_ref().unwrap().pi(), &json!({"name":"save"})),
            &dir,
        );
        assert_eq!(r["status"], "ready");
        assert_eq!(r["results"].as_array().unwrap().len(), 1);
        // 自动 load 后存入 query_cache（key == root）。
        assert_eq!(st.query_cache.lock().unwrap().as_ref().unwrap().0, dir);
        // 清理：先 drop resolved 的 Arc，再 take cache → drop_catching_panics
        // 释放 CodeShard（flush）→ 删盘。
        drop(resolved);
        let cache_pi = st.query_cache.lock().unwrap().take().unwrap().1;
        crate::codegraph::guard::drop_catching_panics(cache_pi, "test cache");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn embedder_model_none_blocks_auto_load() {
        // trusted + 磁盘索引 + 但 embedder_model=None（app 重启后首次查询）→
        // 不 load（None → wrong_project），让前端 ensureIndex 初始化 embedder。
        let dir = std::env::temp_dir().join(format!("cg_agent_noembedder_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_disk_index(&dir, "m", 4);
        let st = CodeGraphState::new(); // embedder_model 默认 None
        let resolved = resolve_query_pi_with_trusted(&st, &dir, true);
        assert!(resolved.is_none(), "embedder_model None → no auto-load");
        assert!(st.query_cache.lock().unwrap().is_none(), "cache not populated");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn untrusted_root_never_reads_cached_index() {
        // 红线：同 root 的 query_cache 已有索引（之前 trusted 时 load 的遗留），
        // 但 root 未信任 → 不读 cache、不读盘 → None。
        let dir = std::env::temp_dir().join(format!("cg_agent_untrusted_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_disk_index(&dir, "m", 4);
        let st = CodeGraphState::new();
        set_embedder_model(&st, "m", 4);
        // 先 trusted 自动 load 填 cache。
        let r = resolve_query_pi_with_trusted(&st, &dir, true).expect("primed");
        drop(r);
        assert!(st.query_cache.lock().unwrap().is_some(), "cache primed");
        // 同 root 但 untrusted → 不读 cache、不读盘。
        let r2 = resolve_query_pi_with_trusted(&st, &dir, false);
        assert!(r2.is_none(), "untrusted root must not read cached/disk index");
        // 清理 cache。
        let cp = st.query_cache.lock().unwrap().take().unwrap().1;
        crate::codegraph::guard::drop_catching_panics(cp, "test cache");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn query_cache_hit_skips_disk_load_and_embedder_model() {
        // 同 root 第二次查询命中 query_cache：不读盘、不要求 embedder_model
        // （cache hit 在 embedder_model 检查之前）。证明缓存生效。
        let dir = std::env::temp_dir().join(format!("cg_agent_cachehit_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_disk_index(&dir, "m", 4);
        let st = CodeGraphState::new();
        set_embedder_model(&st, "m", 4);
        // 第一次：inner 空 + trusted + 磁盘 → 自动 load 填 cache。
        let r1 = resolve_query_pi_with_trusted(&st, &dir, true).expect("first load");
        let c1 = find_symbol_collect(r1.pi(), &json!({"name":"save"}));
        assert_eq!(c1.len(), 1);
        drop(r1);
        // 第二次：清 embedder_model（模拟 app 重启），cache hit 不依赖它。
        *st.embedder_model.lock().unwrap() = None;
        let r2 = resolve_query_pi_with_trusted(&st, &dir, true).expect("cache hit");
        let c2 = find_symbol_collect(r2.pi(), &json!({"name":"save"}));
        assert_eq!(c2.len(), 1);
        drop(r2);
        let cp = st.query_cache.lock().unwrap().take().unwrap().1;
        crate::codegraph::guard::drop_catching_panics(cp, "test cache");
        std::fs::remove_dir_all(&dir).ok();
    }
}
