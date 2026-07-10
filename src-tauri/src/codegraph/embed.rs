use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::sync::Mutex;

/// Wraps fastembed-rs TextEmbedding model. The model is loaded once and reused.
/// First construction downloads ~23 MB `all-MiniLM-L6-v2` ONNX model from HuggingFace
/// if not cached locally.
pub struct Embedder {
    model: Mutex<TextEmbedding>,
}

impl Embedder {
    /// Create embedder with default model (all-MiniLM-L6-v2, 384-dim).
    /// Blocks briefly on first call while model loads; subsequent calls are fast.
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::AllMiniLML6V2)
        )?;
        Ok(Self {
            model: Mutex::new(model),
        })
    }

    /// Embed a batch of text chunks into 384-dim vectors.
    /// Returns vectors in the same order as `texts`.
    pub fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
        let model = self.model.lock().unwrap();
        // fastembed accepts &[&str] or &[String] — pass owned Strings
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
