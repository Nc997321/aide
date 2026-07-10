use std::path::Path;
use tree_sitter::Node;

use crate::codegraph::parser::ParserManager;
use crate::codegraph::types::{CallEdge, Confidence, IndexedPoint, SymbolDef, SymbolKind};

/// Extract symbols and call edges from a single file's AST.
pub fn extract_symbols(
    file_path: &Path,
    source: &str,
    parser_manager: &ParserManager,
    project_root: &Path,
) -> (Vec<IndexedPoint>, Vec<CallEdge>) {
    let tree = match parser_manager.parse_file(file_path, source) {
        Some(t) => t,
        None => return (vec![], vec![]),
    };

    let root_node = tree.root_node();
    let relative_path = file_path
        .strip_prefix(project_root)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");

    let mut symbols: Vec<IndexedPoint> = Vec::new();
    let mut call_edges: Vec<CallEdge> = Vec::new();

    // Walk all named nodes looking for definitions and calls
    extract_from_node(
        &root_node,
        source,
        &relative_path,
        None,
        &mut symbols,
        &mut call_edges,
    );

    (symbols, call_edges)
}

fn extract_from_node(
    node: &Node,
    source: &str,
    file: &str,
    parent_class: Option<&str>,
    symbols: &mut Vec<IndexedPoint>,
    call_edges: &mut Vec<CallEdge>,
) {
    let kind = node.kind();

    match kind {
        // ── Definition nodes ──
        "class_declaration" | "class_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = match name_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: SymbolKind::Class,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: None,
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
                // Recurse into class body with this class as parent
                let parent = name.to_string();
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        extract_from_node(
                            &child, source, file, Some(&parent),
                            symbols, call_edges,
                        );
                    }
                }
                return; // children already handled
            }
        }

        "interface_declaration" | "interface_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = match name_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: SymbolKind::Interface,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: None,
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
            }
        }

        "enum_declaration" | "enum_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = match name_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: SymbolKind::Enum,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: None,
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
            }
        }

        "method_declaration" | "function_declaration"
        | "method_definition" | "function_definition"
        | "function_item" | "constructor_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = match name_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let start = node.start_position();
                let kind = if parent_class.is_some() || kind.contains("method") {
                    SymbolKind::Method
                } else {
                    SymbolKind::Function
                };
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: parent_class.map(|s| s.to_string()),
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
            }
        }

        "field_declaration" | "variable_declarator"
        | "public_field_definition" | "property_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = match name_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: if parent_class.is_some() { SymbolKind::Field } else { SymbolKind::Variable },
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: parent_class.map(|s| s.to_string()),
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
            }
        }

        // ── Call nodes ──
        "method_invocation" | "function_call" | "call_expression" => {
            if let Some(name_node) = node.child_by_field_name("name")
                .or_else(|| node.child_by_field_name("function"))
            {
                let callee = match name_node.utf8_text(source.as_bytes()) {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let start = node.start_position();
                call_edges.push(CallEdge {
                    caller: String::new(), // resolved by context (current function)
                    callee: callee.to_string(),
                    file: file.to_string(),
                    line: start.row + 1,
                });
            }
        }

        _ => {}
    }

    // Recurse into children (unless early-returned for class_declaration)
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            extract_from_node(&child, source, file, parent_class, symbols, call_edges);
        }
    }
}

/// Get a short text snippet from a node for embedding purposes.
fn node_text_snippet(node: &Node, source: &str) -> String {
    let text = node.utf8_text(source.as_bytes()).unwrap_or("");
    // Take first 512 chars — long enough for embedding, short enough to be cheap
    if text.len() > 512 {
        let boundary = text.floor_char_boundary(509);
        format!("{}...", &text[..boundary])
    } else {
        text.to_string()
    }
}
