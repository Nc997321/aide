use std::path::Path;

use crate::codegraph::parser::ParserManager;
use crate::codegraph::types::{Confidence, QueryResult, SymbolDef, SymbolKind};

/// Search for a symbol definition/reference within a file using tree-sitter.
/// Returns struct-layer results if the word is found as a named node in the AST.
pub fn structure_lookup(
    word: &str,
    file_path: &str,
    line: usize,
    _column: usize,
    project_root: &Path,
    parser_manager: &ParserManager,
) -> Vec<QueryResult> {
    let full_path = project_root.join(file_path);
    let source = match std::fs::read_to_string(&full_path) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let tree = match parser_manager.parse_file(&full_path, &source) {
        Some(t) => t,
        None => return vec![],
    };

    let root_node = tree.root_node();
    let mut results: Vec<QueryResult> = Vec::new();
    find_definitions_for_word(&root_node, word, file_path, &source, &mut results, 0);

    // Deduplicate by (file, line, name)
    results.sort_by(|a, b| {
        a.symbol.file.cmp(&b.symbol.file)
            .then(a.symbol.line.cmp(&b.symbol.line))
    });
    results.dedup_by(|a, b| {
        a.symbol.file == b.symbol.file
            && a.symbol.line == b.symbol.line
            && a.symbol.name == b.symbol.name
    });

    // Put closest-to-cursor results first
    results.sort_by_key(|r| {
        (r.symbol.line as isize - line as isize).unsigned_abs()
    });

    results
}

fn find_definitions_for_word(
    node: &tree_sitter::Node,
    word: &str,
    file: &str,
    source: &str,
    results: &mut Vec<QueryResult>,
    depth: usize,
) {
    if depth > 1000 {
        return;
    }
    let kind = node.kind();

    if is_definition_kind(kind) {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                if name == word {
                let start = node.start_position();
                let mut parent_class: Option<String> = None;
                // Try to find containing class
                let mut cursor = node.walk();
                while cursor.goto_parent() {
                    let p = cursor.node();
                    let pk = p.kind();
                    if pk == "class_declaration" || pk == "class_definition"
                        || pk == "interface_declaration" || pk == "interface_definition"
                    {
                        if let Some(pn) = p.child_by_field_name("name") {
                            parent_class = match pn.utf8_text(source.as_bytes()) {
                                Ok(n) => Some(n.to_string()),
                                Err(_) => continue,
                            };
                        }
                        break;
                    }
                }

                results.push(QueryResult {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: kind_to_symbol_kind(kind),
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: parent_class,
                    },
                    confidence: Confidence::Structure,
                    score: None,
                });
            }
            }
        }
    }

    // Also search for references in method_invocation nodes
    if kind == "method_invocation" || kind == "call_expression" {
        if let Some(name_node) = node.child_by_field_name("name")
            .or_else(|| node.child_by_field_name("function"))
        {
            if let Ok(callee) = name_node.utf8_text(source.as_bytes()) {
                if callee == word {
                let start = node.start_position();
                results.push(QueryResult {
                    symbol: SymbolDef {
                        name: callee.to_string(),
                        kind: SymbolKind::Method,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: None,
                    },
                    confidence: Confidence::Structure,
                    score: None,
                });
            }
            }
        }
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            find_definitions_for_word(&child, word, file, source, results, depth + 1);
        }
    }
}

fn is_definition_kind(kind: &str) -> bool {
    matches!(
        kind,
        "class_declaration" | "class_definition"
        | "method_declaration" | "method_definition"
        | "function_declaration" | "function_definition"
        | "function_item"
        | "interface_declaration" | "interface_definition"
        | "enum_declaration" | "enum_definition"
        | "field_declaration" | "variable_declarator"
        | "public_field_definition" | "property_definition"
        | "constructor_declaration"
    )
}

fn kind_to_symbol_kind(kind: &str) -> SymbolKind {
    match kind {
        "class_declaration" | "class_definition" => SymbolKind::Class,
        "method_declaration" | "method_definition" | "constructor_declaration" => SymbolKind::Method,
        "function_declaration" | "function_definition" | "function_item" => SymbolKind::Function,
        "interface_declaration" | "interface_definition" => SymbolKind::Interface,
        "enum_declaration" | "enum_definition" => SymbolKind::Enum,
        "field_declaration" | "variable_declarator"
        | "public_field_definition" | "property_definition" => SymbolKind::Field,
        _ => SymbolKind::Variable,
    }
}
