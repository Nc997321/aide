//! CpaGpt kind：CLIProxyAPI 中转。base_url 锁 http://127.0.0.1:8317（catalog）。
//! v1 env_vars 与 custom 同形（base_url 来自 catalog，auth_token 来自 cfg）。

use std::collections::HashMap;

use crate::runtime::provider::{mappings_to_env, ProviderConfig};

use super::{ActionDef, ActionResult, ConnectionStatus, ProviderStrategy};

const CPA_BASE_URL: &str = "http://127.0.0.1:8317";
const SMALL_FALLBACK: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy",
];

pub struct CpaGptStrategy;

impl ProviderStrategy for CpaGptStrategy {
    fn kind(&self) -> crate::runtime::provider::ProviderKind {
        crate::runtime::provider::ProviderKind::CpaGpt
    }
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), CPA_BASE_URL.into());
        if !cfg.auth_token.is_empty() { env.insert("ANTHROPIC_AUTH_TOKEN".into(), cfg.auth_token.clone()); }
        if !cfg.api_key.is_empty() { env.insert("ANTHROPIC_API_KEY".into(), cfg.api_key.clone()); }
        if !cfg.effort_level.is_empty() { env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), cfg.effort_level.clone()); }
        if !cfg.auto_compact_window.is_empty() { env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), cfg.auto_compact_window.clone()); }
        if !cfg.autocompact_pct_override.is_empty() { env.insert("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), cfg.autocompact_pct_override.clone()); }
        if !cfg.max_context_tokens.is_empty() { env.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), cfg.max_context_tokens.clone()); }
        env.extend(mappings_to_env(&cfg.model_mappings));
        env
    }
    fn fallback_env_keys(&self) -> &'static [&'static str] { SMALL_FALLBACK }
    fn actions(&self) -> Vec<ActionDef> {
        vec![
            ActionDef { name: "probe_port".into(), label: "探测端口".into() },
            ActionDef { name: "open_management".into(), label: "打开管理面板".into() },
            ActionDef { name: "codex_login_status".into(), label: "Codex 登录态".into() },
            ActionDef { name: "test_connection".into(), label: "测试连接".into() },
        ]
    }
    fn run_action(&self, _cfg: &ProviderConfig, action: &str) -> Result<ActionResult, String> {
        match action {
            "probe_port" => {
                let alive = probe_cpa_port();
                Ok(ActionResult::PortProbe { alive, detail: format!("{} {}", CPA_BASE_URL, if alive { "响应" } else { "无响应" }) })
            }
            "open_management" => Ok(ActionResult::OpenUrl(format!("{}/management.html", CPA_BASE_URL))),
            "codex_login_status" => {
                // v1：探测 CPA 活着 + 返回未知登录态（真实 codex 登录态读取需 CPA auth-dir 路径，
                // 用户未配 auth-dir 时无法判——返回 alive 作为近似）
                let alive = probe_cpa_port();
                Ok(ActionResult::LoginStatus { logged_in: alive, detail: format!("CPA {}", if alive { "在线" } else { "离线" }) })
            }
            other => Err(format!("action '{other}' not supported by CpaGpt")),
        }
    }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String> {
        super::common_test_connection(cfg, Some(CPA_BASE_URL))
    }
}

fn probe_cpa_port() -> bool {
    // 同步 TCP 连接探测 8317，1s 超时。放 spawn_blocking 里调（由 command 层保证）。
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = "127.0.0.1:8317";
    TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_secs(1)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

    fn cpa_cfg() -> ProviderConfig {
        ProviderConfig {
            id: "cpa".into(), kind: ProviderKind::CpaGpt,
            name: "".into(), icon: "".into(), base_url: "".into(),
            api_key: "".into(), auth_token: "sk-local-cpa".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), max_context_tokens: "".into(),
            known_models: vec![],
        }
    }

    #[test]
    fn cpa_env_vars_locks_base_url_to_8317() {
        let env = CpaGptStrategy.env_vars(&cpa_cfg());
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&CPA_BASE_URL.to_string()));
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN"), Some(&"sk-local-cpa".to_string()));
    }

    #[test]
    fn cpa_env_vars_injects_max_context_tokens_when_nonempty() {
        let mut p = cpa_cfg();
        p.max_context_tokens = "800000".into();
        let env = CpaGptStrategy.env_vars(&p);
        assert_eq!(env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"), Some(&"800000".to_string()));
    }

    #[test]
    fn cpa_base_url_ignores_cfg_base_url() {
        // 即使用户在 cfg 里塞了别的 base_url（不该有，但防御），策略仍锁 8317
        let mut p = cpa_cfg();
        p.base_url = "https://evil.example".into();
        let env = CpaGptStrategy.env_vars(&p);
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&CPA_BASE_URL.to_string()));
    }

    #[test]
    fn cpa_fallback_is_small_set() {
        assert_eq!(CpaGptStrategy.fallback_env_keys(), SMALL_FALLBACK);
    }

    #[test]
    fn cpa_open_management_returns_management_url() {
        let res = CpaGptStrategy.run_action(&cpa_cfg(), "open_management").unwrap();
        match res {
            ActionResult::OpenUrl(u) => assert_eq!(u, "http://127.0.0.1:8317/management.html"),
            other => panic!("expected OpenUrl, got {:?}", other),
        }
    }

    #[test]
    fn cpa_unsupported_action_errors() {
        assert!(CpaGptStrategy.run_action(&cpa_cfg(), "nope").is_err());
    }
}
