//! CodeGraph 索引/查询引擎（runner 侧，原 `src-tauri/src/codegraph/` 整体迁入）。
//!
//! 模块职责不变，变更只在进程边界：
//! - `types` 来自 codegraph-core（主进程 lsp 层共用同一份 DTO）；
//! - `gate`（trust/开关门控）留在主进程——政策与机制分离；
//! - `embed_config` 不再读 SettingsService，配置随请求参数传入。

pub mod indexer;
pub mod types {
    pub use codegraph_core::types::*;
}
pub mod agent;
pub mod build;
pub mod edges;
pub mod embed;
pub mod embed_config;
pub mod guard;
pub mod incremental;
pub mod meta;
pub mod methods;
pub mod parser;
pub mod query;
pub mod resume;
pub mod shard;
pub mod state;
pub mod symbols;

// Re-export `CodeGraphState`（runner 内部状态机：索引单例 + embedder 缓存 +
// 进度 atomics）。原 `crate::codegraph::CodeGraphState` 路径继续有效。
pub use state::CodeGraphState;

/// Prefix prepended to every text sent to the embedder (both document snippets
/// and query text, so they share the embedding space).
///
/// **Why:** Ollama `bge-m3` deterministically emits a NaN vector for certain
/// bare code token sequences (a model numerical-overflow bug — not length, not
/// CRLF, but a specific token pattern), which the server cannot JSON-encode →
/// HTTP 500 "failed to encode response: json: unsupported value: NaN". One such
/// snippet fails its whole batch. A short natural-language prefix consistently
/// avoids the NaN trigger across tested snippets, so batches embed in bulk
/// (fast) instead of bisecting to skip every offender (slow). The bisection
/// fallback in `store::embed_and_store` still handles any residual NaN snippet
/// the prefix doesn't cover.
pub(crate) fn embed_input(raw: &str) -> String {
    format!("code: {}", raw)
}

/// Number of code snippets embedded per ONNX forward pass during a full rebuild
/// (Phase 2) and incremental reindex. Each batch allocates attention-score
/// tensors of `(batch, heads=8, seq≤512, seq≤512)` per transformer layer (6
/// layers for all-MiniLM-L6-v2). The old 256/batch figure (~6GB peak, observed
/// via VMMap as the aide.exe 3-6GB heap balloon during rebuilds) was measured
/// WITH the default CPU arena hoarding per-inference temp tensors. The arena is
/// now DISABLED in `OrtEmbedder::new` (`DisableCpuMemArena` +
/// `cpu_arena_allocator=0` + `with_memory_pattern(false)`), so per-batch temp
/// tensors are malloc/free'd and returned to the OS each batch — the 256/batch
/// peak should now be transient, not a hoarded steady-state. Bumped 32→256 to
/// cut rebuild time (~8x fewer batches; 3739 symbols → ~15 batches vs ~117). If
/// the transient peak proves too high in dev, drop to 128/64.
///
/// 进程隔离后的额外红利：这个峰值现在发生在 aide-codegraph.exe 内，即使
/// 回潮也只影响 runner 自己的堆——aide.exe 的会话/:UI 预算与它无关。
pub(crate) const EMBED_BATCH_SIZE: usize = 256;
