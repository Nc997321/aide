use codegraph_core::RuntimeCodeGraphEmbedderConfig;

use crate::codegraph::embed::{
    Embedder, HttpEmbedder, HttpEmbedderConfig, HttpFormat, OrtEmbedder,
};

/// Build a concrete embedder from a config. Match on `backend`:
/// - `fastembed` → local ONNX (may download a model on first use).
/// - `http` → HTTP embedder (Ollama / OpenAI-compatible), format selects the wire shape.
///
/// `proxy` 仅作用于 HttpEmbedder 的出站连接（主进程 detect_proxy 的结果——
/// 进程隔离后设置/环境探测归主进程，本进程拿到的就是结论）。局域网目标
/// 照旧直连（见 `HttpEmbedder::new` 的 is_private_target 判定）。
///
/// Returns `Ok(Box<dyn Embedder>)` on success. A local ONNX (ort) embedder init
/// failure or an invalid http config yields an `Err`; the caller logs and proceeds
/// without an embedder (structure layer still works — semantic search is just unavailable).
pub(crate) fn make_embedder(
    cfg: &RuntimeCodeGraphEmbedderConfig,
    proxy: Option<&str>,
) -> Result<Box<dyn Embedder>, String> {
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
                proxy: proxy.map(|p| p.to_string()),
            };
            HttpEmbedder::new(http_cfg)
                .map(|e| Box::new(e) as Box<dyn Embedder>)
                .map_err(|e| format!("http embedder init failed: {}", e))
        }
        _ => {
            // "fastembed" backend name or anything else → default local ONNX backend.
            // Uses OrtEmbedder (ort direct, CPU arena + memory pattern DISABLED) to
            // avoid the arena-allocator hoarding that ballooned memory during index
            // rebuilds (进程隔离前是 aide.exe 3G→6G；现在发生在 runner 自己的堆里).
            // See embed.rs `OrtEmbedder` doc for the root cause.
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
            let name = format!(
                "{}:{}",
                HttpFormat::from_config(&cfg.format).prefix(),
                cfg.model
            );
            (name, cfg.dim as usize)
        }
        _ => ("fastembed:all-MiniLM-L6-v2".to_string(), 384),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 身份判定不构造 embedder（fastembed 分支返回常量；http 分支只拼字符串）。
    #[test]
    fn config_identity_http_includes_model() {
        let cfg = RuntimeCodeGraphEmbedderConfig {
            backend: "http".into(),
            base_url: "http://127.0.0.1:11434".into(),
            api_key: String::new(),
            model: "bge-m3".into(),
            format: "ollama".into(),
            dim: 1024,
            score_threshold: None,
        };
        assert_eq!(
            config_embedder_identity(&cfg),
            ("ollama:bge-m3".to_string(), 1024)
        );
    }

    #[test]
    fn config_identity_fastembed_is_constant() {
        let cfg = RuntimeCodeGraphEmbedderConfig::default();
        assert_eq!(
            config_embedder_identity(&cfg),
            ("fastembed:all-MiniLM-L6-v2".to_string(), 384)
        );
    }
}
