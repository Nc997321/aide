//! Embedder 配置与查询阈值（主进程侧）。
//!
//! 迁移对账：runner 侧的 `codegraph/embed_config.rs` 只剩 `make_embedder` /
//! `config_embedder_identity`（机制）；读 SettingsService 的两个函数留在
//! 主进程（政策）——配置在本层解析、序列化后随 RPC 参数下传。

use codegraph_core::RuntimeCodeGraphEmbedderConfig;

use crate::app_settings::public_settings;
use crate::settings::SettingsService;

/// 设置里的 embedder 块 + 密钥端口里的 API key → 随 RPC 下传给 runner 的运行时配置。
/// 代码索引开关是工作区级（`commands::workspace::codegraph_workspaces`，每工作区默认关），
/// 不在这里。
fn resolve_codegraph_embedder(
    service: &SettingsService,
) -> Result<RuntimeCodeGraphEmbedderConfig, String> {
    let settings = public_settings(service)?;
    Ok(RuntimeCodeGraphEmbedderConfig {
        backend: settings.codegraph_embedder.backend,
        base_url: settings.codegraph_embedder.base_url,
        api_key: service
            .secrets()
            .get("codegraph/default/apiKey")
            .map_err(|error| error.to_string())?
            .unwrap_or_default(),
        model: settings.codegraph_embedder.model,
        format: settings.codegraph_embedder.format,
        dim: settings.codegraph_embedder.dim,
        score_threshold: settings.codegraph_embedder.score_threshold,
    })
}

/// Read the codegraph embedder config from the app config file. The block lives
/// at `config["settings"]["codegraphEmbedder"]` (a field of `AppSettings`).
/// Returns the default (fastembed) if the file or block is missing — zero-config
/// out of the box. Best-effort: malformed JSON → default, logged, never panics.
pub fn load_embedder_config(
    service: &SettingsService,
) -> RuntimeCodeGraphEmbedderConfig {
    resolve_codegraph_embedder(service).unwrap_or_else(|error| {
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
pub fn query_score_threshold(service: &SettingsService) -> f32 {
    codegraph_core::effective_score_threshold(&load_embedder_config(service))
}
