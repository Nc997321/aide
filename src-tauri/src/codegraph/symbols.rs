use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::codegraph::types::SymbolDef;

/// In-memory exact-lookup index: symbol name → every definition with that name
/// across the whole project. This is the structure-layer ground truth; the
/// Qdrant shard is only used for semantic (vector) fallback.
#[derive(Default, Serialize, Deserialize)]
pub struct SymbolTable {
    by_name: HashMap<String, Vec<SymbolDef>>,
}

impl SymbolTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, sym: SymbolDef) {
        self.by_name.entry(sym.name.clone()).or_default().push(sym);
    }

    /// All definitions matching `name` exactly (cross-file, case-sensitive).
    /// 仅测试使用——生产 query 层走 [`lookup_ignore_case`]（大小写不敏感、
    /// 带精确匹配快速路径）。cfg(test) 避免非 test 构建的 dead_code 警告。
    #[cfg(test)]
    pub fn lookup(&self, name: &str) -> Vec<SymbolDef> {
        self.by_name.get(name).cloned().unwrap_or_default()
    }

    /// Case-insensitive lookup. Falls back to exact match first (O(1)), then
    /// scans the table (O(n)) only when the input case differs from stored keys —
    /// the common path (exact copy-paste / Ctrl+click) stays fast.
    pub fn lookup_ignore_case(&self, name: &str) -> Vec<SymbolDef> {
        // Fast path: exact match covers the common case (Ctrl+click, copy-paste).
        if let Some(hit) = self.by_name.get(name) {
            return hit.clone();
        }
        let lower = name.to_lowercase();
        for (key, defs) in &self.by_name {
            if key.to_lowercase() == lower {
                return defs.clone();
            }
        }
        Vec::new()
    }

    /// Drop every symbol belonging to `file` (used on incremental re-index).
    pub fn remove_file(&mut self, file: &str) {
        for v in self.by_name.values_mut() {
            v.retain(|s| s.file != file);
        }
        self.by_name.retain(|_, v| !v.is_empty());
    }

    pub fn len(&self) -> usize {
        self.by_name.values().map(|v| v.len()).sum()
    }

    /// Conventional companion to `len()` (clippy `len_without_is_empty` requires it).
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::types::{SymbolDef, SymbolKind};

    fn sym(name: &str, file: &str, line: usize) -> SymbolDef {
        SymbolDef { name: name.into(), kind: SymbolKind::Method, file: file.into(), line, column: 1, parent: None }
    }

    #[test]
    fn lookup_returns_all_same_name_across_files() {
        let mut t = SymbolTable::new();
        t.insert(sym("save", "a/UserService.java", 10));
        t.insert(sym("save", "b/OrderService.java", 22));
        t.insert(sym("load", "c/Repo.java", 5));
        let mut hit = t.lookup("save");
        hit.sort_by_key(|s| s.line);
        assert_eq!(hit.len(), 2);
        assert_eq!(hit[0].file, "a/UserService.java");
        assert_eq!(hit[1].file, "b/OrderService.java");
        assert_eq!(t.lookup("missing").len(), 0);
    }

    #[test]
    fn remove_file_drops_only_that_files_symbols() {
        let mut t = SymbolTable::new();
        t.insert(sym("save", "a.java", 1));
        t.insert(sym("save", "b.java", 2));
        t.remove_file("a.java");
        assert_eq!(t.lookup("save").len(), 1);
        assert_eq!(t.lookup("save")[0].file, "b.java");
    }

    #[test]
    fn json_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cg_sym_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("symbols.json");
        let mut t = SymbolTable::new();
        t.insert(sym("save", "a.java", 1));
        t.save_json(&path).unwrap();
        let loaded = SymbolTable::load_json(&path).unwrap();
        assert_eq!(loaded.lookup("save").len(), 1);
        assert_eq!(loaded.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lookup_ignore_case_finds_different_casing() {
        let mut t = SymbolTable::new();
        t.insert(sym("ExitPayload", "shell.rs", 16));
        // Exact case still works.
        assert_eq!(t.lookup_ignore_case("ExitPayload").len(), 1);
        // Lowercase input also finds it.
        assert_eq!(t.lookup_ignore_case("exitpayload").len(), 1);
        // Uppercase input also finds it.
        assert_eq!(t.lookup_ignore_case("EXITPAYLOAD").len(), 1);
        // Unrelated name returns empty.
        assert_eq!(t.lookup_ignore_case("OtherThing").len(), 0);
    }
}
