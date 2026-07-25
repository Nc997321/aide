use serde::Serialize;

use crate::codegraph::edges::EdgeTable;
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::CallEdge;

/// Cap per direction per query — token discipline for agent-facing output.
pub const CALL_GRAPH_CAP: usize = 30;

/// One call-graph result row: the symbol on the other end of the edge, its
/// candidate definition locations (name-level join can be ambiguous), and the
/// call site. All strings are pre-formatted for compact agent consumption.
#[derive(Debug, Clone, Serialize)]
pub struct CallSite {
    /// Name of the symbol on the other end; "(顶层)" for module-scope calls.
    pub peer: String,
    /// "file:line" of every definition of `peer` (empty for top-level peers).
    pub peer_defs: Vec<String>,
    pub call_file: String,
    pub call_line: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallGraphResult {
    pub sites: Vec<CallSite>,
    /// Number of distinct definitions the QUERIED name maps to (>1 = the
    /// name-level join is ambiguous; agent should Read to disambiguate).
    pub candidates: usize,
    pub truncated: bool,
}

fn to_sites(edges: Vec<CallEdge>, peer_of: fn(&CallEdge) -> &str, table: &SymbolTable) -> (Vec<CallSite>, bool) {
    let truncated = edges.len() > CALL_GRAPH_CAP;
    let sites = edges
        .into_iter()
        .take(CALL_GRAPH_CAP)
        .map(|e| {
            let raw = peer_of(&e);
            let (peer, peer_defs) = if raw.is_empty() {
                ("(顶层)".to_string(), Vec::new())
            } else {
                (
                    raw.to_string(),
                    table
                        .lookup_ignore_case(raw)
                        .iter()
                        .map(|d| format!("{}:{}", d.file, d.line))
                        .collect(),
                )
            };
            CallSite { peer, peer_defs, call_file: e.file, call_line: e.line }
        })
        .collect();
    (sites, truncated)
}

/// Who calls `name` — edges whose callee is `name`, peer = caller.
pub fn callers(name: &str, edges: &EdgeTable, table: &SymbolTable) -> CallGraphResult {
    let candidates = table.lookup_ignore_case(name).len();
    let (sites, truncated) = to_sites(edges.callers_of(name), |e| e.caller.as_str(), table);
    CallGraphResult { sites, candidates, truncated }
}

/// What `name` calls — edges whose caller is `name`, peer = callee.
pub fn callees(name: &str, edges: &EdgeTable, table: &SymbolTable) -> CallGraphResult {
    let candidates = table.lookup_ignore_case(name).len();
    let (sites, truncated) = to_sites(edges.callees_of(name), |e| e.callee.as_str(), table);
    CallGraphResult { sites, candidates, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::types::{SymbolDef, SymbolKind};

    fn sym(name: &str, file: &str, line: usize) -> SymbolDef {
        SymbolDef { name: name.into(), kind: SymbolKind::Method, file: file.into(), line, column: 1, parent: None }
    }

    fn fixture() -> (EdgeTable, SymbolTable) {
        let mut edges = EdgeTable::new();
        edges.insert(CallEdge { caller: "main".into(), callee: "save".into(), file: "b.ts".into(), line: 88 });
        edges.insert(CallEdge { caller: "".into(), callee: "save".into(), file: "c.ts".into(), line: 3 });
        edges.insert(CallEdge { caller: "main".into(), callee: "load".into(), file: "b.ts".into(), line: 90 });
        let mut table = SymbolTable::new();
        table.insert(sym("main", "b.ts", 10));
        table.insert(sym("save", "a.ts", 42));
        table.insert(sym("load", "d.ts", 7));
        (edges, table)
    }

    #[test]
    fn callers_returns_sites_with_peer_definitions() {
        let (edges, table) = fixture();
        let r = callers("save", &edges, &table);
        assert_eq!(r.sites.len(), 2);
        assert_eq!(r.candidates, 1, "save has exactly one definition");
        let site = r.sites.iter().find(|s| s.peer == "main").unwrap();
        assert_eq!(site.peer_defs, vec!["b.ts:10".to_string()]);
        assert_eq!(site.call_file, "b.ts");
        assert_eq!(site.call_line, 88);
        // 顶层调用 peer 标注
        assert!(r.sites.iter().any(|s| s.peer == "(顶层)"));
    }

    #[test]
    fn callees_returns_what_function_calls() {
        let (edges, table) = fixture();
        let r = callees("main", &edges, &table);
        assert_eq!(r.sites.len(), 2);
        let callees: Vec<&str> = r.sites.iter().map(|s| s.peer.as_str()).collect();
        assert!(callees.contains(&"save"));
        assert!(callees.contains(&"load"));
    }

    #[test]
    fn ambiguous_name_reports_candidate_count() {
        let (edges, mut table) = fixture();
        table.insert(sym("save", "z.ts", 1)); // 第二个 save 定义
        let r = callers("save", &edges, &table);
        assert_eq!(r.candidates, 2, "two save definitions → candidates=2");
    }

    #[test]
    fn cap_truncates_and_flags() {
        let mut edges = EdgeTable::new();
        for i in 0..35 {
            edges.insert(CallEdge { caller: format!("f{}", i), callee: "hot".into(), file: "x.ts".into(), line: i });
        }
        let table = SymbolTable::new();
        let r = callers("hot", &edges, &table);
        assert_eq!(r.sites.len(), CALL_GRAPH_CAP);
        assert!(r.truncated);
    }
}
