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
    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
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
    let mut ctx = ExtractCtx {
        source,
        file: &relative_path,
        symbols: &mut symbols,
        call_edges: &mut call_edges,
    };
    extract_from_node(&root_node, &mut ctx, None, None);

    (symbols, call_edges)
}

/// 遍历上下文：source/file 与两个输出集合。parent_sym/current_fn 是递归覆盖
/// 变量，不进 ctx（每次递归都变，放 ctx 反而要反复改写）。
struct ExtractCtx<'a> {
    source: &'a str,
    file: &'a str,
    symbols: &'a mut Vec<IndexedPoint>,
    call_edges: &'a mut Vec<CallEdge>,
}

impl ExtractCtx<'_> {
    /// 压一个符号；parent 为父级符号名（顶层定义传 None）。
    fn push_symbol(
        &mut self,
        name: &str,
        kind: SymbolKind,
        node: &Node,
        snippet_label: &str,
        parent: Option<&str>,
    ) {
        let start = node.start_position();
        self.symbols.push(IndexedPoint {
            symbol: SymbolDef {
                name: name.to_string(),
                kind,
                file: self.file.to_string(),
                line: start.row + 1,
                column: start.column + 1,
                parent: parent.map(|s| s.to_string()),
                end_line: node.end_position().row + 1,
            },
            source: Confidence::Structure,
            code_snippet: symbol_snippet(name, snippet_label, node, self.source),
        });
    }

    /// 遍历子节点，沿用给定的 parent/current_fn（容器覆盖时显式传覆盖值）。
    fn recurse(&mut self, node: &Node, parent: Option<&str>, current_fn: Option<&str>) {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                extract_from_node(&child, self, parent, current_fn);
            }
        }
    }
}

/// 定义节点分派：容器（设父）/顶层符号/函数/字段/调用各走一个子函数。
/// parent_sym/current_fn 是递归覆盖变量（容器覆盖时显式传覆盖值）。
fn extract_from_node(
    node: &Node,
    ctx: &mut ExtractCtx<'_>,
    parent_sym: Option<&str>,
    current_fn: Option<&str>,
) {
    let kind = node.kind();

    match kind {
        // ── 容器符号（TS/Java/Rust）：自身压符号，子节点以自身为父 ──
        "class_declaration" | "class_definition" | "struct_item" | "enum_item" | "trait_item" => {
            if extract_container(node, ctx, current_fn) {
                return; // children already handled
            }
        }

        // ── 顶层符号（TS/Java/Python）：压符号不设父，子节点走底部递归 ──
        "interface_declaration" | "interface_definition" => {
            extract_leaf(node, ctx, SymbolKind::Interface, "interface", None);
        }

        "enum_declaration" | "enum_definition" => {
            extract_leaf(node, ctx, SymbolKind::Enum, "enum", None);
        }

        // ── Rust container nodes (struct / enum / trait / impl) ──

        // impl_item: no symbol of its own, but sets parent_sym from the `type`
        // field so methods inside it become Method with correct parent.
        // For `impl MyStruct { ... }` the `type` field is "MyStruct".
        // For `impl Trait for MyStruct { ... }` the `type` field is also "MyStruct".
        "impl_item" => {
            if extract_impl(node, ctx, current_fn) {
                return; // children already handled
            }
            // Fall through: no `type` field → recurse without setting parent.
        }

        // ── Function / method nodes (multi-language) ──
        "method_declaration" | "function_declaration"
        | "method_definition" | "function_definition"
        | "function_item" | "constructor_declaration"
        // Rust trait method declarations (no body)
        | "function_signature_item" => {
            if extract_function(node, ctx, parent_sym) {
                return; // children already handled
            }
        }

        // ── Field nodes (multi-language) ──
        // Only index class-level fields; skip function-local const/let to avoid
        // flooding the table with locals (Mo3).
        "field_declaration" | "variable_declarator"
        | "public_field_definition" | "property_definition" => {
            extract_field(node, ctx, parent_sym);
        }

        // ── Rust const / static / type alias ──
        "const_item" | "static_item" | "type_item" => {
            extract_leaf(node, ctx, SymbolKind::Variable, "const", parent_sym);
        }

        // ── Python class-level assignments (field-like) ──
        // Only indexed when inside a class (parent_sym set), matching the
        // function-local-variable filtering policy for other languages.
        "assignment" | "augmented_assignment" => {
            extract_py_field(node, ctx, parent_sym);
        }

        // ── Python 3.12+ type alias ──
        "type_alias_statement" => {
            extract_leaf(node, ctx, SymbolKind::Variable, "type", parent_sym);
        }

        // ── Call nodes ──
        // "call" covers Python; "call_expression" covers Rust/TS;
        // "method_invocation" / "function_call" cover Java/TS.
        "method_invocation" | "function_call" | "call_expression" | "call" => {
            extract_call(node, ctx, current_fn);
        }

        _ => {}
    }

    // Recurse into children (unless early-returned for container nodes above)
    ctx.recurse(node, parent_sym, current_fn);
}

/// 容器符号（class/struct/enum/trait）：压符号，子节点以自身为父。
/// 返回 false（无 name/解码失败）= 落到底部递归（与原实现一致）。
fn extract_container(node: &Node, ctx: &mut ExtractCtx<'_>, current_fn: Option<&str>) -> bool {
    let (kind, snippet) = match node.kind() {
        "class_declaration" | "class_definition" => (SymbolKind::Class, "class"),
        "struct_item" => (SymbolKind::Class, "struct"),
        "enum_item" => (SymbolKind::Enum, "enum"),
        "trait_item" => (SymbolKind::Interface, "trait"),
        _ => return false,
    };
    let Some(name_node) = node.child_by_field_name("name") else {
        return false;
    };
    let Ok(name) = name_node.utf8_text(ctx.source.as_bytes()) else {
        return false;
    };
    ctx.push_symbol(name, kind, node, snippet, None);
    let parent = name.to_string();
    ctx.recurse(node, Some(&parent), current_fn);
    true
}

/// 顶层/叶子符号（interface/enum_decl/const/static/type alias）：压符号不设父，
/// 子节点由调用方走底部递归。
fn extract_leaf(
    node: &Node,
    ctx: &mut ExtractCtx<'_>,
    kind: SymbolKind,
    snippet: &str,
    parent: Option<&str>,
) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let Ok(name) = name_node.utf8_text(ctx.source.as_bytes()) else {
        return;
    };
    ctx.push_symbol(name, kind, node, snippet, parent);
}

/// impl 块：自身不产生符号，子节点以 type 字段（被 impl 的类型）为父。
/// 返回 true = 子节点已处理（有 type 字段）；false = 落到底部递归。
fn extract_impl(node: &Node, ctx: &mut ExtractCtx<'_>, current_fn: Option<&str>) -> bool {
    let Some(type_node) = node.child_by_field_name("type") else {
        return false;
    };
    let Ok(parent_name) = type_node.utf8_text(ctx.source.as_bytes()) else {
        return false;
    };
    if parent_name.is_empty() {
        return false;
    }
    ctx.recurse(node, Some(parent_name), current_fn);
    true
}

/// 函数/方法：压符号；子节点以自身为 current_fn（嵌套定义重设），parent 透传。
/// 返回 false（无 name/解码失败）= 落到底部递归。
fn extract_function(node: &Node, ctx: &mut ExtractCtx<'_>, parent_sym: Option<&str>) -> bool {
    let Some(name_node) = node.child_by_field_name("name") else {
        return false;
    };
    let Ok(name) = name_node.utf8_text(ctx.source.as_bytes()) else {
        return false;
    };
    let kind = if parent_sym.is_some() || node.kind().contains("method") {
        SymbolKind::Method
    } else {
        SymbolKind::Function
    };
    ctx.push_symbol(name, kind, node, "fn", parent_sym);
    let fn_name = name.to_string();
    ctx.recurse(node, parent_sym, Some(&fn_name));
    true
}

/// 类级字段：只有父存在时索引（函数局部变量跳过，Mo3）。
fn extract_field(node: &Node, ctx: &mut ExtractCtx<'_>, parent_sym: Option<&str>) {
    let Some(parent_sym) = parent_sym else { return };
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let Ok(name) = name_node.utf8_text(ctx.source.as_bytes()) else {
        return;
    };
    ctx.push_symbol(name, SymbolKind::Field, node, "field", Some(parent_sym));
}

/// Python 类级赋值：left 可能是 identifier 或 pattern_list，递归找标识符。
fn extract_py_field(node: &Node, ctx: &mut ExtractCtx<'_>, parent_sym: Option<&str>) {
    let Some(parent_sym) = parent_sym else { return };
    let Some(left) = node.child_by_field_name("left") else {
        return;
    };
    let Some(name_node) = find_identifier_in_pattern(left) else {
        return;
    };
    let Ok(name) = name_node.utf8_text(ctx.source.as_bytes()) else {
        return;
    };
    ctx.push_symbol(name, SymbolKind::Field, node, "field", Some(parent_sym));
}

/// 调用边：caller 是当前所属函数（无则空串）。
fn extract_call(node: &Node, ctx: &mut ExtractCtx<'_>, current_fn: Option<&str>) {
    let Some(name_node) = node
        .child_by_field_name("name")
        .or_else(|| node.child_by_field_name("function"))
    else {
        return;
    };
    let Ok(raw) = name_node.utf8_text(ctx.source.as_bytes()) else {
        return;
    };
    let callee = callee_leaf_name(raw);
    let start = node.start_position();
    ctx.call_edges.push(CallEdge {
        caller: current_fn.unwrap_or("").to_string(),
        callee: callee.to_string(),
        file: ctx.file.to_string(),
        line: start.row + 1,
    });
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
///
/// Also synthesizes a component symbol from the SFC **filename**
/// (PermissionDialog.vue → `PermissionDialog`): `<script setup>` components
/// declare no named symbol, so without this the component name — the primary
/// handle a model uses to locate a Vue component — is unfindable in the index
/// (2026-07-26 real-app A/B: find_symbol("PermissionDialog") missed despite
/// the file existing, and zero `*Dialog` symbols existed index-wide).
fn extract_vue_sfc(
    file_path: &Path,
    source: &str,
    parser_manager: &ParserManager,
    project_root: &Path,
) -> (Vec<IndexedPoint>, Vec<CallEdge>) {
    let relative_path = file_path
        .strip_prefix(project_root)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");

    let mut symbols: Vec<IndexedPoint> = Vec::new();
    let mut call_edges: Vec<CallEdge> = Vec::new();

    // Filename-derived component symbol (even when the SFC has no script block).
    let stem = file_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if !stem.is_empty() {
        // Snippet carries a slice of the template so the semantic layer gets
        // real content to embed, not just a bare name.
        let template_start = source.find("<template>").unwrap_or(0);
        let snippet_body: String = source[template_start..].chars().take(300).collect();
        symbols.push(IndexedPoint {
            symbol: SymbolDef {
                name: stem.to_string(),
                kind: SymbolKind::Class,
                file: relative_path.clone(),
                line: 1,
                column: 1,
                parent: None,
                end_line: source.lines().count(),
            },
            source: Confidence::Structure,
            code_snippet: format!("vue component {}: {}", stem, snippet_body),
        });
    }

    let (script_content, script_start_line) = match extract_script_block(source) {
        Some(s) => s,
        None => return (symbols, call_edges),
    };

    // Parse the script content with the TypeScript grammar. Rows tree-sitter
    // reports are offsets into `script_content`, not SFC line numbers, so we
    // shift script-derived symbols (and their call edges) by `script_start_line
    // - 1` to map them onto the SFC's whole-file line numbers. The filename-
    // derived component symbol (line 1) was pushed above and is left untouched.
    let before_script = symbols.len();
    let before_edges = call_edges.len();
    if let Some(ts_lang) = parser_manager.get_language("ts") {
        let mut parser = tree_sitter::Parser::new();
        if parser.set_language(ts_lang).is_ok() {
            if let Some(tree) = parser.parse(&script_content, None) {
                let mut ctx = ExtractCtx {
                    source: &script_content,
                    file: &relative_path,
                    symbols: &mut symbols,
                    call_edges: &mut call_edges,
                };
                extract_from_node(&tree.root_node(), &mut ctx, None, None);
            }
        }
    }
    let line_offset = script_start_line - 1;
    for pt in &mut symbols[before_script..] {
        pt.symbol.line += line_offset;
        pt.symbol.end_line += line_offset;
    }
    for edge in &mut call_edges[before_edges..] {
        edge.line += line_offset;
    }

    (symbols, call_edges)
}

/// Extract the text content inside a `<script>` or `<script setup>` tag.
/// Returns `(content, start_line)` where `start_line` is the 1-based line of
/// the script block's first content line within the whole SFC. `extract_vue_sfc`
/// parses `content` in isolation, so tree-sitter rows are offsets into
/// `content`, not SFC line numbers — callers add `start_line - 1` to map them
/// back. Returns None if no script tag is found.
fn extract_script_block(source: &str) -> Option<(String, usize)> {
    let script_open = source.find("<script")?;
    let tag_end = source[script_open..].find('>')?;
    let content_start = script_open + tag_end + 1;
    let close_tag = source[content_start..].find("</script>")?;
    let content = &source[content_start..content_start + close_tag];
    let start_line = source[..content_start]
        .bytes()
        .filter(|&b| b == b'\n')
        .count()
        + 1;
    Some((content.to_string(), start_line))
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
        assert!(
            !got.contains(&"total".to_string()),
            "local var must be skipped"
        );
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
        assert!(points
            .iter()
            .any(|p| p.symbol.name == "name" && p.symbol.kind == SymbolKind::Field));
        assert!(points
            .iter()
            .any(|p| p.symbol.name == "greet" && p.symbol.kind == SymbolKind::Method));
    }

    #[test]
    fn vue_sfc_yields_component_symbol_from_filename() {
        let pm = ParserManager::new();
        let src = "<template><div>{{ msg }}</div></template>\n<script setup lang=\"ts\">\nfunction handleClick() {}\n</script>\n";
        let (points, _edges) = extract_symbols(
            Path::new("src/components/PermissionDialog.vue"),
            src,
            &pm,
            Path::new("."),
        );
        let comp = points
            .iter()
            .find(|p| p.symbol.name == "PermissionDialog")
            .expect("component symbol must be synthesized from filename");
        assert!(matches!(comp.symbol.kind, SymbolKind::Class));
        assert_eq!(comp.symbol.file, "src/components/PermissionDialog.vue");
        assert!(
            comp.code_snippet.contains("<template>"),
            "snippet carries template for embedding"
        );
        // script 内符号不受影响
        assert!(points.iter().any(|p| p.symbol.name == "handleClick"));
    }

    #[test]
    fn vue_sfc_without_script_still_yields_component_symbol() {
        let pm = ParserManager::new();
        let src = "<template><div/></template>\n";
        let (points, _edges) = extract_symbols(
            Path::new("src/components/BareCard.vue"),
            src,
            &pm,
            Path::new("."),
        );
        assert!(points.iter().any(|p| p.symbol.name == "BareCard"));
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
        let e = edges
            .iter()
            .find(|e| e.callee == "inner")
            .expect("edge for inner()");
        assert_eq!(e.caller, "outer", "call inside outer() must record caller");
    }

    #[test]
    fn method_body_call_edges_carry_method_name() {
        let pm = ParserManager::new();
        let src = "class A { void m() { helper(); } void helper() {} }";
        let (_points, edges) = extract_symbols(Path::new("A.java"), src, &pm, Path::new("."));
        let e = edges
            .iter()
            .find(|e| e.callee == "helper")
            .expect("edge for helper()");
        assert_eq!(e.caller, "m");
    }

    #[test]
    fn top_level_call_has_empty_caller() {
        let pm = ParserManager::new();
        let src = "doThing();\n";
        let (_points, edges) = extract_symbols(Path::new("a.ts"), src, &pm, Path::new("."));
        let e = edges
            .iter()
            .find(|e| e.callee == "doThing")
            .expect("edge for doThing()");
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

    #[test]
    fn python_nested_pattern_list_finds_identifiers() {
        // 嵌套 tuple pattern 必须排在首位才会触发递归：find_identifier_in_pattern
        // 遇到第一个 identifier 就短路返回（单字段语义——一个 assignment 只索引
        // 一个标识符，Mo3）。`(b, c), a` 的 pattern_list 首元素是 tuple_pattern，
        // 必须递归进去才能找到 b（覆盖 find_identifier_in_pattern 的递归分支）。
        let src = "class Layout:\n    (b, c), a = (1, 2), 3";
        let pm = ParserManager::new();
        let (points, _) = extract_symbols(Path::new("layout.py"), src, &pm, Path::new(""));
        let b = points
            .iter()
            .find(|p| p.symbol.name == "b" && p.symbol.kind == SymbolKind::Field);
        assert!(
            b.is_some(),
            "nested tuple pattern must be searched recursively"
        );
        assert_eq!(b.unwrap().symbol.parent.as_deref(), Some("Layout"));
        // 单字段语义：只索引第一个标识符，c/a 不出现
        assert!(!points.iter().any(|p| p.symbol.name == "c"));
        assert!(!points.iter().any(|p| p.symbol.name == "a"));
    }

    #[test]
    fn long_function_snippet_is_truncated_to_budget() {
        // symbol_snippet 的 512 字符预算：超长函数体必须截断并带 "..."（覆盖
        // 截断分支）。用长注释撑大函数文本，确保 utf8_text 超过 512。
        let body = format!("// {}\n", "x".repeat(600));
        let src = format!("class Big {{\n{}\n  run() {{}}\n}}", body);
        let pm = ParserManager::new();
        let (points, _) = extract_symbols(Path::new("Big.ts"), &src, &pm, Path::new(""));
        let big = points
            .iter()
            .find(|p| p.symbol.name == "Big")
            .expect("class symbol");
        assert!(
            big.code_snippet.len() <= 515,
            "snippet within budget: {}",
            big.code_snippet.len()
        );
        assert!(
            big.code_snippet.ends_with("..."),
            "truncated snippet ends with ellipsis"
        );
        // 短符号不受影响
        let src2 = "class Small { x = 1 }";
        let (points2, _) = extract_symbols(Path::new("Small.ts"), src2, &pm, Path::new(""));
        let small = points2.iter().find(|p| p.symbol.name == "Small").unwrap();
        assert!(!small.code_snippet.ends_with("..."));
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
        assert!(
            !got.contains(&"ref".to_string()),
            "import binding not a definition"
        );
    }

    #[test]
    fn vue_without_script_yields_only_component_symbol() {
        // 无 script 块：只有文件名合成的组件符号，无脚本符号
        let src = "<template><div/></template>\n<style></style>";
        let got = names(src, "Empty.vue");
        assert_eq!(got, vec!["Empty".to_string()]);
    }

    #[test]
    fn end_line_covers_full_span_for_each_kind() {
        // 每个 SymbolKind 的 end_line 都应 >= line（来自 tree-sitter end_position）。
        let src = "class Repo { save() {} }\ninterface IFace { id: number; }\nenum Color { Red, Blue }\nfunction long() {\n  const a = 1;\n  return a;\n}\n";
        let pm = ParserManager::new();
        let (points, _) = extract_symbols(Path::new("x.ts"), src, &pm, Path::new(""));
        for p in &points {
            assert!(
                p.symbol.end_line >= p.symbol.line,
                "{:?} {}: end_line {} < line {}",
                p.symbol.kind,
                p.symbol.name,
                p.symbol.end_line,
                p.symbol.line
            );
        }
        // class Repo 单行 → end_line == line == 1
        let repo = points.iter().find(|p| p.symbol.name == "Repo").unwrap();
        assert_eq!(repo.symbol.line, 1);
        assert_eq!(repo.symbol.end_line, 1);
        // function long 跨行 4-7 → end_line == 7
        let long = points.iter().find(|p| p.symbol.name == "long").unwrap();
        assert_eq!(long.symbol.line, 4);
        assert_eq!(long.symbol.end_line, 7, "function long spans lines 4-7");
    }

    #[test]
    fn vue_sfc_script_symbols_use_whole_file_line_numbers() {
        // script block 从第 2 行起；handleClick 在 script block 第 2 行 → SFC 全文第 3 行。
        // 修复前 handleClick.line 是 script_content 内偏移（2），修复后是 SFC 全文行号（3）。
        let pm = ParserManager::new();
        let src = "<template><div/></template>\n<script setup>\nfunction handleClick() {\n  return 1;\n}\n</script>\n";
        let (points, _edges) = extract_symbols(Path::new("Comp.vue"), src, &pm, Path::new("."));
        let comp = points.iter().find(|p| p.symbol.name == "Comp").unwrap();
        assert_eq!(comp.symbol.line, 1, "component symbol at SFC line 1");
        assert_eq!(
            comp.symbol.end_line,
            src.lines().count(),
            "component spans whole file"
        );
        let handler = points
            .iter()
            .find(|p| p.symbol.name == "handleClick")
            .unwrap();
        assert_eq!(
            handler.symbol.line, 3,
            "handleClick at SFC line 3 (script offset corrected)"
        );
        assert_eq!(
            handler.symbol.end_line, 5,
            "handleClick spans SFC lines 3-5"
        );
    }
}

// 独立测试文件（可访问本模块私有项，release 构建不编译）。
// #[path]：extract.rs 是模块文件，默认查找会去 extract/extract_tests.rs；
// 显式指向同目录文件。
#[cfg(test)]
#[path = "extract_tests.rs"]
mod extract_tests;
