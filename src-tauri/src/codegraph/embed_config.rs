//! Embedder 配置与查询阈值（主进程侧）。
//!
//! 迁移对账：runner 侧的 `codegraph/embed_config.rs` 只剩 `make_embedder` /
//! `config_embedder_identity`（机制）；读 SettingsService 的两个函数留在
//! 主进程（政策）——配置在本层解析、序列化后随 RPC 参数下传。

use codegraph_core::RuntimeCodeGraphEmbedderConfig;

/// Read the codegraph embedder config from the app config file. The block lives
/// at `config["settings"]["codegraphEmbedder"]` (a field of `AppSettings`).
/// Returns the default (fastembed) if the file or block is missing — zero-config
/// out of the box. Best-effort: malformed JSON → default, logged, never panics.
pub(crate) fn load_embedder_config(
    service: &crate::settings::SettingsService,
) -> RuntimeCodeGraphEmbedderConfig {
    crate::commands::settings::resolve_codegraph_embedder(service).unwrap_or_else(|error| {
        tracing::warn!("codegraph: invalid embedder config, using default: {error}");
        RuntimeCodeGraphEmbedderConfig {
            backend: "fastembed".to_string(),
            base_url: String::new(),
            api_key: String::new(),
            model: "nomic-embed-text".to_string(),
            format: "ollama".to_string(),
            dim: 0,
            score_threshold: None,
        }
    })
}

/// Query-time score threshold for `semantic_search`: the user's override
/// (`codegraphEmbedder.scoreThreshold`) or the per-backend default. Read fresh
/// each query — the threshold is a pure filter, never touches embeddings, so
/// changing it takes effect immediately without a rebuild. Reuses
/// `load_embedder_config`'s invalid-config fallback. 阈值计算在 codegraph-core
/// （与 runner 共用同一实现，两侧永不漂移）。
pub(crate) fn query_score_threshold(service: &crate::settings::SettingsService) -> f32 {
    codegraph_core::effective_score_threshold(&load_embedder_config(service))
}
