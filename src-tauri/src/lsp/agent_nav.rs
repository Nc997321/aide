//! agent 查询里两个**不是跳转**的工具：`outline`（文件结构）与 `text`（按词的纯文本兜底）。
//!
//! 为什么要它们（2026-09-29 用真实转录量出来的，见 spike README §12）：
//! 自 09-20 起 84 个会话里 aide-lsp 被调用 **1** 次，Grep 229 次、Bash 里的 grep/rg **1438** 次。
//! 模型不是不知道工具在——是**每一发都比 grep 亏**：grep 一发能带多名字、带上下文（`-A 25`）、
//! 从不空等；LSP 一发只回裸坐标，冷窗口还要等 20–60s 换一句「没答上」。
//! 这两个工具补的正是那两处亏空：
//! - `outline`：一个文件的声明结构 + 每个声明的行区间。sidecar 用它给 definition 带上
//!   函数体、给 references 标出「在哪个函数里」——这两样 grep 给不了。
//! - `text`：语义层没答上时的**同一发内兜底**。模型调一次 LSP 工具，最坏也拿到和 Grep
//!   一样的东西（明确标为未验证的文本命中），不再「试过、失望、放弃」。

use crate::lsp::agent_status::AgentLspStatus;
use crate::lsp::manager::{RequestOutcome, ServerHandle};
use crate::lsp::workspace_access::WorkspaceAccess;
use aide_workspace::search::SearchOptions;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 文件结构里的一个声明（深度优先展平，`depth` 还原层级）。行号全部 **1-based**。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OutlineNode {
    pub name: String,
    /// LSP SymbolKind 原值（sidecar 映射成词）。
    pub kind: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 名字所在行（selectionRange）。
    pub line: usize,
    /// 名字所在列。
    pub column: usize,
    /// 整个声明的起止行（range，含函数体）。扁平 SymbolInformation 只有一个 range，两者同源。
    pub start_line: usize,
    pub end_line: usize,
    pub depth: usize,
}

/// documentSymbol 结果 → 展平的结构。两种形状都吃：层级 `DocumentSymbol`（range +
/// selectionRange + children）与扁平 `SymbolInformation`（location.range）。
/// 缺 name / range 的条目跳过（server 实现不一是常态，不该让整份结构失败）。
pub fn parse_outline(value: &Value) -> Vec<OutlineNode> {
    let mut out = Vec::new();
    if let Some(arr) = value.as_array() {
        for item in arr {
            flatten(item, 0, &mut out);
        }
    }
    // 扁平形状不保证顺序（按 kind 分组回来的 server 不少）：按位置排，结构才读得懂。
    out.sort_by_key(|n| (n.start_line, n.line, n.depth));
    out
}

fn flatten(item: &Value, depth: usize, out: &mut Vec<OutlineNode>) {
    let range = item
        .get("range")
        .or_else(|| item.get("location").and_then(|l| l.get("range")));
    let (Some(name), Some(range)) = (item.get("name").and_then(|v| v.as_str()), range) else {
        return;
    };
    let sel = item.get("selectionRange").unwrap_or(range);
    let at = |r: &Value, edge: &str, key: &str| -> usize {
        r.get(edge)
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize
    };
    out.push(OutlineNode {
        name: name.to_string(),
        kind: item.get("kind").and_then(|k| k.as_u64()).unwrap_or(0) as u32,
        detail: item
            .get("detail")
            .and_then(|d| d.as_str())
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string),
        line: at(sel, "start", "line") + 1,
        column: at(sel, "start", "character") + 1,
        start_line: at(range, "start", "line") + 1,
        end_line: at(range, "end", "line") + 1,
        depth,
    });
    if let Some(children) = item.get("children").and_then(|c| c.as_array()) {
        for c in children {
            flatten(c, depth + 1, out);
        }
    }
}

/// 请求一个文件的结构，空则在预算内重试。
///
/// 为什么重试：tsserver 刚 didOpen 的文件，工程还在加载时 documentSymbol 回**空数组**
/// （与 `probe_ready` 同一个现象）。重试到非空或预算耗尽；耗尽仍空 → `indexing`，
/// **不说「这个文件没有声明」**——同一条「空 ≠ 没有」红线。
pub async fn outline(h: &Arc<ServerHandle>, uri: &str, budget: Duration) -> Value {
    let deadline = Instant::now() + budget;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let per_try = left.max(Duration::from_millis(500));
        match h
            .request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": uri } }),
                per_try,
            )
            .await
        {
            Ok(RequestOutcome::Ok(v)) => {
                let nodes = parse_outline(&v);
                if !nodes.is_empty() {
                    return json!({
                        "ok": true,
                        "status": AgentLspStatus::Ready.as_str(),
                        "count": nodes.len(),
                        "symbols": nodes,
                    });
                }
            }
            Ok(RequestOutcome::ServerError(msg)) => {
                return fail(
                    AgentLspStatus::Error,
                    &format!("the language server refused the request: {msg}"),
                )
            }
            Ok(RequestOutcome::ServerGone) => {
                return fail(AgentLspStatus::Gone, "the language server exited")
            }
            Ok(RequestOutcome::Timeout) | Ok(RequestOutcome::NotReady) => {}
            Err(e) => return fail(AgentLspStatus::Error, &e),
        }
        if Instant::now() + RETRY_INTERVAL >= deadline {
            return fail(
                AgentLspStatus::Indexing,
                "the language server returned no structure for this file yet",
            );
        }
        tokio::time::sleep(RETRY_INTERVAL).await;
    }
}

const RETRY_INTERVAL: Duration = Duration::from_millis(700);

/// 一条纯文本命中（路径相对工作区根）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextHit {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

/// 文本兜底的命中上限。进模型上下文的是这一份，太多就是每轮的长期成本。
pub const TEXT_LIMIT: usize = 80;

/// 按**整词、区分大小写**搜一个名字，只看源码文件（`.gitignore` 生效，与编辑器的
/// 「在文件中查找」同一个实现——`aide_workspace::search`，不另写一份）。
///
/// 这是语义层没答上时的兜底：结果**不是**引用，只是出现处（含注释与字符串），
/// sidecar 会原样这么标注。
pub async fn text_search(access: &WorkspaceAccess, workspace_root: &str, name: &str) -> Value {
    if !is_identifier(name) {
        return fail(AgentLspStatus::Error, "text fallback only searches a single identifier");
    }
    let options = SearchOptions {
        use_regex: false,
        case_sensitive: true,
        whole_word: true,
        file_mask: Some(source_mask()),
        limit: Some(TEXT_LIMIT),
    };
    let resp = match access.search(workspace_root, name, options).await {
        Ok(r) => r,
        Err(e) => return fail(AgentLspStatus::Error, &e),
    };
    let hits: Vec<TextHit> = resp
        .files
        .into_iter()
        .flat_map(|g| g.matches)
        .map(|m| TextHit {
            file: m.file,
            line: m.line,
            column: m.column,
            text: clip(m.line_text.trim(), 160),
        })
        .collect();
    json!({
        "ok": true,
        "status": AgentLspStatus::Ready.as_str(),
        "count": hits.len(),
        "truncated": resp.truncated,
        "matches": hits,
    })
}

/// 源码扩展名的掩码：**从 `LanguageId::from_ext` 的定义域推**（测试对账），
/// 不维护第三张扩展名表。
fn source_mask() -> String {
    crate::lsp::detector::KNOWN_SOURCE_EXTS
        .iter()
        .map(|e| format!("*.{e}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// 只接受一个标识符：文本兜底不是通用 grep，给它正则等于把 Grep 再做一遍还做得更差。
pub fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 把一个按名查询的命中挪到**名字本身**上（返回 1-based 行、UTF-16 列 + 1）。
///
/// 为什么必需（2026-09-29 真机复现）：tsserver 的 `workspace/symbol` 给的位置是**整个声明**
/// 的起点——`export async function ensureWorkspaceKnown(…)` 的 `export` 那一格。拿这个
/// 位置去问 references / definition，server 问的是关键字 `export`，回**空数组**；再经就绪
/// 探针认证，就成了「已确认没有引用」——一个存在的符号被宣布不存在。转录里
/// `parseMentionPath`、`run_jump` 被报「确认没有」就是它；模型学到的是「这工具说瞎话」，
/// 它学对了。rust-analyzer 给的是名字位置，照样走这里也无害（第一格就命中）。
///
/// 从命中位置起向后找第一个**整词**出现，最多看 `REFINE_LINES` 行（装饰器、多行签名）。
/// 找不到 → None，调用方保留原位置。
pub fn refine_to_name(text: &str, line: usize, column: usize, name: &str) -> Option<(usize, usize)> {
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    for (i, l) in text.lines().enumerate().skip(line.saturating_sub(1)).take(REFINE_LINES) {
        // 首行从命中列开始找（列是 UTF-16 计数，转回字节偏移）；后续行从头找。
        let from = if i + 1 == line { utf16_to_byte(l, column.saturating_sub(1)) } else { 0 };
        let mut start = from;
        while let Some(off) = l.get(start..).and_then(|rest| rest.find(name)) {
            let at = start + off;
            let end = at + name.len();
            let before_ok = l[..at].chars().next_back().map_or(true, |c| !is_word(c));
            let after_ok = l[end..].chars().next().map_or(true, |c| !is_word(c));
            if before_ok && after_ok {
                return Some((i + 1, l[..at].encode_utf16().count() + 1));
            }
            start = end;
        }
    }
    None
}

const REFINE_LINES: usize = 10;

fn utf16_to_byte(line: &str, units: usize) -> usize {
    let mut seen = 0;
    for (b, c) in line.char_indices() {
        if seen >= units {
            return b;
        }
        seen += c.len_utf16();
    }
    line.len()
}

/// 名字出现在哪些文件里（整词、区分大小写、只看该语言的扩展名），**像声明的排前面**，最多 `max` 个。
///
/// 给按名查询「递文件」用：多工程仓库里（本仓库根 tsconfig 之外还有 `agent-sidecar/` 等独立
/// 工程），只递一个代表文件时，别的工程从不加载，名字在那里的符号永远查不到——实测
/// `resolveLspResult`（在 agent-sidecar）按名 0 命中。先用文本找到候选文件递过去，
/// 它们所在的工程就加载了，语义查询再问一次就答得上。
pub async fn files_mentioning(
    access: &WorkspaceAccess,
    workspace_root: &str,
    name: &str,
    lang: crate::lsp::detector::LanguageId,
    max: usize,
) -> Vec<String> {
    if !is_identifier(name) {
        return vec![];
    }
    let mask = crate::lsp::detector::KNOWN_SOURCE_EXTS
        .iter()
        .filter(|e| crate::lsp::detector::LanguageId::from_ext(e) == Some(lang))
        // 远程的 TS 服务器不挂 Vue 插件：递 `.vue` 过去只换来一条 didOpen 失败，白占一个预热名额。
        .filter(|e| !(access.is_remote() && **e == "vue"))
        .map(|e| format!("*.{e}"))
        .collect::<Vec<_>>()
        .join(",");
    let options = SearchOptions {
        use_regex: false,
        case_sensitive: true,
        whole_word: true,
        file_mask: Some(mask),
        limit: Some(200),
    };
    let Ok(resp) = access.search(workspace_root, name, options).await else {
        return vec![];
    };
    let declares = |t: &str| {
        DECL_WORDS
            .iter()
            .any(|kw| t.contains(&format!("{kw} {name}")))
    };
    let mut files: Vec<(bool, String)> = resp
        .files
        .into_iter()
        .map(|g| {
            let decl = g.matches.iter().any(|m| declares(&m.line_text));
            (decl, g.file)
        })
        .collect();
    files.sort_by_key(|(decl, _)| !*decl);
    files
        .into_iter()
        .take(max)
        .map(|(_, f)| {
            std::path::Path::new(workspace_root)
                .join(f)
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect()
}

/// 「这一行在声明 X」的前缀词（跨语言的粗筛，只影响递文件的先后，不影响结论）。
const DECL_WORDS: [&str; 12] = [
    "fn", "function", "class", "struct", "interface", "type", "enum", "trait", "const", "let",
    "def", "func",
];

fn fail(status: AgentLspStatus, msg: &str) -> Value {
    json!({ "ok": false, "status": status.as_str(), "error": msg })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hierarchical_symbols_flatten_with_depth_and_ranges() {
        let v = json!([{
            "name": "LspManager", "kind": 23, "detail": "struct",
            "range": { "start": {"line": 9, "character": 0}, "end": {"line": 40, "character": 1} },
            "selectionRange": { "start": {"line": 10, "character": 11}, "end": {"line": 10, "character": 21} },
            "children": [{
                "name": "get", "kind": 6,
                "range": { "start": {"line": 20, "character": 4}, "end": {"line": 30, "character": 5} },
                "selectionRange": { "start": {"line": 21, "character": 11}, "end": {"line": 21, "character": 14} }
            }]
        }]);
        let nodes = parse_outline(&v);
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].name, "LspManager");
        assert_eq!((nodes[0].line, nodes[0].start_line, nodes[0].end_line), (11, 10, 41));
        assert_eq!(nodes[0].detail.as_deref(), Some("struct"));
        assert_eq!(nodes[1].depth, 1);
        assert_eq!((nodes[1].line, nodes[1].column, nodes[1].end_line), (22, 12, 31));
    }

    #[test]
    fn flat_symbol_information_is_sorted_by_position() {
        let v = json!([
            { "name": "b", "kind": 12, "location": { "uri": "file:///a.ts",
              "range": { "start": {"line": 50, "character": 0}, "end": {"line": 60, "character": 1} } } },
            { "name": "a", "kind": 12, "location": { "uri": "file:///a.ts",
              "range": { "start": {"line": 5, "character": 0}, "end": {"line": 8, "character": 1} } } }
        ]);
        let nodes = parse_outline(&v);
        assert_eq!(nodes.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!((nodes[0].line, nodes[0].end_line), (6, 9));
    }

    #[test]
    fn malformed_entries_are_skipped_not_fatal() {
        let v = json!([{ "kind": 12 }, { "name": "x" }, null]);
        assert!(parse_outline(&v).is_empty());
        assert!(parse_outline(&json!(null)).is_empty());
    }

    /// tsserver 的真实形状：命中在 `export` 上，名字在后面。挪到名字上，列按 UTF-16 算。
    #[test]
    fn refine_moves_declaration_start_onto_the_name() {
        let src = "// x\nexport async function ensureWorkspaceKnown(id: string) {\n}\n";
        assert_eq!(refine_to_name(src, 2, 1, "ensureWorkspaceKnown"), Some((2, 23)));
        // 已经在名字上（rust-analyzer 的形状）：原地返回
        let rs = "    pub fn run_jump() {}";
        assert_eq!(refine_to_name(rs, 1, 12, "run_jump"), Some((1, 12)));
        // 装饰器 / 注释在前：往下找
        let deco = "@Component()\nexport class FooBar {}";
        assert_eq!(refine_to_name(deco, 1, 1, "FooBar"), Some((2, 14)));
        // 只认整词：`getter` 里的 `get` 不算
        assert_eq!(refine_to_name("fn getter() {} fn get() {}", 1, 1, "get"), Some((1, 19)));
        // 非 ASCII 前缀：列是 UTF-16 计数
        assert_eq!(refine_to_name("/*é*/ fn go() {}", 1, 1, "go"), Some((1, 10)));
        assert_eq!(refine_to_name("nothing here", 1, 1, "zzz"), None);
    }

    #[test]
    fn files_mentioning_puts_declarations_first_and_stays_in_language() {
        let dir = std::env::temp_dir().join(format!("aide-agent-nav-fm-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("a.ts"), "import { useThing } from './b/def';\nuseThing();\n").unwrap();
        std::fs::write(dir.join("b/def.ts"), "export function useThing() {}\n").unwrap();
        std::fs::write(dir.join("c.rs"), "fn useThing() {}\n").unwrap();
        let root = dir.to_string_lossy().replace('\\', "/");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let files = rt.block_on(files_mentioning(
            &WorkspaceAccess::Local,
            &root,
            "useThing",
            crate::lsp::detector::LanguageId::TypeScript,
            3,
        ));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(files.len(), 2, "只看 TS 的扩展名：{files:?}");
        assert!(files[0].ends_with("b/def.ts"), "声明所在的文件排前面：{files:?}");
    }

    #[test]
    fn only_identifiers_reach_the_text_fallback() {
        assert!(is_identifier("run_jump"));
        assert!(is_identifier("$store"));
        assert!(is_identifier("useInlineMention"));
        assert!(!is_identifier("a|b"));
        assert!(!is_identifier("fn foo"));
        assert!(!is_identifier("9lives"));
        assert!(!is_identifier(""));
    }

    #[test]
    fn text_search_finds_whole_words_in_source_files_only() {
        let dir = std::env::temp_dir().join(format!("aide-agent-nav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.rs"), "fn run_jump() {}\nfn run_jumper() {}\n// run_jump\n").unwrap();
        std::fs::write(dir.join("notes.md"), "run_jump appears in docs\n").unwrap();
        let root = dir.to_string_lossy().to_string();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let v = rt.block_on(text_search(&WorkspaceAccess::Local, &root, "run_jump"));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(v["ok"], true, "{v}");
        let files: Vec<&str> = v["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["file"].as_str().unwrap())
            .collect();
        assert_eq!(files, ["a.rs", "a.rs"], "整词（不含 run_jumper）+ 只看源码（不含 .md）：{v}");
        assert_eq!(v["matches"][1]["line"], 3);
    }
}
