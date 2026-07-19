use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::{Confidence, QueryResult, SymbolKind};

/// Exact cross-file structure-layer lookup against the in-memory SymbolTable.
/// Case-insensitive so frontend palette search (which lowercases the query)
/// still finds `ExitPayload` even when the user typed `exitpayload`.
///
/// Results ranked by: (1) kind priority — definitions before fields before locals,
/// then (2) proximity to the cursor line (closest first).
pub fn structure_lookup(
    word: &str,
    table: &SymbolTable,
    cursor_line: usize,
) -> Vec<QueryResult> {
    let mut results: Vec<QueryResult> = table
        .lookup_ignore_case(word)
        .into_iter()
        .map(|symbol| QueryResult {
            symbol,
            confidence: Confidence::Structure,
            score: None,
        })
        .collect();

    results.sort_by(|a, b| {
        // First: kind priority (lower = more important)
        let ka = kind_rank(&a.symbol.kind);
        let kb = kind_rank(&b.symbol.kind);
        ka.cmp(&kb).then_with(|| {
            // Second: proximity to cursor
            let da = (a.symbol.line as isize - cursor_line as isize).unsigned_abs();
            let db = (b.symbol.line as isize - cursor_line as isize).unsigned_abs();
            da.cmp(&db)
        })
    });
    results
}

/// Lower number = higher priority. Definitions (Class/Enum/Interface/Function)
/// rank above fields, which rank above variables/constants.
fn kind_rank(k: &SymbolKind) -> u8 {
    match k {
        SymbolKind::Class | SymbolKind::Enum | SymbolKind::Interface => 0,
        SymbolKind::Function | SymbolKind::Method => 1,
        SymbolKind::Field => 2,
        SymbolKind::Variable => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::symbols::SymbolTable;
    use crate::codegraph::types::{SymbolDef, SymbolKind};

    fn sym(name: &str, file: &str, line: usize) -> SymbolDef {
        SymbolDef { name: name.into(), kind: SymbolKind::Method, file: file.into(), line, column: 1, parent: None }
    }

    #[test]
    fn structure_lookup_is_cross_file_and_ranks_by_cursor_proximity() {
        let mut t = SymbolTable::new();
        t.insert(sym("save", "far.java", 100));
        t.insert(sym("save", "near.java", 12));
        let res = structure_lookup("save", &t, 10);
        assert_eq!(res.len(), 2);
        assert!(matches!(res[0].confidence, Confidence::Structure));
        // line 12 is closer to cursor line 10 than line 100 → first
        assert_eq!(res[0].symbol.file, "near.java");
        assert!(res[0].score.is_none());
    }

    #[test]
    fn structure_lookup_is_case_insensitive() {
        let mut t = SymbolTable::new();
        t.insert(sym("ExitPayload", "shell.rs", 16));
        // Lowercase input (how the frontend palette sends it) must still find it.
        let res = structure_lookup("exitpayload", &t, 0);
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].symbol.name, "ExitPayload");
        assert_eq!(res[0].symbol.file, "shell.rs");
    }
}
