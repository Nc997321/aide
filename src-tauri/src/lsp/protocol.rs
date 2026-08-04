use crate::codegraph::types::{Confidence, QueryResult, SymbolDef, SymbolKind};
use lsp_types::{CompletionItem, Location};

/// 前端 CM Completion 需要的最小字段（cmLsp 再映射成 CM 的 Completion 对象）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CmCompletion {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insert_text: Option<String>,
}

/// LSP Location（无符号名）+ 查询词 → QueryResult。
/// LSP 定义权威 → confidence=Structure；kind 无从得知 → 占位 Function（goto UI 走 name/file/line）。
pub fn location_to_query_result(loc: &Location, queried_word: &str) -> QueryResult {
    let start = loc.range.start;
    QueryResult {
        symbol: SymbolDef {
            name: queried_word.to_string(),
            kind: SymbolKind::Function, // 占位：LSP Location 不带 SymbolKind
            file: uri_to_path(loc.uri.as_str()),
            line: (start.line + 1) as usize,    // LSP 0-based → 1-based
            column: (start.character + 1) as usize,
            parent: None,
            end_line: 0,
        },
        confidence: Confidence::Structure,
        score: None,
        snippet: None,
    }
}

pub fn locations_to_query_results(locs: &[Location], word: &str) -> Vec<QueryResult> {
    locs.iter().map(|l| location_to_query_result(l, word)).collect()
}

pub fn completion_items_to_cm(items: &[CompletionItem]) -> Vec<CmCompletion> {
    items
        .iter()
        .map(|it| CmCompletion {
            label: it.label.clone(),
            detail: it.detail.clone(),
            documentation: it.documentation.as_ref().map(|d| match d {
                lsp_types::Documentation::String(s) => s.clone(),
                lsp_types::Documentation::MarkupContent(m) => m.value.clone(),
            }),
            kind: it.kind.map(|k| {
                // CompletionItemKind's inner i32 is private; extract via serde
                serde_json::from_value::<i32>(serde_json::to_value(k).unwrap()).unwrap_or(0) as u32
            }),
            insert_text: it.insert_text.clone(),
        })
        .collect()
}

/// 本地路径 → file:// URI。统一用 `/`，Windows 盘符前 `/C:/`。
pub fn path_to_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{}", normalized)
    } else {
        // Windows "C:/foo" → "file:///C:/foo"
        format!("file:///{}", normalized)
    }
}

/// file:// URI → 本地路径（用 `/`，前端与 codegraph 都用正斜杠）。
pub fn uri_to_path(uri: &str) -> String {
    if let Some(rest) = uri.strip_prefix("file:///") {
        // Windows: "C:/foo/bar" (drive letter + colon)
        // Unix:   "/home/x/foo/bar" — strip "file:///" removed the leading /
        if rest.len() > 1 && rest.as_bytes()[1] == b':' {
            rest.to_string()
        } else {
            format!("/{}", rest)
        }
    } else if let Some(rest) = uri.strip_prefix("file://") {
        rest.to_string()
    } else {
        uri.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::Location;

    /// 用 serde_json::from_value 构造 Location，避免 lsp-types 0.97 Uri 构造问题。
    fn make_location(uri: &str, line: u32, character: u32) -> Location {
        serde_json::from_value(serde_json::json!({
            "uri": uri,
            "range": {
                "start": { "line": line, "character": character },
                "end":   { "line": line, "character": character + 4 },
            }
        }))
        .expect("valid Location JSON")
    }

    #[test]
    fn lsp_location_to_query_result() {
        let loc = make_location("file:///C:/proj/src/main.rs", 5, 10);
        let qr = location_to_query_result(&loc, "my_fn");
        assert_eq!(qr.symbol.name, "my_fn");
        assert_eq!(qr.symbol.file, "C:/proj/src/main.rs");
        assert_eq!(qr.symbol.line, 6);       // 1-based
        assert_eq!(qr.symbol.column, 11);    // 1-based
        assert_eq!(qr.confidence, Confidence::Structure);
        assert_eq!(qr.score, None);
    }

    #[test]
    fn path_uri_round_trip_windows() {
        let p = "C:/proj/src/main.rs";
        let uri = path_to_uri(p);
        assert_eq!(uri, "file:///C:/proj/src/main.rs");
        assert_eq!(uri_to_path(&uri), p);
    }

    #[test]
    fn path_uri_round_trip_unix() {
        let p = "/home/x/proj/main.rs";
        let uri = path_to_uri(p);
        assert_eq!(uri, "file:///home/x/proj/main.rs");
        assert_eq!(uri_to_path(&uri), p);
    }

    #[test]
    fn backslash_path_normalized_in_uri() {
        let uri = path_to_uri("C:\\proj\\src\\main.rs");
        assert_eq!(uri, "file:///C:/proj/src/main.rs");
    }

    #[test]
    fn completion_items_map_label_detail_doc() {
        let items = vec![
            CompletionItem {
                label: "foo".into(),
                detail: Some("fn foo()".into()),
                documentation: Some(lsp_types::Documentation::String("docs".into())),
                kind: Some(lsp_types::CompletionItemKind::FUNCTION),
                insert_text: Some("foo()".into()),
                ..Default::default()
            },
        ];
        let cm = completion_items_to_cm(&items);
        assert_eq!(cm.len(), 1);
        assert_eq!(cm[0].label, "foo");
        assert_eq!(cm[0].detail.as_deref(), Some("fn foo()"));
        assert_eq!(cm[0].documentation.as_deref(), Some("docs"));
        assert!(cm[0].insert_text.as_deref() == Some("foo()"));
    }
}
