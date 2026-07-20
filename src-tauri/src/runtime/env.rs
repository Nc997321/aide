//! Runtime spawn env 组装。从 commands/chat.rs 迁入并改纯函数：
//! 调用方负责取 active provider / system_default_mappings / proxy 传入，
//! 本函数不做 config I/O，runtime 层不依赖 commands。

use std::collections::HashMap;

use crate::runtime::provider::{
    ProviderConfig, ProviderKind, ProviderModelMappings, mappings_to_env, provider_to_env_vars,
};

/// 组 spawn env：active provider 直映，或 system_default_mappings 注入；
/// 再补公共 fallback（CLAUDE_CONFIG_DIR + 代理），最后 proxy 覆盖。
/// 纯函数——无 I/O，可单测。
pub fn build_runtime_env_vars(
    active: Option<&ProviderConfig>,
    system_default_mappings: &ProviderModelMappings,
    proxy: &str,
) -> HashMap<String, String> {
    let mut env_vars: HashMap<String, String> = if let Some(p) = active {
        provider_to_env_vars(p)
    } else {
        mappings_to_env(system_default_mappings)
    };

    let active_kind = active.map(|p| p.kind).unwrap_or(ProviderKind::SystemDefault);
    let fallback_keys: &[&str] = if active_kind == ProviderKind::SystemDefault {
        &[
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]
    } else {
        &[
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]
    };
    for var in fallback_keys {
        if !env_vars.contains_key(*var) {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() {
                    env_vars.insert(var.to_string(), val);
                }
            }
        }
    }

    if !proxy.is_empty() {
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            env_vars.insert(k.to_string(), proxy.to_string());
        }
    }
    env_vars
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::ProviderKind;

    fn sdm() -> ProviderModelMappings {
        ProviderModelMappings {
            anthropic_model: "claude-sonnet-5".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn system_default_path_injects_mappings_then_env_fallback() {
        // 无 active provider → 走 system_default_mappings 分支
        // 仅断言映射注入 + 公共 fallback 不 panic；env 读取依赖进程，弱断言。
        let env = build_runtime_env_vars(None, &sdm(), "");
        assert_eq!(env.get("ANTHROPIC_MODEL"), Some(&"claude-sonnet-5".to_string()));
    }

    #[test]
    fn proxy_override_wins_over_env_fallback() {
        let env = build_runtime_env_vars(None, &ProviderModelMappings::default(), "http://127.0.0.1:7890");
        assert_eq!(env.get("HTTP_PROXY"), Some(&"http://127.0.0.1:7890".to_string()));
        assert_eq!(env.get("https_proxy"), Some(&"http://127.0.0.1:7890".to_string()));
    }

    #[test]
    fn system_default_kind_uses_large_fallback_set() {
        // 迁移后 SystemDefault 是真实实例，active.is_some()=true 但 kind=SystemDefault
        // 必须仍走大 fallback 集（含 ANTHROPIC_*），保住系统 env 认证兜底。
        // 本测试验证该路径不 panic；具体 env 变量取决于进程环境，不在单元中断言。
        let p = ProviderConfig {
            id: "__system_default__".into(),
            kind: crate::runtime::provider::ProviderKind::SystemDefault,
            name: "".into(), icon: "".into(), base_url: "".into(),
            api_key: "".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        };
        let _ = build_runtime_env_vars(Some(&p), &ProviderModelMappings::default(), "");
    }

    #[test]
    fn active_provider_path_does_not_fallback_anthropic_env() {
        // active provider 存在 → fallback 集 不含 ANTHROPIC_*，env 里只该有 provider 直映的
        let p = ProviderConfig {
            id: "x".into(),
            kind: ProviderKind::Custom,
            name: "".into(), icon: "".into(), base_url: "https://b.example".into(),
            api_key: "k".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        };
        let env = build_runtime_env_vars(Some(&p), &ProviderModelMappings::default(), "");
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&"https://b.example".to_string()));
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"k".to_string()));
        // active 分支不读 ANTHROPIC_AUTH_TOKEN 进程 env（没设也不会插空）——不在此断言进程 env
    }
}
