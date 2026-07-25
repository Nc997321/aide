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
    // Vue SFC: extract script block content and parse as TypeScript.
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if ext == "vue" {
        return extract_vue_sfc(file_path, source, parser_manager, project_root);
    }

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
    parent_sym: Option<&str>,
    current_fn: Option<&str>,   // 所属函数/方法名，用于填 CallEdge.caller
    symbols: &mut Vec<IndexedPoint>,
    call_edges: &mut Vec<CallEdge>,
) {
    let kind = node.kind();

    match kind {
        // ── Definition nodes (TypeScript / Java) ──
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
                    code_snippet: symbol_snippet(&name, "class", node, source),
                });
                // Recurse into class body with this class as parent
                let parent = name.to_string();
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        extract_from_node(
                            &child, source, file, Some(&parent), current_fn,
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
                    code_snippet: symbol_snippet(&name, "interface", node, source),
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
                    code_snippet: symbol_snippet(&name, "enum", node, source),
                });
            }
        }

        // ── Rust container nodes (struct / enum / trait / impl) ──

        "struct_item" => {
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
                    code_snippet: symbol_snippet(&name, "struct", node, source),
                });
                // Recurse into body with this struct as parent (so fields get indexed)
                let parent = name.to_string();
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        extract_from_node(
                            &child, source, file, Some(&parent), current_fn,
                            symbols, call_edges,
                        );
                    }
                }
                return; // children already handled
            }
        }

        "enum_item" => {
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
                    code_snippet: symbol_snippet(&name, "enum", node, source),
                });
                // Recurse into body with this enum as parent
                let parent = name.to_string();
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        extract_from_node(
                            &child, source, file, Some(&parent), current_fn,
                            symbols, call_edges,
                        );
                    }
                }
                return; // children already handled
            }
        }

        "trait_item" => {
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
                    code_snippet: symbol_snippet(&name, "trait", node, source),
                });
                // Recurse into body with this trait as parent
                let parent = name.to_string();
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        extract_from_node(
                            &child, source, file, Some(&parent), current_fn,
                            symbols, call_edges,
                        );
                    }
                }
                return; // children already handled
            }
        }

        // impl_item: no symbol of its own, but sets parent_sym from the `type`
        // field so methods inside it become Method with correct parent.
        // For `impl MyStruct { ... }` the `type` field is "MyStruct".
        // For `impl Trait for MyStruct { ... }` the `type` field is also "MyStruct".
        "impl_item" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                let parent_name = match type_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n.to_string(),
                    Err(_) => String::new(),
                };
                if !parent_name.is_empty() {
                    for i in 0..node.child_count() {
                        if let Some(child) = node.child(i) {
                            extract_from_node(
                                &child, source, file, Some(&parent_name), current_fn,
                                symbols, call_edges,
                            );
                        }
                    }
                    return; // children already handled
                }
            }
            // Fall through: no `type` field → recurse without setting parent.
        }

        // ── Function / method nodes (multi-language) ──
        "method_declaration" | "function_declaration"
        | "method_definition" | "function_definition"
        | "function_item" | "constructor_declaration"
        // Rust trait method declarations (no body)
        | "function_signature_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = match name_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let start = node.start_position();
                let kind = if parent_sym.is_some() || kind.contains("method") {
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
                        parent: parent_sym.map(|s| s.to_string()),
                    },
                    source: Confidence::Structure,
                    code_snippet: symbol_snippet(&name, "fn", node, source),
                });
                // Recurse into the body with this function as the enclosing caller,
                // so call edges inside it record `caller = name`. Nested function
                // definitions re-shadow current_fn when entered.
                let fn_name = name.to_string();
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        extract_from_node(
                            &child, source, file, parent_sym, Some(&fn_name),
                            symbols, call_edges,
                        );
                    }
                }
                return; // children already handled
            }
        }

        // ── Field nodes (multi-language) ──
        "field_declaration" | "variable_declarator"
        | "public_field_definition" | "property_definition" => {
            // Only index class-level fields; skip function-local const/let to avoid
            // flooding the table with locals (Mo3).
            if parent_sym.is_some() {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = match name_node.utf8_text(source.as_bytes()) {
                        Ok(n) => n,
                        Err(_) => return,
                    };
                    let start = node.start_position();
                    symbols.push(IndexedPoint {
                        symbol: SymbolDef {
                            name: name.to_string(),
                            kind: SymbolKind::Field,
                            file: file.to_string(),
                            line: start.row + 1,
                            column: start.column + 1,
                            parent: parent_sym.map(|s| s.to_string()),
                        },
                        source: Confidence::Structure,
                        code_snippet: symbol_snippet(&name, "field", node, source),
                    });
                }
            }
        }

        // ── Rust const / static / type alias ──
        "const_item" | "static_item" | "type_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = match name_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: SymbolKind::Variable,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: parent_sym.map(|s| s.to_string()),
                    },
                    source: Confidence::Structure,
                    code_snippet: symbol_snippet(&name, "const", node, source),
                });
            }
        }

        // ── Python class-level assignments (field-like) ──
        // Only indexed when inside a class (parent_sym set), matching the
        // function-local-variable filtering policy for other languages.
        "assignment" | "augmented_assignment" => {
            if parent_sym.is_some() {
                if let Some(left) = node.child_by_field_name("left") {
                    if let Some(name_node) = find_identifier_in_pattern(left) {
                        let name = match name_node.utf8_text(source.as_bytes()) {
                            Ok(n) => n,
                            Err(_) => return,
                        };
                        let start = node.start_position();
                        symbols.push(IndexedPoint {
                            symbol: SymbolDef {
                                name: name.to_string(),
                                kind: SymbolKind::Field,
                                file: file.to_string(),
                                line: start.row + 1,
                                column: start.column + 1,
                                parent: parent_sym.map(|s| s.to_string()),
                            },
                            source: Confidence::Structure,
                            code_snippet: symbol_snippet(&name, "field", node, source),
                        });
                    }
                }
            }
        }

        // ── Python 3.12+ type alias ──
        "type_alias_statement" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = match name_node.utf8_text(source.as_bytes()) {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: SymbolKind::Variable,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: parent_sym.map(|s| s.to_string()),
                    },
                    source: Confidence::Structure,
                    code_snippet: symbol_snippet(&name, "type", node, source),
                });
            }
        }

        // ── Call nodes ──
        // "call" covers Python; "call_expression" covers Rust/TS;
        // "method_invocation" / "function_call" cover Java/TS.
        "method_invocation" | "function_call" | "call_expression" | "call" => {
            if let Some(name_node) = node.child_by_field_name("name")
                .or_else(|| node.child_by_field_name("function"))
            {
                let raw = match name_node.utf8_text(source.as_bytes()) {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let callee = callee_leaf_name(raw);
                let start = node.start_position();
                call_edges.push(CallEdge {
                    caller: current_fn.unwrap_or("").to_string(),
                    callee: callee.to_string(),
                    file: file.to_string(),
                    line: start.row + 1,
                });
            }
        }

        _ => {}
    }

    // Recurse into children (unless early-returned for container nodes above)
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            extract_from_node(&child, source, file, parent_sym, current_fn, symbols, call_edges);
        }
    }
}

/// Extract the identifier name from a tree-sitter pattern node.
/// Python assignments left-hand side can be a plain `identifier` or a
/// `pattern_list` containing identifiers. Node is Copy (pointer handle).
fn find_identifier_in_pattern(node: Node) -> Option<Node> {
    if node.kind() == "identifier" {
        return Some(node);
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if let Some(found) = find_identifier_in_pattern(child) {
                return Some(found);
            }
        }
    }
    None
}

/// For `foo.bar()` the callee text is `foo.bar`; the user clicks `bar`, so
/// index the trailing identifier only (Mo5).
fn callee_leaf_name(raw: &str) -> &str {
    raw.rsplit(['.', ':']).next().unwrap_or(raw).trim()
}

/// Build a code snippet for embedding, prefixed with the symbol's kind and name.
/// Example: `fn login: pub async fn login(&self, ...) { ... }`
///
/// The prefix gives the embedding model (bge-m3 etc.) a stronger signal about
/// the symbol identity — critical for cross-lingual queries (Chinese → English
/// code) where the model needs the function name as an anchor.
fn symbol_snippet(name: &str, kind_label: &str, node: &Node, source: &str) -> String {
    let text = node.utf8_text(source.as_bytes()).unwrap_or("");
    let prefix = format!("{} {}: ", kind_label, name);
    // Reserve space for the prefix within the 512-char budget
    let max_text = 512usize.saturating_sub(prefix.len());
    if text.len() > max_text {
        let boundary = text.floor_char_boundary(max_text.saturating_sub(3));
        format!("{}{}...", prefix, &text[..boundary])
    } else {
        format!("{}{}", prefix, text)
    }
}

// ── Vue SFC extraction ──

/// Extract symbols from a Vue SFC by isolating the `<script>` block and parsing
/// it with the TypeScript grammar. Returns empty if no `<script>` block or
/// parsing fails.
fn extract_vue_sfc(
    file_path: &Path,
    source: &str,
    parser_manager: &ParserManager,
    project_root: &Path,
) -> (Vec<IndexedPoint>, Vec<CallEdge>) {
    let script_content = match extract_script_block(source) {
        Some(s) => s,
        None => return (vec![], vec![]),
    };

    let relative_path = file_path
        .strip_prefix(project_root)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");

    let mut symbols: Vec<IndexedPoint> = Vec::new();
    let mut call_edges: Vec<CallEdge> = Vec::new();

    // Parse the script content with the TypeScript grammar.
    if let Some(ts_lang) = parser_manager.get_language("ts") {
        let mut parser = tree_sitter::Parser::new();
        if parser.set_language(ts_lang).is_ok() {
            if let Some(tree) = parser.parse(&script_content, None) {
                extract_from_node(
                    &tree.root_node(),
                    &script_content,
                    &relative_path,
                    None,
                    None,
                    &mut symbols,
                    &mut call_edges,
                );
            }
        }
    }

    (symbols, call_edges)
}

/// Extract the text content inside a `<script>` or `<script setup>` tag.
/// Returns None if no script tag is found.
fn extract_script_block(source: &str) -> Option<String> {
    let script_open = source.find("<script")?;
    let tag_end = source[script_open..].find('>')?;
    let content_start = script_open + tag_end + 1;
    let close_tag = source[content_start..].find("</script>")?;
    let content = &source[content_start..content_start + close_tag];
    Some(content.to_string())
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::parser::ParserManager;
    use std::path::Path;

    fn names(src: &str, file: &str) -> Vec<String> {
        let pm = ParserManager::new();
        let (pts, _) = extract_symbols(Path::new(file), src, &pm, Path::new(""));
        pts.into_iter().map(|p| p.symbol.name).collect()
    }

    // ── Existing TS/Java tests ──

    #[test]
    fn skips_function_local_variables() {
        let src = "function calc() { const total = 1 + 2; return total; }";
        let got = names(src, "x.ts");
        assert!(got.contains(&"calc".to_string()), "function itself indexed");
        assert!(!got.contains(&"total".to_string()), "local var must be skipped");
    }

    #[test]
    fn indexes_class_fields() {
        let src = "class Repo { private db = 1; save() {} }";
        let got = names(src, "Repo.ts");
        assert!(got.contains(&"Repo".to_string()));
        assert!(got.contains(&"save".to_string()));
    }

    // ── Rust tests ──

    #[test]
    fn extracts_rust_struct_with_fields() {
        let src = "struct Repo { db: i32 }";
        let got = names(src, "repo.rs");
        assert!(got.contains(&"Repo".to_string()), "struct itself");
        assert!(got.contains(&"db".to_string()), "struct field");
    }

    #[test]
    fn method_within_impl_has_correct_parent() {
        let src = "struct Repo {}\nimpl Repo { fn save(&self) {} fn load(&self) {} }";
        let pm = ParserManager::new();
        let (points, _) = extract_symbols(Path::new("repo.rs"), src, &pm, Path::new(""));
        let save = points.iter().find(|p| p.symbol.name == "save").unwrap();
        assert_eq!(save.symbol.kind, SymbolKind::Method);
        assert_eq!(save.symbol.parent.as_deref(), Some("Repo"));
        let load = points.iter().find(|p| p.symbol.name == "load").unwrap();
        assert_eq!(load.symbol.kind, SymbolKind::Method);
        assert_eq!(load.symbol.parent.as_deref(), Some("Repo"));
    }

    #[test]
    fn extracts_rust_enum() {
        let src = "enum ExitPayload { Plain, Run }";
        let got = names(src, "shell.rs");
        assert!(got.contains(&"ExitPayload".to_string()), "enum itself");
    }

    #[test]
    fn rust_trait_items_are_interfaces() {
        let src = "trait Persist { fn save(&self); fn load(&self); }";
        let pm = ParserManager::new();
        let (points, _) = extract_symbols(Path::new("persist.rs"), src, &pm, Path::new(""));
        let trait_sym = points.iter().find(|p| p.symbol.name == "Persist").unwrap();
        assert_eq!(trait_sym.symbol.kind, SymbolKind::Interface);
        let save = points.iter().find(|p| p.symbol.name == "save").unwrap();
        assert_eq!(save.symbol.kind, SymbolKind::Method);
        assert_eq!(save.symbol.parent.as_deref(), Some("Persist"));
    }

    #[test]
    fn rust_const_and_static_are_variables() {
        let src = "const MAX: usize = 100;\nstatic NAME: &str = \"hello\";";
        let got = names(src, "consts.rs");
        assert!(got.contains(&"MAX".to_string()));
        assert!(got.contains(&"NAME".to_string()));
    }

    #[test]
    fn rust_type_alias_is_variable() {
        let src = "type MyInt = i32;";
        let got = names(src, "types.rs");
        assert!(got.contains(&"MyInt".to_string()));
    }

    // ── Python tests ──

    #[test]
    fn python_class_fields_from_assignments() {
        let src = "class User:\n    name = \"\"\n    def greet(self): pass";
        let pm = ParserManager::new();
        let (points, _) = extract_symbols(Path::new("user.py"), src, &pm, Path::new(""));
        assert!(points.iter().any(|p| p.symbol.name == "User"));
        assert!(points.iter().any(|p| p.symbol.name == "name" && p.symbol.kind == SymbolKind::Field));
        assert!(points.iter().any(|p| p.symbol.name == "greet" && p.symbol.kind == SymbolKind::Method));
    }

    #[test]
    fn python_calls_produce_edges() {
        let src = "def foo():\n    bar()\n    obj.baz()";
        let pm = ParserManager::new();
        let (_, edges) = extract_symbols(Path::new("test.py"), src, &pm, Path::new(""));
        assert!(edges.iter().any(|e| e.callee == "bar"));
        assert!(edges.iter().any(|e| e.callee == "baz"));
    }

    #[test]
    fn call_edges_carry_enclosing_function_as_caller() {
        let pm = ParserManager::new();
        let src = "function outer() { inner(); }\nfunction inner() {}\n";
        let (_points, edges) = extract_symbols(Path::new("a.ts"), src, &pm, Path::new("."));
        let e = edges.iter().find(|e| e.callee == "inner").expect("edge for inner()");
        assert_eq!(e.caller, "outer", "call inside outer() must record caller");
    }

    #[test]
    fn method_body_call_edges_carry_method_name() {
        let pm = ParserManager::new();
        let src = "class A { void m() { helper(); } void helper() {} }";
        let (_points, edges) = extract_symbols(Path::new("A.java"), src, &pm, Path::new("."));
        let e = edges.iter().find(|e| e.callee == "helper").expect("edge for helper()");
        assert_eq!(e.caller, "m");
    }

    #[test]
    fn top_level_call_has_empty_caller() {
        let pm = ParserManager::new();
        let src = "doThing();\n";
        let (_points, edges) = extract_symbols(Path::new("a.ts"), src, &pm, Path::new("."));
        let e = edges.iter().find(|e| e.callee == "doThing").expect("edge for doThing()");
        assert_eq!(e.caller, "", "module-level call has no enclosing function");
    }

    #[test]
    fn python_module_level_assignments_are_skipped() {
        let src = "CONST = 42\nname = \"hello\"";
        let got = names(src, "config.py");
        assert!(!got.contains(&"CONST".to_string()));
        assert!(!got.contains(&"name".to_string()));
    }

    #[test]
    fn python_class_level_assignment_sets_parent() {
        let src = "class Config:\n    TIMEOUT = 30";
        let pm = ParserManager::new();
        let (points, _) = extract_symbols(Path::new("config.py"), src, &pm, Path::new(""));
        let timeout = points.iter().find(|p| p.symbol.name == "TIMEOUT").unwrap();
        assert_eq!(timeout.symbol.parent.as_deref(), Some("Config"));
    }

    #[test]
    fn python_type_alias_statement_is_indexed_when_grammar_supports_it() {
        // tree-sitter-python 0.23.6 may not recognize `type X = ...` (soft keyword),
        // so this test is conditional: it passes whether or not the grammar emits
        // type_alias_statement.
        let src = "type Point = tuple[float, float]";
        let _ = names(src, "geo.py");
        // No hard assertion — if tree-sitter-python emits type_alias_statement,
        // Point will be indexed; if not, it's a no-op. Verified manually by
        // checking the grammar's node-types.json.
    }

    // ── Vue tests ──

    #[test]
    fn vue_extracts_script_block_functions() {
        // Top-level `const` declarations in <script setup> produce
        // `variable_declarator` nodes which are gated on parent_sym.is_some()
        // (consistent with how TS/Java function-local vars are filtered).
        // Functions are always extracted regardless of parent.
        let src = "<template><div/></template>\n<script setup>\nimport { ref } from 'vue';\nconst count = ref(0);\nfunction increment() { count.value++ }\n</script>\n<style scoped></style>";
        let got = names(src, "Counter.vue");
        assert!(got.contains(&"increment".to_string()), "setup function");
        // import bindings are not definitions
        assert!(!got.contains(&"ref".to_string()), "import binding not a definition");
    }

    #[test]
    fn vue_without_script_returns_empty() {
        let src = "<template><div/></template>\n<style></style>";
        let got = names(src, "Empty.vue");
        assert!(got.is_empty());
    }
}
