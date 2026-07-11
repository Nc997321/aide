use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::{Confidence, QueryResult};

/// Exact cross-file structure-layer lookup against the in-memory SymbolTable.
/// Results ranked by proximity to the cursor line (closest first) as a tie-break.
pub fn structure_lookup(
    word: &str,
    table: &SymbolTable,
    cursor_line: usize,
) -> Vec<QueryResult> {
    let mut results: Vec<QueryResult> = table
        .lookup(word)
        .into_iter()
        .map(|symbol| QueryResult {
            symbol,
            confidence: Confidence::Structure,
            score: None,
        })
        .collect();

    results.sort_by_key(|r| (r.symbol.line as isize - cursor_line as isize).unsigned_abs());
    results
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
}
