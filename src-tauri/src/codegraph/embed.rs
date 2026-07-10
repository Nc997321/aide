use fastembed::{
    EmbeddingModel, InitOptions, Pooling, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};
use std::path::PathBuf;
use std::sync::Mutex;

/// Wraps fastembed-rs TextEmbedding model. Loads ONNX model from local cache,
/// falling back to hf_hub download only if local files are missing.
pub struct Embedder {
    model: Mutex<TextEmbedding>,
}

/// Directory containing the 5 model files.
fn model_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Check HF_HOME first, then default
    let hf_home = std::env::var("HF_HOME")
        .or_else(|_| std::env::var("HOME").map(|h| h + "/.cache/huggingface"))
        .or_else(|_| std::env::var("USERPROFILE").map(|u| u + "/.cache/huggingface"))
        .map(PathBuf::from)?;

    let dir = hf_home
        .join("hub")
        .join("models--Qdrant--all-MiniLM-L6-v2-onnx")
        .join("snapshots");

    // Find the first snapshot directory
    let snapshots = std::fs::read_dir(&dir).ok()
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

impl Embedder {
    /// Create embedder with all-MiniLM-L6-v2 (384-dim).
    /// Tries hf_hub first; falls back to local files from HF cache.
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        // Try hf_hub first (works when network is available)
        if let Ok(model) = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::AllMiniLML6V2),
        ) {
            return Ok(Self { model: Mutex::new(model) });
        }

        // Fall back to local files — bypass hf_hub entirely
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

        let user_model = UserDefinedEmbeddingModel::new(onnx, tokenizer_files)
            .with_pooling(Pooling::Mean);

        let model = TextEmbedding::try_new_from_user_defined(
            user_model,
            fastembed::InitOptionsUserDefined::new(),
        )?;

        Ok(Self { model: Mutex::new(model) })
    }

    /// Embed a batch of text chunks into 384-dim vectors.
    pub fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
        let model = self.model.lock().unwrap();
        let embeddings = model.embed(texts.to_vec(), None)?;
        Ok(embeddings)
    }

    /// Embed a single text chunk.
    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let batches = self.embed_batch(&[text.to_string()])?;
        Ok(batches.into_iter().next().unwrap_or_default())
    }

    pub fn dim(&self) -> usize {
        384
    }
}
