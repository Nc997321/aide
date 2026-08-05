pub mod indexer;
pub mod types;
pub mod shard;
pub mod embed;
pub mod parser;
pub mod query;
pub mod symbols;
pub mod edges;
pub mod meta;
pub mod guard;
pub mod agent;
pub mod state;
pub mod embed_config;
pub mod build;
pub mod incremental;
pub mod resume;
pub mod commands;

// Re-export `CodeGraphState` so `lib.rs` keeps using `crate::codegraph::CodeGraphState::new()`.
// Tauri commands stay at their submodule paths (`codegraph::build::codegraph_build_index`,
// `codegraph::commands::*`) — `#[tauri::command]` generates `__cmd__`/`__tauri_command_name_`
// helpers next to the function definition, which a `pub use` here would NOT carry,
// so `generate_handler!` must point at the defining module.
pub use state::{CodeGraphState, ProjectIndex};

// Re-exported so `runtime/mod.rs` keeps using `crate::codegraph::query_score_threshold`.
pub(crate) use embed_config::query_score_threshold;

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
pub(crate) const EMBED_BATCH_SIZE: usize = 256;