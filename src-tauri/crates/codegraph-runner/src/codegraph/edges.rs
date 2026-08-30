use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::codegraph::types::CallEdge;

/// In-memory call-edge index, dual-keyed: `by_callee` answers "who calls X",
/// `by_caller` answers "what does X call". Structure-layer ground truth from
/// tree-sitter extraction; name-level joins (ambiguity handled in query::calls).
#[derive(Default, Serialize, Deserialize)]
pub struct EdgeTable {
    by_callee: HashMap<String, Vec<CallEdge>>,
    by_caller: HashMap<String, Vec<CallEdge>>,
}

impl EdgeTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, edge: CallEdge) {
        self.by_caller
            .entry(edge.caller.clone())
            .or_default()
            .push(edge.clone());
        self.by_callee
            .entry(edge.callee.clone())
            .or_default()
            .push(edge);
    }

    /// All edges whose callee is `name` (call sites of `name`).
    pub fn callers_of(&self, name: &str) -> Vec<CallEdge> {
        self.by_callee.get(name).cloned().unwrap_or_default()
    }

    /// All edges whose caller is `name` (calls made by `name`).
    pub fn callees_of(&self, name: &str) -> Vec<CallEdge> {
        self.by_caller.get(name).cloned().unwrap_or_default()
    }

    /// Drop every edge recorded in `file` (incremental re-index).
    pub fn remove_file(&mut self, file: &str) {
        for v in self
            .by_callee
            .values_mut()
            .chain(self.by_caller.values_mut())
        {
            v.retain(|e| e.file != file);
        }
        self.by_callee.retain(|_, v| !v.is_empty());
        self.by_caller.retain(|_, v| !v.is_empty());
    }

    pub fn save_json(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(path, bytes)
    }

    pub fn load_json(path: &Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

/// 测试断言用：当前总边数（caller→callee 记录条数）。生产路径不查边数，仅
/// `#[cfg(test)]` 编译，避免 dead_code 警告；将来若加「索引 N 条边」日志再提回主 impl。
#[cfg(test)]
impl EdgeTable {
    pub fn len(&self) -> usize {
        self.by_callee.values().map(|v| v.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(caller: &str, callee: &str, file: &str, line: usize) -> CallEdge {
        CallEdge {
            caller: caller.into(),
            callee: callee.into(),
            file: file.into(),
            line,
        }
    }

    #[test]
    fn dual_index_lookup_both_directions() {
        let mut t = EdgeTable::new();
        t.insert(edge("main", "save", "a.ts", 10));
        t.insert(edge("main", "load", "a.ts", 11));
        t.insert(edge("boot", "save", "b.ts", 5));
        assert_eq!(t.callers_of("save").len(), 2);
        assert_eq!(t.callees_of("main").len(), 2);
        assert_eq!(t.callers_of("missing").len(), 0);
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn remove_file_drops_edges_from_both_indexes() {
        let mut t = EdgeTable::new();
        t.insert(edge("main", "save", "a.ts", 10));
        t.insert(edge("boot", "save", "b.ts", 5));
        t.remove_file("a.ts");
        assert_eq!(t.callers_of("save").len(), 1);
        assert_eq!(t.callees_of("main").len(), 0);
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn json_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cg_edges_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("edges.json");
        let mut t = EdgeTable::new();
        t.insert(edge("main", "save", "a.ts", 10));
        t.save_json(&path).unwrap();
        let loaded = EdgeTable::load_json(&path).unwrap();
        assert_eq!(loaded.callers_of("save").len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
