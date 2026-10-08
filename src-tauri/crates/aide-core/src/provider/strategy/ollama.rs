//! Ollama kind：catalog 预置 base_url，auth_token 认证（Authorization: Bearer），仅 test_connection。

use super::{PresetStrategy, ProviderStrategy};
use crate::provider::{catalog::catalog_find, ProviderKind};

pub fn strategy() -> Box<dyn ProviderStrategy> {
    let base_url = catalog_find(ProviderKind::Ollama)
        .map(|p| p.base_url.clone())
        .unwrap_or_else(|| "https://ollama.com".to_string());
    Box::new(PresetStrategy {
        kind: ProviderKind::Ollama,
        base_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ProviderConfig, ProviderModelMappings};

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            id: "x".into(),
            kind: ProviderKind::Ollama,
            name: "".into(),
            icon: "".into(),
            base_url: "".into(),
            api_key: "".into(),
            auth_token: "k".into(),
            model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(),
            auto_compact_window: "".into(),
            autocompact_pct_override: "".into(),
            max_context_tokens: "".into(),
            known_models: vec![],
        }
    }

    #[test]
    fn ollama_env_vars_uses_catalog_base_url() {
        let env = strategy().env_vars(&cfg());
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL"),
            Some(&"https://ollama.com".to_string())
        );
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN"), Some(&"k".to_string()));
        assert!(
            env.get("ANTHROPIC_API_KEY").is_none(),
            "Ollama 走 Bearer，不应注入 x-api-key"
        );
    }

    #[test]
    fn ollama_actions_only_test_connection() {
        let a = strategy().actions();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "test_connection");
    }

    /// PresetStrategy（ollama/kimi/deepseek 共用 env_vars）注入 max_context_tokens：非空才注入。
    /// 空臂在此断言，system_default/cpa_gpt 同形 if 非空才注入逻辑的空臂由本测试代表。
    #[test]
    fn ollama_env_vars_injects_max_context_tokens_when_nonempty() {
        let mut c = cfg();
        c.max_context_tokens = "800000".into();
        let env = strategy().env_vars(&c);
        assert_eq!(
            env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"),
            Some(&"800000".to_string())
        );
    }

    #[test]
    fn ollama_env_vars_omits_max_context_tokens_when_empty() {
        assert!(strategy()
            .env_vars(&cfg())
            .get("CLAUDE_CODE_MAX_CONTEXT_TOKENS")
            .is_none());
    }
}
