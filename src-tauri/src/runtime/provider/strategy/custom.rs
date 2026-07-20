//! Custom kind：base_url/name/icon 用户填，无专属操作。
//! env_vars 直映 cfg（与历史 provider_to_env_vars 完全一致——这是回归基线）。

use std::collections::HashMap;

use crate::runtime::provider::{ProviderConfig, provider_to_env_vars};

use super::{ConnectionStatus, ProviderStrategy};

pub struct CustomStrategy;

const SMALL_FALLBACK: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy",
];

impl ProviderStrategy for CustomStrategy {
    fn kind(&self) -> crate::runtime::provider::ProviderKind {
        crate::runtime::provider::ProviderKind::Custom
    }
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String> {
        provider_to_env_vars(cfg) // 复用既有直映函数，保证回归一致
    }
    fn fallback_env_keys(&self) -> &'static [&'static str] { SMALL_FALLBACK }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String> {
        crate::runtime::provider::strategy::common_test_connection(cfg, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            id: "x".into(), kind: ProviderKind::Custom,
            name: "".into(), icon: "".into(), base_url: "https://gw.example".into(),
            api_key: "k".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        }
    }

    #[test]
    fn custom_env_vars_matches_legacy_provider_to_env_vars() {
        // 回归基线：Custom 的 env_vars 必须与历史 provider_to_env_vars 逐字段一致
        let p = cfg();
        assert_eq!(CustomStrategy.env_vars(&p), crate::runtime::provider::provider_to_env_vars(&p));
    }

    #[test]
    fn custom_fallback_is_small_set() {
        assert_eq!(CustomStrategy.fallback_env_keys(), &[
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]);
    }

    #[test]
    fn custom_test_connection_no_credentials_returns_false() {
        let mut p = cfg();
        p.api_key = "".into();
        p.auth_token = "".into();
        let s = CustomStrategy.test_connection(&p).unwrap();
        assert!(!s.ok);
        assert!(s.detail.contains("no api_key"));
    }
}
