//! Runtime spawn env 组装。从 commands/chat.rs 迁入并改纯函数：
//! 调用方负责取 active provider / proxy 传入，
//! 本函数不做 config I/O，runtime 层不依赖 commands。

use std::collections::HashMap;

use crate::runtime::provider::ProviderConfig;

/// 组 spawn env：active provider 直映；
/// 再补公共 fallback（CLAUDE_CONFIG_DIR + 代理），最后 proxy 覆盖。
/// 纯函数——无 I/O，可单测。
pub fn build_runtime_env_vars(
    active: &ProviderConfig,
    proxy: &str,
) -> HashMap<String, String> {
    use crate::runtime::provider::strategy::strategy_for;
    let strat = strategy_for(active.kind);
    let mut env_vars = strat.env_vars(active);

    for var in strat.fallback_env_keys() {
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
    use crate::runtime::provider::{ProviderKind, ProviderModelMappings};

    #[test]
    fn system_default_kind_uses_large_fallback_set() {
        // SystemDefault kind 必须仍走大 fallback 集（含 ANTHROPIC_*），保住系统 env 认证兜底。
        // 本测试验证该路径不 panic；具体 env 变量取决于进程环境，不在单元中断言。
        let p = ProviderConfig {
            id: "__system_default__".into(),
            kind: ProviderKind::SystemDefault,
            name: "".into(), icon: "".into(), base_url: "".into(),
            api_key: "".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        };
        let _ = build_runtime_env_vars(&p, "");
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
        let env = build_runtime_env_vars(&p, "");
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&"https://b.example".to_string()));
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"k".to_string()));
        // active 分支不读 ANTHROPIC_AUTH_TOKEN 进程 env（没设也不会插空）——不在此断言进程 env
    }
}
