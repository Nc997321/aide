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
    /// LSP filterText：过滤用文本（可能与 label/insertText 不同，如 label 带修饰后缀）。
    /// 前端拿它给 CM 做前缀过滤，缺省回落 label。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_text: Option<String>,
    /// 原始 CompletionItem（仅当 documentation 缺失且带 data 时附带，语言无关）：
    /// 支持 resolve 的 server（如 jdtls）补全条目常不带文档，客户端须回传完整
    /// item 调 completionItem/resolve 才能拿到文档/签名。前端把它原样传回。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolve_item: Option<serde_json::Value>,
}

/// LSP documentation 字段归一：字符串形态或 {value, kind} MarkupContent 形态 → 纯文本。
pub fn extract_documentation(v: Option<&serde_json::Value>) -> Option<String> {
    match v? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(m) => {
            m.get("value").and_then(|v| v.as_str()).map(|s| s.to_string())
        }
        _ => None,
    }
}

/// textDocument/signatureHelp 结果归一为前端直用的形状（原始 Value 在）：
/// { signatures: [{label, documentation, parameters: [{label, documentation}],
///                 activeParameter}], activeSignature, activeParameter }
/// documentation 归一为纯文本；参数 label 只保留字符串形态（未声明
/// labelOffsetSupport，服务器按 spec 不会发 [start,end] 偏移形态）。
pub fn signature_help_to_view(result: &serde_json::Value) -> serde_json::Value {
    let null = serde_json::Value::Null;
    let Some(sigs) = result.get("signatures").and_then(|v| v.as_array()) else {
        return null;
    };
    let signatures: Vec<serde_json::Value> = sigs
        .iter()
        .map(|s| {
            let parameters = s
                .get("parameters")
                .and_then(|v| v.as_array())
                .map(|params| {
                    params
                        .iter()
                        .map(|p| {
                            serde_json::json!({
                                "label": p.get("label").and_then(|v| v.as_str()).unwrap_or(""),
                                "documentation": extract_documentation(p.get("documentation")),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            serde_json::json!({
                "label": s.get("label").and_then(|v| v.as_str()).unwrap_or(""),
                "documentation": extract_documentation(s.get("documentation")),
                "parameters": parameters,
                "activeParameter": s.get("activeParameter").and_then(|v| v.as_u64()),
            })
        })
        .collect();
    serde_json::json!({
        "signatures": signatures,
        "activeSignature": result.get("activeSignature").and_then(|v| v.as_u64()),
        "activeParameter": result.get("activeParameter").and_then(|v| v.as_u64()),
    })
}

/// 文档符号的扁平条目（documentSymbol 结果归一）。前端据此枚举声明行、按 kind 筛
/// Class/Interface/Method/Function，对可视区内的声明查 implementation 挂 gutter 标记。
/// kind 保留 LSP SymbolKind 原值（前端再映射），不在此裁剪——解析与筛选职责分离。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DocumentSymbolItem {
    pub name: String,
    pub kind: u32,
    /// 1-based 声明行（selectionRange.start.line + 1 / SymbolInformation.location.start.line + 1）
    pub line: usize,
    /// 1-based 声明列
    pub column: usize,
}

/// 某 language server 的可选能力开关（从 initialize 握手 capabilities 提取）。
/// provider 字段在 LSP 里可为 bool 或对象（如 {"workDoneProgress":true}）——按 key 存在性
/// + as_bool 兜底判断：key 在且值为对象 → 视为支持；absent 或显式 false → 不支持。
#[derive(Debug, Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LspCapabilities {
    pub implementation_provider: bool,
    pub document_symbol_provider: bool,
}

impl LspCapabilities {
    /// 从 server capabilities JSON 提取我们关心的开关。
    pub fn from_caps(caps: Option<&serde_json::Value>) -> Self {
        let Some(c) = caps else {
            return Self::default();
        };
        Self {
            implementation_provider: provider_on(c, "implementationProvider"),
            document_symbol_provider: provider_on(c, "documentSymbolProvider"),
        }
    }
}

/// LSP provider 能力判断：true/对象 → 支持；absent/false → 不支持。
fn provider_on(caps: &serde_json::Value, key: &str) -> bool {
    match caps.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(_) => true, // 对象形式（含选项）→ 支持
        None => false,
    }
}

/// LSP Location（无符号名）+ 查询词 + workspace_root → QueryResult。
/// file 归一为相对 workspace_root 的路径（与 codegraph 一致；不在工作区则保留绝对，
/// 前端 jumpToResult 兼容）。confidence=Structure；kind 无从得知 → 占位 Function。
pub fn location_to_query_result(
    loc: &Location,
    queried_word: &str,
    workspace_root: &str,
) -> QueryResult {
    let start = loc.range.start;
    QueryResult {
        symbol: SymbolDef {
            name: queried_word.to_string(),
            kind: SymbolKind::Function, // 占位：LSP Location 不带 SymbolKind
            file: uri_to_rel_path(loc.uri.as_str(), workspace_root),
            line: (start.line + 1) as usize, // LSP 0-based → 1-based
            column: (start.character + 1) as usize,
            parent: None,
            end_line: 0,
        },
        confidence: Confidence::Structure,
        score: None,
        snippet: None,
    }
}

pub fn locations_to_query_results(
    locs: &[Location],
    word: &str,
    workspace_root: &str,
) -> Vec<QueryResult> {
    locs.iter()
        .map(|l| location_to_query_result(l, word, workspace_root))
        .collect()
}

pub fn completion_items_to_cm(items: &[CompletionItem]) -> Vec<CmCompletion> {
    items
        .iter()
        .map(|it| {
            // resolve 载荷：仅当文档缺失且带 data（服务器需要 data 定位 proposal）。
            // 已带文档的条目直接用，省 IPC 体积。
            let resolve_item = if it.documentation.is_none() && it.data.is_some() {
                serde_json::to_value(it).ok()
            } else {
                None
            };
            CmCompletion {
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
                filter_text: it.filter_text.clone(),
                resolve_item,
            }
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

/// 把可能相对的 file_path 解析成绝对 file:// URI：绝对路径直接转，相对路径先
/// join workspace_root。LSP URI 必须绝对，且要与 didOpen 的 URI 对齐才能命中文档——
/// 补全/hover 传绝对路径，定义跳转 useGotoDefinition 传相对 sourceFile，统一在此兜底，
/// 让所有 lsp_* 命令对绝对/相对路径都正确，根除「定义 URI 缺工作区根 → server 找不到
/// 文档 → 返空 → 退回 codegraph」这一 bug。
pub fn resolve_file_uri(workspace_root: &str, file_path: &str) -> String {
    let abs = if std::path::Path::new(file_path).is_absolute() {
        file_path.to_string()
    } else {
        std::path::Path::new(workspace_root)
            .join(file_path)
            .to_string_lossy()
            .into_owned()
    };
    path_to_uri(&abs)
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

/// file:// URI → 相对 workspace_root 的路径（与 codegraph 一致用相对路径）；URI 不在
/// workspace 下则保留绝对路径（前端 jumpToResult 兼容两种形态）。统一正斜杠、大小写
/// 不敏感（Windows 盘符 C:/c: 都能匹配），避免 jumpToResult 拼成 root+绝对（os error 123）。
pub fn uri_to_rel_path(uri: &str, workspace_root: &str) -> String {
    let abs = uri_to_path(uri); // 正斜杠绝对路径
    let root = workspace_root.replace('\\', "/");
    if root.is_empty() {
        return abs;
    }
    let prefix = format!("{}/", root.to_lowercase());
    if abs.to_lowercase().starts_with(&prefix) {
        abs[root.len() + 1..].to_string() // 保留 abs 原始大小写
    } else {
        abs
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
        let qr = location_to_query_result(&loc, "my_fn", "C:/proj");
        assert_eq!(qr.symbol.name, "my_fn");
        assert_eq!(qr.symbol.file, "src/main.rs"); // 相对工作区（与 codegraph 一致）
        assert_eq!(qr.symbol.line, 6); // 1-based
        assert_eq!(qr.symbol.column, 11); // 1-based
        assert_eq!(qr.confidence, Confidence::Structure);
        assert_eq!(qr.score, None);
    }

    #[test]
    fn lsp_capabilities_from_bool_and_object_providers() {
        // bool 形态：true/false 直接取
        let caps =
            serde_json::json!({"implementationProvider": true, "documentSymbolProvider": false});
        let c = LspCapabilities::from_caps(Some(&caps));
        assert!(c.implementation_provider);
        assert!(!c.document_symbol_provider);

        // 对象形态（含 workDoneProgress 等）：key 在即视为支持
        let caps2 = serde_json::json!({
            "implementationProvider": {"workDoneProgress": true},
            "documentSymbolProvider": {"label": "X"}
        });
        let c2 = LspCapabilities::from_caps(Some(&caps2));
        assert!(c2.implementation_provider);
        assert!(c2.document_symbol_provider);

        // 缺失 → 不支持
        let c3 = LspCapabilities::from_caps(Some(&serde_json::json!({})));
        assert!(!c3.implementation_provider);
        assert!(!c3.document_symbol_provider);

        // None（server 未握手）→ 全 false
        let c4 = LspCapabilities::from_caps(None);
        assert!(!c4.implementation_provider);
        assert!(!c4.document_symbol_provider);
    }

    #[test]
    fn uri_to_rel_path_strips_workspace_and_case_insensitive() {
        // 工作区内 → 相对（与 codegraph 一致），正斜杠 + 大小写不敏感（Windows 盘符）
        assert_eq!(
            uri_to_rel_path("file:///C:/proj/src/a.rs", "C:/proj"),
            "src/a.rs"
        );
        assert_eq!(
            uri_to_rel_path("file:///C:/proj/src/a.rs", "c:\\proj"),
            "src/a.rs"
        );
        // 工作区外 → 保留绝对（前端 jumpToResult 兼容）
        assert_eq!(
            uri_to_rel_path("file:///D:/other/x.rs", "C:/proj"),
            "D:/other/x.rs"
        );
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
    fn resolve_file_uri_relative_joins_workspace() {
        // 定义跳转传相对 sourceFile 的兜底路径：join 工作区根 → 绝对 URI，
        // 与 didOpen（绝对路径）的 URI 对齐才能命中文档。Path::is_absolute 平台相关，
        // 故用 cfg 分流 Windows / Unix 路径。
        #[cfg(windows)]
        assert_eq!(
            resolve_file_uri("C:/proj", "src/main.ts"),
            "file:///C:/proj/src/main.ts"
        );
        #[cfg(not(windows))]
        assert_eq!(
            resolve_file_uri("/home/proj", "src/main.ts"),
            "file:///home/proj/src/main.ts"
        );
    }

    #[test]
    fn resolve_file_uri_absolute_unchanged() {
        // 补全/hover 走绝对路径：直接转，不重复 join（绝对路径再 join 会被截断/串接出错）。
        #[cfg(windows)]
        assert_eq!(
            resolve_file_uri("C:/proj", "C:/proj/src/main.rs"),
            "file:///C:/proj/src/main.rs"
        );
        #[cfg(not(windows))]
        assert_eq!(
            resolve_file_uri("/home/proj", "/home/proj/src/main.rs"),
            "file:///home/proj/src/main.rs"
        );
    }

    #[test]
    fn completion_items_map_label_detail_doc() {
        let items = vec![CompletionItem {
            label: "foo".into(),
            detail: Some("fn foo()".into()),
            documentation: Some(lsp_types::Documentation::String("docs".into())),
            kind: Some(lsp_types::CompletionItemKind::FUNCTION),
            insert_text: Some("foo()".into()),
            ..Default::default()
        }];
        let cm = completion_items_to_cm(&items);
        assert_eq!(cm.len(), 1);
        assert_eq!(cm[0].label, "foo");
        assert_eq!(cm[0].detail.as_deref(), Some("fn foo()"));
        assert_eq!(cm[0].documentation.as_deref(), Some("docs"));
        assert!(cm[0].insert_text.as_deref() == Some("foo()"));
        // filter_text 未设 → None（serde skip_serializing_if 不序列化，前端回落 label）
        assert!(cm[0].filter_text.is_none());
    }

    #[test]
    fn completion_items_map_filter_text() {
        // label 是展示名（可能带修饰），filter_text 是过滤名（与 insert_text 对齐）——
        // 前端拿 filter_text 给 CM 做前缀过滤，比拿 label 过滤更准。
        let items = vec![CompletionItem {
            label: "apiService".into(),
            filter_text: Some("apiService".into()),
            insert_text: Some("apiService".into()),
            ..Default::default()
        }];
        let cm = completion_items_to_cm(&items);
        assert_eq!(cm[0].filter_text.as_deref(), Some("apiService"));
    }

    #[test]
    fn completion_items_attach_resolve_item_only_when_undocumented_with_data() {
        // 无文档 + 带 data → 附带原始 item（前端选中时回传调 completionItem/resolve）；
        // 已带文档 → 不附带（省 IPC）；无 data → resolve 无从定位，也不附带。
        let undocumented = CompletionItem {
            label: "foo".into(),
            data: Some(serde_json::json!({"proposalId": 42})),
            ..Default::default()
        };
        let documented = CompletionItem {
            label: "bar".into(),
            documentation: Some(lsp_types::Documentation::String("docs".into())),
            data: Some(serde_json::json!({"proposalId": 7})),
            ..Default::default()
        };
        let no_data = CompletionItem {
            label: "baz".into(),
            ..Default::default()
        };
        let cm = completion_items_to_cm(&[undocumented, documented, no_data]);
        assert_eq!(cm[0].label, "foo");
        let raw = cm[0].resolve_item.as_ref().expect("undocumented+data → raw item");
        assert_eq!(raw["data"]["proposalId"], serde_json::json!(42));
        assert_eq!(raw["label"], serde_json::json!("foo"));
        assert!(cm[1].resolve_item.is_none(), "已带文档不附带 resolve 载荷");
        assert!(cm[2].resolve_item.is_none(), "无 data 不附带 resolve 载荷");
    }

    #[test]
    fn extract_documentation_string_and_markup_forms() {
        assert_eq!(
            extract_documentation(Some(&serde_json::json!("plain doc"))),
            Some("plain doc".into())
        );
        assert_eq!(
            extract_documentation(Some(&serde_json::json!({"value": "md doc", "kind": "markdown"}))),
            Some("md doc".into())
        );
        assert_eq!(extract_documentation(Some(&serde_json::Value::Null)), None);
        assert_eq!(extract_documentation(None), None);
    }

    #[test]
    fn signature_help_to_view_normalizes_shape() {
        let raw = serde_json::json!({
            "signatures": [{
                "label": "foo(int a, String b)",
                "documentation": {"value": "does foo", "kind": "markdown"},
                "parameters": [
                    {"label": "int a"},
                    {"label": "String b", "documentation": "the b"}
                ],
                "activeParameter": 1
            }],
            "activeSignature": 0,
            "activeParameter": 0
        });
        let v = signature_help_to_view(&raw);
        assert_eq!(v["activeSignature"], serde_json::json!(0));
        let sig = &v["signatures"][0];
        assert_eq!(sig["label"], serde_json::json!("foo(int a, String b)"));
        assert_eq!(sig["documentation"], serde_json::json!("does foo"));
        assert_eq!(sig["activeParameter"], serde_json::json!(1));
        assert_eq!(sig["parameters"][1]["documentation"], serde_json::json!("the b"));
    }

    #[test]
    fn signature_help_to_view_null_when_no_signatures() {
        // 无结果（cursor 不在调用内）/server 返空 → Null，前端拿 null 直接不弹层。
        assert!(signature_help_to_view(&serde_json::json!({})).is_null());
        assert!(signature_help_to_view(&serde_json::Value::Null).is_null());
    }
}
