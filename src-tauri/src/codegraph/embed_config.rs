use crate::codegraph::embed::{Embedder, HttpEmbedder, HttpEmbedderConfig, HttpFormat, OrtEmbedder};
use crate::codegraph::query;
use crate::commands::settings::RuntimeCodeGraphEmbedderConfig;

/// Build a concrete embedder from a config. Match on `backend`:
/// - `fastembed` → local ONNX (may download a model on first use).
/// - `http` → HTTP embedder (Ollama / OpenAI-compatible), format selects the wire shape.
///
/// Returns `Ok(Box<dyn Embedder>)` on success. A local ONNX (ort) embedder init
/// failure or an invalid http config yields an `Err`; the caller logs and proceeds
/// without an embedder (structure layer still works — semantic search is just unavailable).
pub(crate) fn make_embedder(cfg: &RuntimeCodeGraphEmbedderConfig) -> Result<Box<dyn Embedder>, String> {
    match cfg.backend.as_str() {
        "http" => {
            if cfg.base_url.trim().is_empty() {
                return Err("http embedder: baseUrl is empty".into());
            }
            if cfg.model.trim().is_empty() {
                return Err("http embedder: model is empty".into());
            }
            let format = HttpFormat::from_config(&cfg.format);
            let http_cfg = HttpEmbedderConfig {
                base_url: cfg.base_url.clone(),
                api_key: cfg.api_key.clone(),
                model: cfg.model.clone(),
                format,
                dim: cfg.dim as usize,
            };
            HttpEmbedder::new(http_cfg)
                .map(|e| Box::new(e) as Box<dyn Embedder>)
                .map_err(|e| format!("http embedder init failed: {}", e))
        }
        _ => {
            // "fastembed" backend name or anything else → default local ONNX backend.
            // Uses OrtEmbedder (ort direct, CPU arena + memory pattern DISABLED) to
            // avoid the arena-allocator hoarding that ballooned aide.exe to GBs
            // during index rebuilds. See embed.rs `OrtEmbedder` doc for the root cause.
            OrtEmbedder::new()
                .map(|e| Box::new(e) as Box<dyn Embedder>)
                .map_err(|e| format!("ort embedder init failed: {}", e))
        }
    }
}

/// Compute the identity (`model_name`, `dim`) a configured embedder *would*
/// have, **without** constructing it. Used by the build path to short-circuit
/// the on-disk index reuse check: if the cached embedder identity matches the
/// config, we can reuse `load_project_index`; if not, we drop the cached
/// embedder and rebuild.
///
/// For `fastembed` this is a constant (`fastembed:all-MiniLM-L6-v2`, 384). For
/// `http` the model_name is `<prefix>:<model>` (e.g. `ollama:bge-m3`) — the
/// concrete model is part of the identity so swapping the Ollama/OpenAI model
/// (even to another same-dim model) changes the identity and forces a rebuild,
/// rather than silently reusing a shard built in a different vector space. Dim
/// is the configured value (or 0 = auto-probe, in which case the on-disk meta's
/// dim is compared against 0 and never matches a real dim, forcing a rebuild on
/// the first build after switching to auto-probe; subsequent builds match
/// because meta is then stamped with the probed dim).
///
/// Must agree with `HttpEmbedder::model_name()` — both derive prefix + model
/// via `HttpFormat::prefix()` / `from_config` so they stay in sync.
pub(crate) fn config_embedder_identity(cfg: &RuntimeCodeGraphEmbedderConfig) -> (String, usize) {
    match cfg.backend.as_str() {
        "http" => {
            let name = format!("{}:{}", HttpFormat::from_config(&cfg.format).prefix(), cfg.model);
            (name, cfg.dim as usize)
        }
        _ => ("fastembed:all-MiniLM-L6-v2".to_string(), 384),
    }
}

/// Read the codegraph embedder config from the app config file. The block lives
/// at `config["settings"]["codegraphEmbedder"]` (a field of `AppSettings`).
/// Returns the default (fastembed) if the file or block is missing — zero-config
/// out of the box. Best-effort: malformed JSON → default, logged, never panics.
pub(crate) fn load_embedder_config(service: &crate::settings::SettingsService) -> RuntimeCodeGraphEmbedderConfig {
    crate::commands::settings::resolve_codegraph_embedder(service).unwrap_or_else(|error| {
        tracing::warn!("codegraph: invalid embedder config, using default: {error}");
        RuntimeCodeGraphEmbedderConfig { backend: "fastembed".to_string(), base_url: String::new(), api_key: String::new(), model: "nomic-embed-text".to_string(), format: "ollama".to_string(), dim: 0, score_threshold: None }
    })
}

/// Query-time score threshold for `semantic_search`: the user's override
/// (`codegraphEmbedder.scoreThreshold`) or the per-backend default. Read fresh
/// each query — the threshold is a pure filter, never touches embeddings, so
/// changing it takes effect immediately without a rebuild. Reuses
/// `load_embedder_config`'s invalid-config fallback.
pub(crate) fn query_score_threshold(service: &crate::settings::SettingsService) -> f32 {
    query::semantic::effective_score_threshold(&load_embedder_config(service))
}