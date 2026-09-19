//! 就绪探测：把「进程在」升级成「语义层可用」。
//!
//! 存在的理由：`EnsureOutcome.ready` 只对 jdtls 有真实语义（见 lsp/mod.rs 注释），
//! rust-analyzer 握手即 ready=true 但索引还要几十秒。**调用方拿 ready 当闸门就是
//! 把「还没好」当成「没有」**——那正是内置 LSP 工具的失败模式。
//!
//! 判定手段与工具无关：轮询一个**廉价语义查询**（调用方注入，通常是
//! `documentSymbol`）直到非空。探测函数注入而非内联，是为了本模块可单测。
//!
//! 注意 `Ready` **也**要探测——状态词只表示「ensure 说它好了」，不表示索引建完了。
//! C1 不做探测结果缓存：每次查询多一次廉价往返，换「永不说谎」。缓存是后续优化。

use crate::lsp::agent_status::AgentLspStatus;
use std::future::Future;
use std::time::Duration;
use tokio::time::{sleep, Instant};

/// 探测预算。`total` 与 `interval` 相邻同型，写成两个位置参数交换即静默错位
/// （一个变成「每 90 秒探一次、5 秒超时」），故打包。
#[derive(Debug, Clone, Copy)]
pub struct ReadinessBudget {
    /// 探测总预算。90s 是拍的，标定依据：本仓库 rust-analyzer 实测 46–73s（jdtls 更长）。
    pub total: Duration,
    /// 两次探测之间的间隔。
    pub interval: Duration,
}

impl Default for ReadinessBudget {
    fn default() -> Self {
        Self {
            total: Duration::from_secs(90),
            interval: Duration::from_secs(5),
        }
    }
}

/// `Ready` / `Indexing` 探测到成功为止；其余状态原样返回。
///
/// 预算耗尽一律返回 `Indexing`——**绝不返回 `Ready`**：没探测成功就没有
/// 「空结果可信」的资格。`Ready` 传入但探测失败时同样降级，理由同上。
pub async fn await_ready<F, Fut>(
    initial: AgentLspStatus,
    mut probe: F,
    budget: ReadinessBudget,
) -> AgentLspStatus
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    if !matches!(initial, AgentLspStatus::Ready | AgentLspStatus::Indexing) {
        return initial;
    }
    let deadline = Instant::now() + budget.total;
    while Instant::now() < deadline {
        if probe().await {
            return AgentLspStatus::Ready;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        sleep(budget.interval.min(left)).await;
    }
    AgentLspStatus::Indexing
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 测试预算：总预算短、间隔更短——**间隔必须显著小于总预算**，否则第一次
    /// 轮询就睡掉整个预算，永远只探测一次（初稿的测试正是栽在这里）。
    fn fast(total_ms: u64) -> ReadinessBudget {
        ReadinessBudget {
            total: Duration::from_millis(total_ms),
            interval: Duration::from_millis(10),
        }
    }

    /// 硬失败态短路：重试不会变好，且**不该白花一次探测**。
    #[tokio::test]
    async fn hard_failures_short_circuit_without_probing() {
        for s in [
            AgentLspStatus::NoServer,
            AgentLspStatus::Untrusted,
            AgentLspStatus::Error,
            AgentLspStatus::NoSymbol,
            AgentLspStatus::Timeout,
            AgentLspStatus::Gone,
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let c = calls.clone();
            let got = await_ready(
                s,
                move || {
                    c.fetch_add(1, Ordering::SeqCst);
                    async { true }
                },
                fast(50),
            )
            .await;
            assert_eq!(got, s, "{:?} 应原样返回", s);
            assert_eq!(calls.load(Ordering::SeqCst), 0, "{:?} 不该探测", s);
        }
    }

    /// **本任务的核心回归测试**：`Ready` 也不可信。
    /// rust-analyzer 握手即 ready=true 但索引还要几十秒——若这里短路，
    /// 就退回「空冒充没有」了。
    #[tokio::test]
    async fn ready_is_still_probed_and_downgrades_on_failure() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let got = await_ready(
            AgentLspStatus::Ready,
            move || {
                c.fetch_add(1, Ordering::SeqCst);
                async { false }
            },
            fast(120),
        )
        .await;
        assert!(calls.load(Ordering::SeqCst) > 0, "Ready 必须被探测，不能短路");
        assert_eq!(
            got,
            AgentLspStatus::Indexing,
            "探测失败要降级，不能保持 Ready"
        );
    }

    #[tokio::test]
    async fn ready_probe_success_stays_ready() {
        let got = await_ready(AgentLspStatus::Ready, || async { true }, fast(50)).await;
        assert_eq!(got, AgentLspStatus::Ready);
    }

    #[tokio::test]
    async fn indexing_becomes_ready_when_probe_succeeds() {
        let n = Arc::new(AtomicUsize::new(0));
        let c = n.clone();
        let got = await_ready(
            AgentLspStatus::Indexing,
            move || {
                let i = c.fetch_add(1, Ordering::SeqCst);
                async move { i >= 2 }
            },
            fast(2000),
        )
        .await;
        assert_eq!(got, AgentLspStatus::Ready);
        assert_eq!(n.load(Ordering::SeqCst), 3, "第 3 次才返回 true");
    }

    /// 预算耗尽仍没就绪 → 保持 indexing（**不是** timeout：进程还活着，只是慢）。
    #[tokio::test]
    async fn budget_exhausted_stays_indexing() {
        let got = await_ready(
            AgentLspStatus::Indexing,
            || async { false },
            fast(120),
        )
        .await;
        assert_eq!(got, AgentLspStatus::Indexing);
    }
}
