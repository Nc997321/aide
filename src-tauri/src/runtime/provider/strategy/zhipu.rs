//! Zhipu（智谱）kind：catalog 预置 base_url，api_key 认证（x-api-key），仅 test_connection。

use super::{PresetStrategy, ProviderStrategy};
use crate::runtime::provider::{catalog::catalog_find, ProviderKind};

pub fn strategy() -> Box<dyn ProviderStrategy> {
    let base_url = catalog_find(ProviderKind::Zhipu)
        .map(|p| p.base_url.clone())
        .unwrap_or_else(|| "https://open.bigmodel.cn/api/anthropic".to_string());
    Box::new(PresetStrategy {
        kind: ProviderKind::Zhipu,
        base_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderModelMappings};

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            id: "x".into(),
            kind: ProviderKind::Zhipu,
            name: "".into(),
            icon: "".into(),
            base_url: "".into(),
            api_key: "k".into(),
            auth_token: "".into(),
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
    fn zhipu_env_vars_uses_catalog_base_url() {
        let env = strategy().env_vars(&cfg());
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL"),
            Some(&"https://open.bigmodel.cn/api/anthropic".to_string())
        );
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"k".to_string()));
        assert!(
            env.get("ANTHROPIC_AUTH_TOKEN").is_none(),
            "Zhipu 走 x-api-key，不应注入 Bearer token"
        );
    }

    #[test]
    fn zhipu_actions_only_test_connection() {
        let a = strategy().actions();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "test_connection");
    }
}
