use serde::{Deserialize, Serialize};

/// Embedder 运行时配置 DTO（原 `commands::settings::RuntimeCodeGraphEmbedderConfig`）。
///
/// 单一数据主人迁到 codegraph-core：主进程从 SettingsService 解析出它、随
/// `build_index` 请求序列化发给 runner；runner 拿它构造/复用 embedder。它同时
/// 是 settings 面板 JSON 的落盘形状（serde 键与前端 `codegraphEmbedder` 块一致），
/// 所以字段命名保持 camelCase 兼容。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeCodeGraphEmbedderConfig {
    pub backend: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub format: String,
    pub dim: u32,
    pub score_threshold: Option<f32>,
}

impl Default for RuntimeCodeGraphEmbedderConfig {
    /// 零配置默认：本地 ONNX（all-MiniLM-L6-v2）。与原 settings 层的默认值一致。
    fn default() -> Self {
        Self {
            backend: "fastembed".to_string(),
            base_url: String::new(),
            api_key: String::new(),
            model: "nomic-embed-text".to_string(),
            format: "ollama".to_string(),
            dim: 0,
            score_threshold: None,
        }
    }
}

/// 每后端默认语义搜索分数阈值。用户未覆盖时使用。
/// 从 `query::semantic` 移入 core：主进程的 query_score_threshold 与 runner 的
/// 语义查询共用同一份判定，避免两处漂移。
pub fn default_score_threshold(backend: &str) -> f32 {
    if backend == "http" {
        0.55
    } else {
        0.35
    }
}

/// 生效阈值：用户覆盖优先，否则按后端取默认。
pub fn effective_score_threshold(cfg: &RuntimeCodeGraphEmbedderConfig) -> f32 {
    cfg.score_threshold
        .unwrap_or_else(|| default_score_threshold(&cfg.backend))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_cfg(backend: &str, score_threshold: Option<f32>) -> RuntimeCodeGraphEmbedderConfig {
        RuntimeCodeGraphEmbedderConfig {
            backend: backend.to_string(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            format: String::new(),
            dim: 0,
            score_threshold,
        }
    }

    #[test]
    fn effective_score_threshold_defaults_and_override() {
        assert_eq!(
            effective_score_threshold(&runtime_cfg("fastembed", None)),
            0.35
        );
        assert_eq!(effective_score_threshold(&runtime_cfg("http", None)), 0.55);
        // Some(v) → 用户覆盖优先
        assert_eq!(
            effective_score_threshold(&runtime_cfg("fastembed", Some(0.42))),
            0.42
        );
        assert_eq!(
            effective_score_threshold(&runtime_cfg("http", Some(0.2))),
            0.2
        );
    }

    /// DTO 必须可序列化过 stdio 协议（build_index 请求参数）。
    #[test]
    fn config_roundtrips_through_json() {
        let cfg = RuntimeCodeGraphEmbedderConfig {
            backend: "http".into(),
            base_url: "http://127.0.0.1:11434".into(),
            api_key: "".into(),
            model: "bge-m3".into(),
            format: "ollama".into(),
            dim: 1024,
            score_threshold: Some(0.5),
        };
        let v = serde_json::to_value(&cfg).unwrap();
        let back: RuntimeCodeGraphEmbedderConfig = serde_json::from_value(v).unwrap();
        assert_eq!(back.model, "bge-m3");
        assert_eq!(back.dim, 1024);
        assert_eq!(back.score_threshold, Some(0.5));
    }
}
