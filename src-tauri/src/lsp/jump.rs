//! 跳转类 LSP 请求的公共零件（definition / references / implementation / agent 查询共用）。
//!
//! 抽出来的理由是**去重而非抽象**：`lsp_definition` / `lsp_references` /
//! `lsp_implementation` 三个命令此前各自内联了同一套「取 server → 组 params →
//! request → 映射 status」；agent 查询是第四个调用方，再复制一份就是第三份拷贝。
//!
//! 拆成三个叶子函数而不是一个「大 run_jump」，是为了每个函数输入 ≤4——
//! 一个吃下 (method, root, file, line, col, word, timeout, includeDeclaration)
//! 的函数有 8 个输入，位置与布尔相邻同型，调用点写反即静默错位。

use crate::codegraph::types::QueryResult;
use crate::lsp::manager::{RequestOutcome, ServerHandle};
use crate::lsp::JumpStatus;
use std::time::Duration;

/// 位置参数（definition / implementation 用）。
///
/// 命令行与前端给的都是 **1-based**，LSP 要 0-based，在这里一次性转换——散在各
/// 调用点转是 off-by-one 的温床。
///
/// **不带 `context`**：`DefinitionParams` / `ImplementationParams` 在协议里没有这个
/// 字段，多塞是偏差（多数 server 会忽略未知字段，但"零行为变化的重构"不该引入偏差）。
pub(crate) fn position_params(uri: &str, line: usize, column: usize) -> serde_json::Value {
    serde_json::json!({
        "textDocument": { "uri": uri },
        "position": {
            "line": (line as u64).saturating_sub(1),
            "character": (column as u64).saturating_sub(1)
        }
    })
}

/// references 专用：`ReferenceParams` 才有 `context.includeDeclaration`。
/// 恒为 `false`（声明本身在"查引用"场景是噪声，前端另有自引用过滤兜底）。
pub(crate) fn references_params(uri: &str, line: usize, column: usize) -> serde_json::Value {
    let mut v = position_params(uri, line, column);
    v["context"] = serde_json::json!({ "includeDeclaration": false });
    v
}

/// 发一次跳转请求。`timeout` 由调用方给（definition/references 用 DEFINITION_TIMEOUT，
/// implementation 历史上用 REQUEST_TIMEOUT，不改）。
pub(crate) async fn issue(
    h: &ServerHandle,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<RequestOutcome, String> {
    h.request(method, params, timeout).await
}

/// agent 视角的结果：**路径保持绝对**。
///
/// 与编辑器视角的差别是真实需求而非口味：模型要拿结果继续调工具（Read、下一次
/// references、@引用），相对路径对它没有意义；而编辑器要相对路径（前端
/// jumpToResult 自己拼 root）。用独立入口表达这个差异，**不靠调用方传空字符串
/// 这种隐式约定**。
pub(crate) fn map_outcome_absolute(
    outcome: RequestOutcome,
    word: &str,
) -> (JumpStatus, Vec<QueryResult>) {
    // 空 root ⇒ uri_to_rel_path 原样返回绝对路径（见 protocol.rs 的 root.is_empty() 分支）。
    map_outcome(outcome, word, "")
}

/// `RequestOutcome` → (status, results)。**这是「空 ≠ 没有」在编辑器侧的落点**：
/// `Ok(空数组)` 是 server 确认无结果，与 Timeout/NotReady/Gone 本质不同——
/// 后者一律返回空 results，但 status 不同，前端据此决定等待还是回退。
pub(crate) fn map_outcome(
    outcome: RequestOutcome,
    word: &str,
    workspace_root: &str,
) -> (JumpStatus, Vec<QueryResult>) {
    match outcome {
        RequestOutcome::Ok(v) => {
            let locs = crate::lsp::parse_locations(&v);
            (
                JumpStatus::Ok,
                crate::lsp::protocol::locations_to_query_results(&locs, word, workspace_root),
            )
        }
        RequestOutcome::Timeout => (JumpStatus::Timeout, vec![]),
        RequestOutcome::NotReady => (JumpStatus::NotReady, vec![]),
        // server 拒答（JSON-RPC error）与「没就绪」同类：**空结果不是证据**。
        // 消费方若要原文（诊断用），在 `jump::issue` 那层就别把它映射掉。
        RequestOutcome::ServerError(_) => (JumpStatus::NotReady, vec![]),
        RequestOutcome::ServerGone => (JumpStatus::Gone, vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_params_converts_to_zero_based() {
        let p = position_params("file:///a.rs", 216, 19);
        assert_eq!(p["position"]["line"], 215, "1-based → 0-based");
        assert_eq!(p["position"]["character"], 18);
    }

    /// `DefinitionParams` 协议里没有 `context`——position_params 不得带它，
    /// 否则是对既有 definition/implementation 请求的隐性改动。
    #[test]
    fn position_params_has_no_context_field() {
        assert!(position_params("file:///a.rs", 1, 1).get("context").is_none());
    }

    /// references 要 `context.includeDeclaration=false`（`ReferenceParams` 才有）。
    #[test]
    fn references_params_carries_include_declaration_false() {
        let p = references_params("file:///a.rs", 216, 19);
        assert_eq!(p["context"]["includeDeclaration"], false);
        assert_eq!(p["position"]["line"], 215, "继承 position_params 的转换");
    }

    /// 0 或异常小的坐标不能下溢成天文数字（saturating_sub 而非裸减法）。
    #[test]
    fn position_params_saturates_at_zero() {
        let p = position_params("file:///a.rs", 0, 0);
        assert_eq!(p["position"]["line"], 0);
        assert_eq!(p["position"]["character"], 0);
    }

    #[test]
    fn map_outcome_ok_empty_is_ok_not_timeout() {
        // 「server 确认无结果」必须保持 Ok——这是编辑器侧与 agent 侧共同的红线。
        let (s, r) = map_outcome(RequestOutcome::Ok(serde_json::json!([])), "w", "/root");
        assert_eq!(s, JumpStatus::Ok);
        assert!(r.is_empty());
    }

    #[test]
    fn map_outcome_failures_carry_status_and_no_results() {
        for (outcome, want) in [
            (RequestOutcome::Timeout, JumpStatus::Timeout),
            (RequestOutcome::NotReady, JumpStatus::NotReady),
            (RequestOutcome::ServerGone, JumpStatus::Gone),
        ] {
            let (s, r) = map_outcome(outcome, "w", "/root");
            assert_eq!(s, want);
            assert!(r.is_empty(), "非 Ok 一律无结果");
        }
    }

    #[test]
    fn map_outcome_parses_locations() {
        let v = serde_json::json!([{
            "uri": "file:///c:/p/a.rs",
            "range": { "start": { "line": 4, "character": 1 }, "end": { "line": 4, "character": 9 } }
        }]);
        let (s, r) = map_outcome(RequestOutcome::Ok(v), "get", "c:/p");
        assert_eq!(s, JumpStatus::Ok);
        assert_eq!(r.len(), 1, "location 应被归一为 QueryResult");
    }
}
