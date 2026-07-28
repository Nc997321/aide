//! Pluggable embedding backend for CodeGraph.
//!
//! Two implementations behind one trait:
//! - [`OrtEmbedder`]: local ONNX CPU via `ort` (default, zero-config, loads the
//!   all-MiniLM-L6-v2 model from the HF cache on first use — see `model_dir`).
//!   Uses `ort` directly rather than fastembed-rs so the ONNX Runtime CPU arena
//!   allocator + memory pattern can be DISABLED — fastembed exposes no arena
//!   config, and the default arena hoards per-inference temp tensors, ballooning
//!   aide.exe memory to GBs during index rebuilds (see `OrtEmbedder` doc).
//! - [`HttpEmbedder`]: any HTTP embedding service — Ollama (local or remote) and
//!   OpenAI/Jina-style cloud APIs are the same thing (POST JSON, parse vectors),
//!   differing only in endpoint shape + auth header. Selected by `format`.
//!
//! The [`Embedder`] trait is the only abstraction the rest of CodeGraph depends
//! on, so adding a new backend (e.g. a native torch wrapper) is one more impl.
//! `dim()` + `model_name()` are written into `meta.json`; a mismatch with the
//! configured embedder forces a full rebuild (vectors of different dimension /
//! model space are not compatible with an existing shard).

use std::path::PathBuf;
use std::sync::Mutex;
use std::thread::available_parallelism;
use std::time::Duration;

use ndarray::{s, Array, Array2, ArrayView, Dim, IxDynImpl};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Value;
use serde::{Deserialize, Serialize};
use tokenizers::{AddedToken, PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};

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
// ort backend (local ONNX CPU, arena + memory pattern DISABLED)
//
// Replaces fastembed for the local embedding path. fastembed wraps ort but
// exposes no arena/allocator config in `InitOptions` — its default ONNX Runtime
// CPU arena allocator hoards every per-inference temp tensor and never returns
// it to the OS. A full index rebuild embeds tens of thousands of code snippets
// (`mod.rs` Phase 2 loop, 256/batch), so the arena balloons aide.exe memory to
// GBs that never drop (observed 3GB → 6GB across two rebuilds). Going through
// `ort` directly lets us set `session.cpu_arena_allocator=0` +
// `with_memory_pattern(false)`, so temp tensors use plain malloc/free and are
// reclaimed to the OS every inference — the fix is structural, not a
// periodic-drop workaround. The tokenizer/encode/pool/normalize logic is
// replicated from fastembed 4.9.1 (`text_embedding/impl.rs`, `common.rs`,
// `pooling.rs`) so embedding output stays numerically identical (same model
// weights, same ORT version, same Level3 opt — arena/memory_pattern affect only
// allocation, not computation) and existing indices keep working.
// ─────────────────────────────────────────────────────────────────────────────

/// HF cache layout for all-MiniLM-L6-v2 (same files fastembed used — no re-download).
/// Located at `~/.cache/huggingface/hub/models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/<hash>/`.
/// Held at module scope so both the ort backend (canonical) and the legacy
/// fastembed backend (removed in a follow-up step) can share it.
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

/// Tokenizer files for the local ONNX backend (mirrors fastembed's `TokenizerFiles`).
struct TokenizerFiles {
    tokenizer_file: Vec<u8>,
    config_file: Vec<u8>,
    special_tokens_map_file: Vec<u8>,
    tokenizer_config_file: Vec<u8>,
}

/// Local ONNX embedder using `ort` directly, with CPU arena + memory pattern
/// DISABLED so per-inference temp tensors are reclaimed by the OS each call.
pub struct OrtEmbedder {
    session: Session,
    tokenizer: Tokenizer,
    need_token_type_ids: bool,
    dim: usize,
    model_name: String,
}

impl OrtEmbedder {
    /// Create embedder with all-MiniLM-L6-v2 (384-dim), loading the ONNX model
    /// from the local HF cache. Arena + memory pattern are disabled on the
    /// session — see the module comment for why this is the root-cause fix.
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let dir = model_dir()?;
        let onnx = std::fs::read(dir.join("model.onnx"))
            .map_err(|e| format!("Failed to read model.onnx from {}: {}", dir.display(), e))?;
        if onnx.is_empty() {
            return Err("model.onnx is missing or empty from cache".into());
        }
        let tokenizer_files = TokenizerFiles {
            tokenizer_file: read_or_empty(&dir.join("tokenizer.json")),
            config_file: read_or_empty(&dir.join("config.json")),
            special_tokens_map_file: read_or_empty(&dir.join("special_tokens_map.json")),
            tokenizer_config_file: read_or_empty(&dir.join("tokenizer_config.json")),
        };

        let threads = available_parallelism().map(|n| n.get()).unwrap_or(4);

        // === Root-cause fix: disable CPU arena + memory pattern ===
        // `with_config_entry("session.cpu_arena_allocator", "0")` tells ONNX Runtime
        // to use the regular device allocator (malloc/free) instead of the arena,
        // so temp tensors are returned to the OS each inference instead of hoarded.
        // `with_memory_pattern(false)` disables the memory-pattern optimization
        // (which pre-allocates reusable buffers sized to the largest input — also
        // retained). Both are needed: arena is the main offender, memory-pattern
        // is a secondary retainer that matters for dynamic batch/seq lengths.
        let session = Session::builder()?
            .with_config_entry("session.cpu_arena_allocator", "0")?
            .with_memory_pattern(false)?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(threads)?
            .commit_from_memory(&onnx)?;

        // BERT-style models take token_type_ids; all-MiniLM-L6-v2 does. Detect from
        // the loaded graph so we don't send an input the model doesn't expect.
        let need_token_type_ids = session
            .inputs
            .iter()
            .any(|input| input.name == "token_type_ids");

        let tokenizer = build_tokenizer(tokenizer_files, 512)?;

        Ok(Self {
            session,
            tokenizer,
            need_token_type_ids,
            dim: 384,
            // Keep the fastembed model_name string so config_embedder_identity and
            // the on-disk meta match — existing indices keep working without a
            // forced rebuild. The embeddings are numerically identical (same
            // model/ORT/opt level; arena affects allocation, not computation).
            model_name: "fastembed:all-MiniLM-L6-v2".to_string(),
        })
    }
}

/// Build the HuggingFace tokenizer with padding/truncation/special tokens.
/// Replicated from fastembed `common.rs::load_tokenizer` so behavior matches.
fn build_tokenizer(
    files: TokenizerFiles,
    max_length: usize,
) -> Result<Tokenizer, Box<dyn std::error::Error>> {
    let config: serde_json::Value = serde_json::from_slice(&files.config_file)
        .map_err(|_| "Failed to parse config.json")?;
    let special_tokens_map: serde_json::Value =
        serde_json::from_slice(&files.special_tokens_map_file).unwrap_or(serde_json::Value::Null);
    let tokenizer_config: serde_json::Value =
        serde_json::from_slice(&files.tokenizer_config_file)
            .map_err(|_| "Failed to parse tokenizer_config.json")?;

    let mut tokenizer = Tokenizer::from_bytes(&files.tokenizer_file)
        .map_err(|e| format!("Failed to load tokenizer.json: {}", e))?;

    // model_max_length can be a huge f64 for some models (fastembed note in
    // common.rs); clamp to the caller's max_length (512 for all-MiniLM-L6-v2).
    let model_max_length = tokenizer_config["model_max_length"].as_f64().unwrap_or(512.0) as usize;
    let max_length = max_length.min(model_max_length);
    let pad_id = config["pad_token_id"].as_u64().unwrap_or(0) as u32;
    let pad_token: String = tokenizer_config["pad_token"].as_str().unwrap_or("[PAD]").into();

    let mut tokenizer = tokenizer
        .with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            pad_token,
            pad_id,
            ..Default::default()
        }))
        .with_truncation(Some(TruncationParams {
            max_length,
            ..Default::default()
        }))
        .map_err(|e| format!("Failed to configure tokenizer: {}", e))?
        .clone();

    if let serde_json::Value::Object(root) = special_tokens_map {
        for (_, value) in root.iter() {
            if value.is_string() {
                tokenizer.add_special_tokens(&[AddedToken {
                    content: value.as_str().unwrap().into(),
                    special: true,
                    ..Default::default()
                }]);
            } else if value.is_object() {
                tokenizer.add_special_tokens(&[AddedToken {
                    content: value["content"].as_str().unwrap_or("").into(),
                    special: true,
                    single_word: value["single_word"].as_bool().unwrap_or(false),
                    lstrip: value["lstrip"].as_bool().unwrap_or(false),
                    rstrip: value["rstrip"].as_bool().unwrap_or(false),
                    normalized: value["normalized"].as_bool().unwrap_or(true),
                }]);
            }
        }
    }

    Ok(tokenizer.into())
}

/// L2-normalize an embedding vector. Replicated from fastembed `common.rs::normalize`.
fn normalize(v: &[f32]) -> Vec<f32> {
    let norm = (v.iter().map(|val| val * val).sum::<f32>()).sqrt();
    let epsilon = 1e-12;
    v.iter().map(|&val| val / (norm + epsilon)).collect()
}

/// Mean pooling over token embeddings weighted by the attention mask.
/// Replicated from fastembed `pooling.rs::mean`.
fn mean_pooling(
    token_embeddings: &ArrayView<f32, Dim<IxDynImpl>>,
    attention_mask_array: Array2<i64>,
) -> Result<Array2<f32>, Box<dyn std::error::Error>> {
    if token_embeddings.ndim() == 2 {
        // Already pooled within the model — (batch, hidden). Return as-is.
        return Ok(token_embeddings.slice(s![.., ..]).to_owned());
    } else if token_embeddings.ndim() != 3 {
        return Err(format!(
            "Invalid output shape: {:?}. Expected 2D or 3D tensor.",
            token_embeddings.dim()
        )
        .into());
    }

    let token_embeddings = token_embeddings.slice(s![.., .., ..]);

    // Broadcast mask (batch, seq) → (batch, seq, hidden) and mask the embeddings.
    let attention_mask = attention_mask_array
        .insert_axis(ndarray::Axis(2))
        .broadcast(token_embeddings.dim())
        .ok_or_else(|| "Could not broadcast attention mask to token embeddings shape".to_string())?
        .mapv(|x| x as f32);

    let masked_tensor = &attention_mask * &token_embeddings;
    let sum = masked_tensor.sum_axis(ndarray::Axis(1)); // (batch, hidden)
    let mask_sum = attention_mask.sum_axis(ndarray::Axis(1)); // (batch,)
    let mask_sum = mask_sum.mapv(|x| if x == 0f32 { 1.0 } else { x }); // zero-div guard
    Ok(&sum / &mask_sum)
}

impl Embedder for OrtEmbedder {
    fn embed_batch(
        &self,
        texts: &[String],
    ) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // 1. Tokenize
        let inputs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
        let encodings = self
            .tokenizer
            .encode_batch(inputs, true)
            .map_err(|e| format!("Tokenization failed: {}", e))?;
        if encodings.is_empty() {
            return Err("Tokenization returned empty encodings".into());
        }

        let batch_size = encodings.len();
        let encoding_length = encodings[0].len();
        let max_size = encoding_length * batch_size;

        // 2. Flatten ids / mask / type_ids into i64 vectors, then ndarray Array2.
        let mut ids_vec = Vec::with_capacity(max_size);
        let mut mask_vec = Vec::with_capacity(max_size);
        let mut type_ids_vec = Vec::with_capacity(max_size);
        for encoding in &encodings {
            ids_vec.extend(encoding.get_ids().iter().map(|x| *x as i64));
            mask_vec.extend(encoding.get_attention_mask().iter().map(|x| *x as i64));
            type_ids_vec.extend(encoding.get_type_ids().iter().map(|x| *x as i64));
        }
        let ids_array = Array::from_shape_vec((batch_size, encoding_length), ids_vec)
            .map_err(|e| format!("Failed to create ids array: {}", e))?;
        let mask_array = Array::from_shape_vec((batch_size, encoding_length), mask_vec)
            .map_err(|e| format!("Failed to create mask array: {}", e))?;
        let type_ids_array = Array::from_shape_vec((batch_size, encoding_length), type_ids_vec)
            .map_err(|e| format!("Failed to create type_ids array: {}", e))?;

        // 3. Build session inputs (mirrors fastembed impl.rs:335-345).
        let mut session_inputs = ort::inputs![
            "input_ids" => Value::from_array(ids_array)?,
            "attention_mask" => Value::from_array(mask_array.view())?,
        ]?;
        if self.need_token_type_ids {
            session_inputs.push((
                "token_type_ids".into(),
                Value::from_array(type_ids_array)?.into(),
            ));
        }

        // 4. Run inference
        let outputs = self
            .session
            .run(session_inputs)
            .map_err(|e| format!("ONNX inference failed: {}", e))?;

        // 5. Select output tensor. all-MiniLM-L6-v2 has a single output named
        //    "last_hidden_state"; fall back to the first output if the name isn't
        //    found (mirrors fastembed's OnlyOne/ByName precedence).
        let out_val = outputs
            .get("last_hidden_state")
            .or_else(|| outputs.keys().next().and_then(|k| outputs.get(k)))
            .ok_or_else(|| "No output tensor found in session outputs".to_string())?;

        let tensor_view = out_val
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract output tensor: {}", e))?;

        // 6. Mean pool + L2 normalize each row.
        let pooled = mean_pooling(&tensor_view, mask_array)?;
        let results: Vec<Vec<f32>> = pooled
            .rows()
            .into_iter()
            .map(|row| normalize(row.to_vec().as_slice()))
            .collect();

        Ok(results)
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }
}

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
        // ureq turns 4xx/5xx into `Err(Status, Response)` at `send_json` time.
        // We must read that response body here — otherwise the error surfaced
        // to the user is a bare "status code 500" with no Ollama/OpenAI reason,
        // making the failure undiagnosable (the symptom: "语义搜索不可用" with
        // `embed_status: batch_errors` and no cause).
        let resp = match req.send_json(body) {
            Ok(r) => r,
            Err(ureq::Error::Status(status, response)) => {
                let val: serde_json::Value =
                    response.into_json().unwrap_or(serde_json::Value::Null);
                return Err(format!(
                    "embedding endpoint returned {}: {}",
                    status,
                    extract_error_message(&val)
                )
                .into());
            }
            Err(e) => return Err(e.into()),
        };
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

    /// `OrtEmbedder` smoke test: construct from the HF cache, embed a few code
    /// snippets, and verify the embedding dimensions + finiteness. Skips silently
    /// when the model isn't in the cache (no network in unit tests). The
    /// numerical-equivalence check against the legacy fastembed backend was run
    /// during development (matched within 1e-4) before fastembed was removed.
    #[test]
    fn ort_embedder_embeds_from_cache() {
        let dir = match model_dir() {
            Ok(d) => d,
            Err(_) => return, // no cache dir → skip
        };
        if !dir.join("model.onnx").exists() {
            return; // model not downloaded → skip
        }

        let ort = OrtEmbedder::new().expect("OrtEmbedder::new failed");
        assert_eq!(ort.dim(), 384, "OrtEmbedder dim must be 384");
        assert_eq!(ort.model_name(), "fastembed:all-MiniLM-L6-v2");

        let texts: Vec<String> = vec![
            "function foo() {}".into(),
            "public class Bar {}".into(),
            "def baz(x): return x + 1".into(),
        ];
        let oe = ort.embed_batch(&texts).expect("ort embed_batch failed");
        assert_eq!(oe.len(), 3, "batch length mismatch");
        for (i, v) in oe.iter().enumerate() {
            assert_eq!(v.len(), 384, "vector {i} dim mismatch");
            assert!(v.iter().all(|x| x.is_finite()), "vector {i} contains non-finite values");
        }
    }
}