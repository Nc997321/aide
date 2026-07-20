//! Kimi kind：catalog 预置 base_url，api_key 认证，仅 test_connection。

use super::{PresetStrategy, ProviderStrategy};
use crate::runtime::provider::{ProviderKind, catalog::catalog_find};

pub fn strategy() -> Box<dyn ProviderStrategy> {
    let base_url = catalog_find(ProviderKind::Kimi)
        .map(|p| p.base_url.clone())
        .unwrap_or_else(|| "https://api.kimi.com/coding/".to_string());
    Box::new(PresetStrategy { kind: ProviderKind::Kimi, base_url })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderModelMappings};

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            id: "x".into(), kind: ProviderKind::Kimi,
            name: "".into(), icon: "".into(), base_url: "".into(),
            api_key: "k".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        }
    }

    #[test]
    fn kimi_env_vars_uses_catalog_base_url() {
        let env = strategy().env_vars(&cfg());
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&"https://api.kimi.com/coding/".to_string()));
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"k".to_string()));
    }

    #[test]
    fn kimi_actions_only_test_connection() {
        let a = strategy().actions();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "test_connection");
    }
}
