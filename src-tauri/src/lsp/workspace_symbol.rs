//! `workspace/symbol`：按名字在整个工作区找符号。
//!
//! 编辑器此前只暴露了文件内符号（`lsp_document_symbol`），而 agent 的入口
//! 恰恰是名字——这是 agent 语义查询唯一需要新增的 LSP 方法。

use crate::lsp::protocol::uri_to_path;
use crate::lsp::{JumpStatus, LspState};
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct SymbolCandidate {
    pub name: String,
    pub kind: u32,
    /// **绝对路径**（正斜杠）。agent 后续要用它查 references，所以不做相对化。
    pub file_path: String,
    pub line: usize,
    pub column: usize,
    /// 候选来自哪种语言——缺省 lang 查询时是多语言合并的结果，必须标明来源。
    pub lang: String,
}

#[derive(Debug, Serialize)]
pub struct LspSymbolSearchResult {
    pub status: JumpStatus,
    pub candidates: Vec<SymbolCandidate>,
}

/// 解析 `workspace/symbol` 的返回。两种形状都吃：扁平 `SymbolInformation`
/// （带 `location`）与 `WorkspaceSymbol`。缺 name / location / range 的条目跳过
/// ——server 实现不一致是常态（有的只给 uri 不给 range），不该让整条查询失败。
///
/// 不带 `workspace_root`：`location.uri` 是绝对 URI，转本机路径用不着工作区根
/// （带进来会是个不产生行为的死参数）。
pub fn parse_workspace_symbols(value: &serde_json::Value, lang: &str) -> Vec<SymbolCandidate> {
    let Some(arr) = value.as_array() else {
        return vec![];
    };
    arr.iter()
        .filter_map(|it| {
            let name = it.get("name")?.as_str()?.to_string();
            let loc = it.get("location")?;
            let uri = loc.get("uri")?.as_str()?;
            let start = loc.get("range")?.get("start")?;
            let line = start.get("line")?.as_u64()? as usize + 1;
            let column = start.get("character")?.as_u64()? as usize + 1;
            Some(SymbolCandidate {
                name,
                kind: it.get("kind").and_then(|k| k.as_u64()).unwrap_or(0) as u32,
                file_path: uri_to_path(uri),
                line,
                column,
                lang: lang.to_string(),
            })
        })
        .collect()
}

/// 按名字在工作区找符号。
///
/// `lang` 给了就只查该语言；缺省时对该工作区 `detect_languages` 探到的**全部**语言
/// 依次查询并合并——agent 只拿得到一个名字，没有扩展名可据以分派（`lang_from_ext_of`
/// 在此不适用），逼它先猜语言等于把一个问题变成两个。
#[tauri::command]
pub async fn lsp_workspace_symbol(
    workspace_root: String,
    query: String,
    lang: Option<String>,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<LspSymbolSearchResult, String> {
    let lang_ids = resolve_query_languages(&lang, &workspace_root);
    let mgr = state.0.lock().await;
    let mut candidates = Vec::new();
    // 一个语言都没答上（server 都没起来）时保持 NotReady——**空候选 + NotReady**
    // 与「server 答了但确实没有」是可区分的两件事，这条区分就是本设计的全部意义。
    let mut status = JumpStatus::NotReady;
    for lang_id in lang_ids {
        let Some(h) = mgr.get(&workspace_root, lang_id).await else {
            continue;
        };
        let params = serde_json::json!({ "query": query });
        let outcome = h
            .request(
                "workspace/symbol",
                params,
                crate::lsp::manager::DEFINITION_TIMEOUT,
            )
            .await?;
        match outcome {
            crate::lsp::manager::RequestOutcome::Ok(v) => {
                status = JumpStatus::Ok;
                candidates.extend(parse_workspace_symbols(&v, lang_id.id_str()));
            }
            crate::lsp::manager::RequestOutcome::Timeout => status = JumpStatus::Timeout,
            crate::lsp::manager::RequestOutcome::NotReady => status = JumpStatus::NotReady,
            // server 拒答（如 tsserver 未加载工程时的 `No Project.`）：**不是「没有候选」**。
            crate::lsp::manager::RequestOutcome::ServerError(_) => status = JumpStatus::NotReady,
            crate::lsp::manager::RequestOutcome::ServerGone => status = JumpStatus::Gone,
        }
    }
    Ok(LspSymbolSearchResult { status, candidates })
}

/// `lang` 显式给了就只查它（认不出的语言 → 空列表，即「什么都不查」）；
/// 缺省时探该工作区的全部语言。
fn resolve_query_languages(
    lang: &Option<String>,
    workspace_root: &str,
) -> Vec<crate::lsp::detector::LanguageId> {
    match lang {
        Some(l) => crate::lsp::detector::lang_from_id_str(l).into_iter().collect(),
        None => crate::lsp::detector::detect_languages(std::path::Path::new(workspace_root)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// LSP `SymbolInformation`（扁平、带 location）与 `WorkspaceSymbol`（带 containerName）
    /// 两种形状都要能吃下——各 server 返回不同。
    #[test]
    fn parses_flat_symbol_information() {
        let v = json!([{
            "name": "LspManager",
            "kind": 5,
            "location": { "uri": "file:///c:/proj/src/a.rs",
                          "range": { "start": { "line": 111, "character": 11 } } }
        }]);
        let out = parse_workspace_symbols(&v, "rust");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "LspManager");
        // 走 protocol::uri_to_path：Windows 盘符形态保留 "c:/..."，不加前导斜杠。
        assert_eq!(out[0].file_path, "c:/proj/src/a.rs");
        assert_eq!(out[0].line, 112, "LSP 0-based → 1-based");
        assert_eq!(out[0].column, 12);
        assert_eq!(out[0].lang, "rust");
    }

    #[test]
    fn parses_workspace_symbol_with_container() {
        let v = json!([{
            "name": "get", "kind": 6, "containerName": "LspManager",
            "location": { "uri": "file:///c:/proj/src/lsp/manager.rs",
                          "range": { "start": { "line": 215, "character": 17 } } }
        }]);
        let out = parse_workspace_symbols(&v, "rust");
        assert_eq!(out[0].name, "get");
        assert_eq!(out[0].line, 216);
    }

    /// 空结果 = 空候选，**不是错误**；调用方据 status==Ok 判定「可信的没有」。
    #[test]
    fn empty_result_is_ok_with_no_candidates() {
        assert!(parse_workspace_symbols(&json!([]), "rust").is_empty());
    }

    /// 缺 location 的条目跳过而非 panic——`SymbolInformation` 与 `WorkspaceSymbol`
    /// 的差异之一是后者可能只带 uri 不带 range（server 实现不一致）。
    #[test]
    fn malformed_entries_are_skipped_not_panicking() {
        let v = json!([
            {"name":"ok","kind":1,"location":{"uri":"file:///c:/p/a.rs",
             "range":{"start":{"line":0,"character":0}}}},
            {"name":"no_location"},
            {"location":{"uri":"file:///c:/p/b.rs","range":{"start":{"line":1,"character":1}}}},
            {"name":"no_range","location":{"uri":"file:///c:/p/c.rs"}}
        ]);
        let out = parse_workspace_symbols(&v, "rust");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "ok");
    }

    /// 非数组输入（server 返回 null / 对象）不 panic。
    #[test]
    fn non_array_input_yields_empty() {
        assert!(parse_workspace_symbols(&json!(null), "rust").is_empty());
        assert!(parse_workspace_symbols(&json!({"nope": 1}), "rust").is_empty());
    }
}
