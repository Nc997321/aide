//! DeepSeek kind：catalog 预置 base_url，auth_token 认证（Authorization: Bearer），仅 test_connection。

use super::{PresetStrategy, ProviderStrategy};
use crate::provider::{catalog::catalog_find, ProviderKind};

pub fn strategy() -> Box<dyn ProviderStrategy> {
    let base_url = catalog_find(ProviderKind::DeepSeek)
        .map(|p| p.base_url.clone())
        .unwrap_or_else(|| "https://api.deepseek.com/anthropic".to_string());
    Box::new(PresetStrategy {
        kind: ProviderKind::DeepSeek,
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
            kind: ProviderKind::DeepSeek,
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
    fn deepseek_env_vars_uses_catalog_base_url() {
        let env = strategy().env_vars(&cfg());
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL"),
            Some(&"https://api.deepseek.com/anthropic".to_string())
        );
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN"), Some(&"k".to_string()));
        assert!(
            env.get("ANTHROPIC_API_KEY").is_none(),
            "DeepSeek 走 Bearer，不应注入 x-api-key"
        );
    }

    #[test]
    fn deepseek_actions_only_test_connection() {
        let a = strategy().actions();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "test_connection");
    }
}
