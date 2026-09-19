//! agent 视角的 LSP 状态词——工具返回文案的键，也是「空 ≠ 没有」红线的落点。
//!
//! 与 `EnsureOutcome` 的映射是本模块唯一职责：`ok`/`ready` 两个布尔 +
//! `kind` 字符串的组合语义在这里收口，别散到调用点。

use crate::lsp::EnsureOutcome;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLspStatus {
    /// 可服务，结果可信（空结果 = 可信的「没有」）。
    Ready,
    /// 进程在、索引未完成。**空结果不代表没有**。
    Indexing,
    /// 按名字没找到符号（查询本身成功）。
    ///
    /// **目前没有产出点**：按名查询已不再给「确认没有」（证明不了符号索引覆盖整个工作区，
    /// 见 `agent_query::SymbolLookup::Unverified`）。词表是两侧冻结的契约，别删——
    /// 等哪天找到「工程已加载」的正向信号，这个状态词要原样接回来。
    NoSymbol,
    /// 该语言未配置/未安装 server。
    NoServer,
    /// 工作区未信任，拒拉 server。
    Untrusted,
    Timeout,
    Gone,
    Error,
}

impl AgentLspStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Indexing => "indexing",
            Self::NoSymbol => "no_symbol",
            Self::NoServer => "no_server",
            Self::Untrusted => "untrusted",
            Self::Timeout => "timeout",
            Self::Gone => "gone",
            Self::Error => "error",
        }
    }

    /// `EnsureOutcome` → 状态词。注意 `ok=true, ready=false`（Java 索引期）
    /// 是 indexing，**不是** ready——这正是内置 LSP 工具缺失的那层区分。
    ///
    /// 更要紧的是反向的陷阱：`ok=true, ready=true` 对 rust-analyzer 并**不**意味着
    /// 索引已可用（见 `EnsureOutcome.ready` 的注释：其余语言握手成功即 true）。
    /// 所以调用方拿到 `Ready` 后仍应过一遍 `agent_readiness::await_ready` 探测。
    pub fn from_ensure(o: &EnsureOutcome) -> Self {
        if o.ok {
            return if o.ready { Self::Ready } else { Self::Indexing };
        }
        match o.kind {
            Some("server_not_found") => Self::NoServer,
            Some("untrusted") => Self::Untrusted,
            _ => Self::Error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::EnsureOutcome;

    fn ensure(ok: bool, ready: bool, kind: Option<&'static str>) -> EnsureOutcome {
        EnsureOutcome {
            ok,
            ready,
            kind,
            error: None,
        }
    }

    #[test]
    fn status_words_are_frozen() {
        // 这八个词是 C1b 文案表的键，改一个就得同步改 sidecar。
        assert_eq!(AgentLspStatus::Ready.as_str(), "ready");
        assert_eq!(AgentLspStatus::Indexing.as_str(), "indexing");
        assert_eq!(AgentLspStatus::NoSymbol.as_str(), "no_symbol");
        assert_eq!(AgentLspStatus::NoServer.as_str(), "no_server");
        assert_eq!(AgentLspStatus::Untrusted.as_str(), "untrusted");
        assert_eq!(AgentLspStatus::Timeout.as_str(), "timeout");
        assert_eq!(AgentLspStatus::Gone.as_str(), "gone");
        assert_eq!(AgentLspStatus::Error.as_str(), "error");
    }

    #[test]
    fn ensure_ok_ready_is_ready() {
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(true, true, None)).as_str(),
            "ready"
        );
    }

    /// Java 索引期：握手成功但 ready=false → indexing（不是 ready，也不是错误）。
    #[test]
    fn ensure_ok_not_ready_is_indexing() {
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(true, false, None)).as_str(),
            "indexing"
        );
    }

    #[test]
    fn ensure_kind_maps_to_status() {
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(false, false, Some("server_not_found"))).as_str(),
            "no_server"
        );
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(false, false, Some("untrusted"))).as_str(),
            "untrusted"
        );
    }

    /// spawn/handshake 失败是 error，不是 no_server——两者对用户的可操作性不同
    /// （no_server = 去装 server；error = 看日志）。
    #[test]
    fn ensure_spawn_and_handshake_failure_are_error() {
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(false, false, Some("spawn_failed"))).as_str(),
            "error"
        );
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(false, false, Some("handshake_failed"))).as_str(),
            "error"
        );
    }
}
