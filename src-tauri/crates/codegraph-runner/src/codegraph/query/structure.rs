use std::path::Path;

use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::{Confidence, QueryResult, SymbolDef, SymbolKind};

/// Exact cross-file structure-layer lookup against the in-memory SymbolTable.
/// Case-insensitive so frontend palette search (which lowercases the query)
/// still finds `ExitPayload` even when the user typed `exitpayload`.
///
/// Results ranked by: (1) kind priority — definitions before fields before locals,
/// then (2) proximity to the cursor line (closest first).
pub fn structure_lookup(word: &str, table: &SymbolTable, cursor_line: usize) -> Vec<QueryResult> {
    let mut results: Vec<QueryResult> = table
        .lookup_ignore_case(word)
        .into_iter()
        .map(|symbol| QueryResult {
            symbol,
            confidence: Confidence::Structure,
            score: None,
            snippet: None,
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

/// Maximum lines / bytes of source we'll slice for one find_symbol hit. A
/// giant function beyond these caps falls back to span-only (the agent then
/// uses `end_line` to Read precisely), so a single huge symbol can't flood the
/// agent's context window.
const MAX_SOURCE_LINES: usize = 200;
const MAX_SOURCE_BYTES: usize = 8 * 1024;

/// Slice a symbol's full source `[line, end_line]` from its file, each line
/// prefixed by its 1-based number (cat -n style). Returns None when:
/// - the span is missing (`end_line == 0`, e.g. an old index loaded via
///   `#[serde(default)]`) or out of order → caller emits span-less output;
/// - the span exceeds `MAX_SOURCE_LINES` / `MAX_SOURCE_BYTES` → caller falls
///   back to span-only and the agent uses `end_line` to Read precisely;
/// - the file can't be read or the span is beyond EOF → likewise.
///
/// Runs in the `spawn_blocking` agent-query task, so synchronous file IO here
/// is fine. Callers MUST drop the index read lock before calling — this does
/// blocking IO and must not extend lock hold time for other queries.
pub fn read_symbol_source(symbol: &SymbolDef, project_root: &Path) -> Option<String> {
    // end_line == 0 ⇒ old index (serde default) or extractor miss: no span,
    // fall back so the agent uses `line` as before.
    if symbol.end_line == 0 || symbol.end_line < symbol.line {
        return None;
    }
    let span = symbol.end_line - symbol.line + 1;
    if span > MAX_SOURCE_LINES {
        return None;
    }
    let path = project_root.join(&symbol.file);
    let content = std::fs::read_to_string(&path).ok()?;
    // enumerate() before skip() so the index is the original 1-based line
    // number, not a post-skip counter — `skip` keeps enumerate's indices.
    let snippet: String = content
        .lines()
        .enumerate()
        .skip(symbol.line - 1)
        .take(span)
        .map(|(i, line)| format!("{}\t{}", i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");
    if snippet.is_empty() || snippet.len() > MAX_SOURCE_BYTES {
        return None;
    }
    Some(snippet)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::symbols::SymbolTable;
    use crate::codegraph::types::{SymbolDef, SymbolKind};

    fn sym(name: &str, file: &str, line: usize) -> SymbolDef {
        SymbolDef {
            name: name.into(),
            kind: SymbolKind::Method,
            file: file.into(),
            line,
            column: 1,
            parent: None,
            end_line: 0,
        }
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

    fn src_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cg_src_{}_{}_{}", tag, std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_symbol_source_slices_span_with_line_numbers() {
        let dir = src_dir("slice");
        std::fs::write(dir.join("a.ts"), "line1\nline2\nline3\nline4\nline5\n").unwrap();
        let sym = SymbolDef {
            name: "fn".into(),
            kind: SymbolKind::Function,
            file: "a.ts".into(),
            line: 2,
            column: 1,
            parent: None,
            end_line: 4,
        };
        let src = read_symbol_source(&sym, &dir).unwrap();
        assert_eq!(src, "2\tline2\n3\tline3\n4\tline4");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_symbol_source_returns_none_for_missing_span() {
        let dir = src_dir("none");
        std::fs::write(dir.join("a.ts"), "x\n").unwrap();
        // end_line == 0 (old index via serde default) → None
        let sym = SymbolDef {
            name: "fn".into(),
            kind: SymbolKind::Function,
            file: "a.ts".into(),
            line: 1,
            column: 1,
            parent: None,
            end_line: 0,
        };
        assert!(read_symbol_source(&sym, &dir).is_none());
        // end_line < line (out of order) → None
        let sym2 = SymbolDef {
            name: "fn".into(),
            kind: SymbolKind::Function,
            file: "a.ts".into(),
            line: 3,
            column: 1,
            parent: None,
            end_line: 2,
        };
        assert!(read_symbol_source(&sym2, &dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_symbol_source_returns_none_when_span_exceeds_line_cap() {
        let dir = src_dir("cap");
        // 250 lines, exceeds MAX_SOURCE_LINES (200)
        let content = (1..=250)
            .map(|n| format!("line{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.join("big.ts"), &content).unwrap();
        let sym = SymbolDef {
            name: "big".into(),
            kind: SymbolKind::Function,
            file: "big.ts".into(),
            line: 1,
            column: 1,
            parent: None,
            end_line: 250,
        };
        assert!(
            read_symbol_source(&sym, &dir).is_none(),
            "span 250 > MAX_SOURCE_LINES 200 → None"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_symbol_source_returns_none_when_file_missing() {
        let dir = src_dir("missing");
        // no file written → read_to_string fails → None
        let sym = SymbolDef {
            name: "fn".into(),
            kind: SymbolKind::Function,
            file: "gone.ts".into(),
            line: 1,
            column: 1,
            parent: None,
            end_line: 3,
        };
        assert!(read_symbol_source(&sym, &dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
