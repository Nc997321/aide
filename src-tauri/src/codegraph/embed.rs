//! Pluggable embedding backend for CodeGraph.
//!
//! Two implementations behind one trait:
//! - [`FastEmbedEmbedder`]: local ONNX CPU via fastembed-rs (default, zero-config,
//!   but downloads a model on first use — see `model_dir`).
//! - [`HttpEmbedder`]: any HTTP embedding service — Ollama (local or remote) and
//!   OpenAI/Jina-style cloud APIs are the same thing (POST JSON, parse vectors),
//!   differing only in endpoint shape + auth header. Selected by `format`.
//!
//! The [`Embedder`] trait is the only abstraction the rest of CodeGraph depends
//! on, so adding a new backend (e.g. a native torch wrapper) is one more impl.
//! `dim()` + `model_name()` are written into `meta.json`; a mismatch with the
//! configured embedder forces a full rebuild (vectors of different dimension /
//! model space are not compatible with an existing shard).

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::commands::proxy::detect_proxy;

/// Pluggable embedding backend. All of CodeGraph talks to this trait, never to a
/// concrete embedder — so the backend is swappable via config without touching
/// the indexer/shard/query layers.
///
/// `model_name()` is persisted in `meta.json`; when the configured embedder's
/// model name differs from the on-disk meta, the index is treated as stale and
/// rebuilt (dimension / model space incompatibility). `dim()` likewise gates
/// shard creation — a shard built for 384-dim vectors cannot serve 768-dim.
pub trait Embedder: Send + Sync {
    /// Embed a batch of texts into `dim()`-dim vectors, one per input text.
    fn embed_batch(
        &self,
        texts: &[String],
    ) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>>;

    /// Vector dimensionality of this embedder's model.
    fn dim(&self) -> usize;

    /// Stable identifier written to `meta.json`. Changing it triggers a full
    /// rebuild. Include the backend + model (e.g. `fastembed:all-MiniLM-L6-v2`,
    /// `ollama:nomic-embed-text`) so a backend or model switch is detected.
    fn model_name(&self) -> &str;
}

/// Default-implementation helper: embed a single text via `embed_batch`.
/// Kept as a free function (not a trait default) so callers pass `&dyn Embedder`
/// and get a single vector without every impl repeating the singleton unwrap.
pub fn embed_one(
    embedder: &dyn Embedder,
    text: &str,
) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let batches = embedder.embed_batch(&[text.to_string()])?;
    Ok(batches.into_iter().next().unwrap_or_default())
}

// ─────────────────────────────────────────────────────────────────────────────
// fastembed backend (local ONNX CPU)
// ─────────────────────────────────────────────────────────────────────────────

mod fastembed_impl {
    use super::Embedder;
    use fastembed::{
        EmbeddingModel, InitOptions, Pooling, TextEmbedding, TokenizerFiles,
        UserDefinedEmbeddingModel,
    };
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Wraps fastembed-rs `TextEmbedding`. Loads the ONNX model from local cache,
    /// falling back to hf_hub download only if local files are missing.
    pub struct FastEmbedEmbedder {
        model: Mutex<TextEmbedding>,
    }

    /// Directory containing the 5 model files (HF cache layout).
    fn model_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
        let hf_home = std::env::var("HF_HOME")
            .or_else(|_| std::env::var("HOME").map(|h| h + "/.cache/huggingface"))
            .or_else(|_| std::env::var("USERPROFILE").map(|u| u + "/.cache/huggingface"))
            .map(PathBuf::from)?;

        let dir = hf_home
            .join("hub")
            .join("models--Qdrant--all-MiniLM-L6-v2-onnx")
            .join("snapshots");

        let snapshots = std::fs::read_dir(&dir)
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.path())
                    .next()
            });

        snapshots.ok_or_else(|| format!("No model snapshot found in {}", dir.display()).into())
    }

    fn read_or_empty(path: &std::path::Path) -> Vec<u8> {
        std::fs::read(path).unwrap_or_default()
    }

    impl FastEmbedEmbedder {
        /// Create embedder with all-MiniLM-L6-v2 (384-dim).
        /// Tries hf_hub first; falls back to local files from HF cache.
        pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
            if let Ok(model) =
                TextEmbedding::try_new(InitOptions::new(EmbeddingModel::AllMiniLML6V2))
            {
                return Ok(Self {
                    model: Mutex::new(model),
                });
            }

            // Fall back to local files — bypass hf_hub entirely.
            let dir = model_dir()?;
            let onnx = read_or_empty(&dir.join("model.onnx"));
            if onnx.is_empty() {
                return Err("model.onnx is missing from cache".into());
            }
            let tokenizer_files = TokenizerFiles {
                tokenizer_file: read_or_empty(&dir.join("tokenizer.json")),
                config_file: read_or_empty(&dir.join("config.json")),
                special_tokens_map_file: read_or_empty(&dir.join("special_tokens_map.json")),
                tokenizer_config_file: read_or_empty(&dir.join("tokenizer_config.json")),
            };
            let user_model =
                UserDefinedEmbeddingModel::new(onnx, tokenizer_files).with_pooling(Pooling::Mean);
            let model = TextEmbedding::try_new_from_user_defined(
                user_model,
                fastembed::InitOptionsUserDefined::new(),
            )?;
            Ok(Self {
                model: Mutex::new(model),
            })
        }
    }

    impl Embedder for FastEmbedEmbedder {
        fn embed_batch(
            &self,
            texts: &[String],
        ) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
            let model = self.model.lock().unwrap();
            let embeddings = model.embed(texts.to_vec(), None)?;
            Ok(embeddings)
        }

        fn dim(&self) -> usize {
            384
        }

        fn model_name(&self) -> &str {
            "fastembed:all-MiniLM-L6-v2"
        }
    }
}

pub use fastembed_impl::FastEmbedEmbedder;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP backend (Ollama local/remote + OpenAI-compatible cloud)
// ─────────────────────────────────────────────────────────────────────────────

/// Wire format for the HTTP embedding endpoint. Ollama's native `/api/embed`
/// and the OpenAI `/v1/embeddings` shape differ only in request/response JSON,
/// so one [`HttpEmbedder`] covers both (and anything that mimics either).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HttpFormat {
    Ollama,
    Openai,
}

/// Configuration for the HTTP embedder. Mirrors the frontend
/// `CodeGraphEmbedderConfig` (http branch); deserialized from the app settings
/// `codegraphEmbedder` block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpEmbedderConfig {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    pub format: HttpFormat,
    /// Vector dimension. `0` = probe from the first successful response (we then
    /// cache the observed dim so subsequent batches are validated consistently).
    #[serde(default)]
    pub dim: usize,
}

/// True if `url` points at a private/LAN/local target that must be hit
/// directly (no proxy): `localhost`, `127.x`, `10.x`, `192.168.x`,
/// `172.16–31.x`. Routing these through a local proxy (Clash) makes the proxy
/// return 502 — it can't reach a private address through itself. Best-effort
/// parse: extracts the host between `://` and the next `:`/`/`.
fn is_private_target(url: &str) -> bool {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let host = after_scheme.split([':', '/']).next().unwrap_or("");
    if host == "localhost" || host == "::1" {
        return true;
    }
    if host.starts_with("127.") || host.starts_with("10.") || host.starts_with("192.168.") {
        return true;
    }
    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(seg) = rest.split('.').next() {
            if let Ok(n) = seg.parse::<u8>() {
                return (16..=31).contains(&n);
            }
        }
    }
    false
}

/// HTTP-based embedder. One HTTP request per batch (256 texts), reusing a
/// `ureq::Agent` for connection pooling. Proxy is auto-detected the same way as
/// the provider model refresh (`commands::proxy::detect_proxy`) **except** for
/// LAN/private targets — a local Ollama at `10.x` / `192.168.x` / `localhost`
/// must be hit directly, or the proxy (Clash etc.) returns 502 trying to route
/// a private address through itself. Cloud targets (api.openai.com etc.) still
/// go through the detected proxy.
pub struct HttpEmbedder {
    agent: ureq::Agent,
    base_url: String,
    api_key: String,
    model: String,
    format: HttpFormat,
    /// Configured dim, or 0 = auto-probe. Once probed, locked in `observed_dim`
    /// so all subsequent batches must match.
    configured_dim: usize,
    observed_dim: Mutex<Option<usize>>,
}

impl HttpEmbedder {
    pub fn new(cfg: HttpEmbedderConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(60));
        // Only route through the auto-detected proxy for non-private targets.
        // A LAN Ollama (10.x / 192.168.x / localhost) must be hit directly — the
        // local proxy (Clash etc.) returns 502 trying to route a private address
        // through itself. Cloud targets still go through the proxy.
        if !is_private_target(&cfg.base_url) {
            if let Some(proxy_url) = detect_proxy() {
                if let Ok(proxy) = ureq::Proxy::new(&proxy_url) {
                    builder = builder.proxy(proxy);
                }
            }
        }
        Ok(Self {
            agent: builder.build(),
            base_url: cfg.base_url.trim_end_matches('/').to_string(),
            api_key: cfg.api_key,
            model: cfg.model,
            format: cfg.format,
            configured_dim: cfg.dim,
            observed_dim: Mutex::new(None),
        })
    }

    /// POST the batch and return one vector per input text.
    fn request(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
        let body = serde_json::json!({ "model": self.model, "input": texts });
        let endpoint = match self.format {
            HttpFormat::Ollama => format!("{}/api/embed", self.base_url),
            HttpFormat::Openai => format!("{}/v1/embeddings", self.base_url),
        };
        let mut req = self.agent.post(&endpoint);
        if self.format == HttpFormat::Openai && !self.api_key.is_empty() {
            req = req.set("Authorization", &format!("Bearer {}", self.api_key));
        }
        let resp = req.send_json(body)?;
        let status = resp.status();
        let val: serde_json::Value = resp.into_json()?;
        if status >= 400 {
            return Err(format!(
                "embedding endpoint returned {}: {}",
                status,
                extract_error_message(&val)
            )
            .into());
        }
        let vectors = parse_embeddings(&val, self.format)
            .ok_or_else(|| format!("no embeddings in response: {}", val))?;
        Ok(vectors)
    }

}

impl Embedder for HttpEmbedder {
    fn embed_batch(
        &self,
        texts: &[String],
    ) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let vectors = self.request(texts)?;
        if vectors.len() != texts.len() {
            return Err(format!(
                "embedding count mismatch: sent {} texts, got {} vectors",
                texts.len(),
                vectors.len()
            )
            .into());
        }
        // Lock in the observed dimension on the first successful call when
        // configured dim is 0 (auto-probe). Validate consistency on every call
        // so a server-side model swap mid-build doesn't silently corrupt the shard.
        let dim = vectors.first().map(|v| v.len()).unwrap_or(0);
        if dim == 0 {
            return Err("embedding endpoint returned zero-length vectors".into());
        }
        let mut observed = self.observed_dim.lock().unwrap();
        match *observed {
            None => *observed = Some(dim),
            Some(prev) if prev != dim => {
                return Err(format!(
                    "embedding dimension changed mid-build: {} -> {} (model swapped?)",
                    prev, dim
                )
                .into());
            }
            _ => {}
        }
        Ok(vectors)
    }

    fn dim(&self) -> usize {
        // Configured dim if non-zero; else the observed dim locked in on the
        // first successful embed_batch. 0 before any call (auto-probe pending) —
        // callers that need a concrete dim must probe first (build path does).
        if self.configured_dim != 0 {
            return self.configured_dim;
        }
        self.observed_dim.lock().unwrap().unwrap_or(0)
    }

    fn model_name(&self) -> &str {
        match self.format {
            HttpFormat::Ollama => "ollama",
            HttpFormat::Openai => "openai",
        }
    }
}

/// Extract the embedding vectors from a response, by format.
/// - ollama: `resp["embeddings"]` is an array of arrays.
/// - openai: `resp["data"]` is an array of `{ embedding: [...] }`.
fn parse_embeddings(val: &serde_json::Value, format: HttpFormat) -> Option<Vec<Vec<f32>>> {
    match format {
        HttpFormat::Ollama => val.get("embeddings").and_then(|e| e.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.as_array()
                        .map(|inner| inner.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect())
                })
                .collect()
        }),
        HttpFormat::Openai => val.get("data").and_then(|d| d.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    entry
                        .get("embedding")
                        .and_then(|e| e.as_array())
                        .map(|inner| {
                            inner.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect()
                        })
                })
                .collect()
        }),
    }
}

/// Pull a human-readable message out of an error response body.
/// OpenAI nests it under `error.message`; Ollama puts it at top-level `error`.
fn extract_error_message(val: &serde_json::Value) -> String {
    if let Some(e) = val.get("error") {
        if let Some(s) = e.as_str() {
            return s.to_string();
        }
        if let Some(m) = e.get("message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
    }
    val.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ollama_embeddings_array_of_arrays() {
        let resp = serde_json::json!({
            "embeddings": [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
        });
        let v = parse_embeddings(&resp, HttpFormat::Ollama).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0], vec![0.1_f32, 0.2, 0.3]);
        assert_eq!(v[1], vec![0.4_f32, 0.5, 0.6]);
    }

    #[test]
    fn parse_openai_data_array_with_embedding_field() {
        let resp = serde_json::json!({
            "data": [
                { "embedding": [1.0, 2.0, 3.0], "index": 0 },
                { "embedding": [4.0, 5.0, 6.0], "index": 1 }
            ]
        });
        let v = parse_embeddings(&resp, HttpFormat::Openai).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0], vec![1.0_f32, 2.0, 3.0]);
        assert_eq!(v[1], vec![4.0_f32, 5.0, 6.0]);
    }

    #[test]
    fn parse_returns_none_on_missing_field() {
        let resp = serde_json::json!({ "unrelated": [] });
        assert!(parse_embeddings(&resp, HttpFormat::Ollama).is_none());
        assert!(parse_embeddings(&resp, HttpFormat::Openai).is_none());
    }

    #[test]
    fn error_message_openai_nested() {
        let resp = serde_json::json!({ "error": { "message": "model not found" } });
        assert_eq!(extract_error_message(&resp), "model not found");
    }

    #[test]
    fn error_message_ollama_top_level() {
        let resp = serde_json::json!({ "error": "not found" });
        assert_eq!(extract_error_message(&resp), "not found");
    }

    #[test]
    fn embed_one_returns_single_vector() {
        struct Dummy;
        impl Embedder for Dummy {
            fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
                Ok(texts.iter().map(|t| vec![t.len() as f32]).collect())
            }
            fn dim(&self) -> usize { 1 }
            fn model_name(&self) -> &str { "dummy" }
        }
        let v = embed_one(&Dummy, "hello").unwrap();
        assert_eq!(v, vec![5.0_f32]);
    }

    #[test]
    fn is_private_target_detects_lan_and_localhost() {
        assert!(is_private_target("http://localhost:11434"));
        assert!(is_private_target("http://127.0.0.1:11434"));
        assert!(is_private_target("http://10.0.0.5:11434"));
        assert!(is_private_target("http://192.168.1.5:11434"));
        assert!(is_private_target("http://172.16.0.1:11434"));
        assert!(is_private_target("http://172.31.255.255:11434"));
        // 172.15 and 172.32 are NOT private (outside the 16-31 range).
        assert!(!is_private_target("http://172.15.0.1:11434"));
        assert!(!is_private_target("http://172.32.0.1:11434"));
        // Cloud targets must go through the proxy.
        assert!(!is_private_target("https://api.openai.com"));
        assert!(!is_private_target("https://api.jina.ai:443/v1"));
    }
}