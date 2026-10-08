//! ProviderStrategy：按 kind dispatch env 组装 / 专属操作 / 连接测试。
//! env_vars 纯 cfg 派生（不读进程 env）；env 兜底在 runtime::env::build_runtime_env_vars。

use std::collections::HashMap;

use crate::provider::{
    mappings_to_env, ProviderConfig, ProviderKind, ProviderModelMappings,
};

// Task 8-10 脚手架：ActionDef / actions() 届时会被 UI 动作面板使用，当前保留类型契约。
#[allow(dead_code)]
pub struct ActionDef {
    pub name: String,
    pub label: String,
}

// Task 8-10 脚手架：Quota / Ok 等变体用于后续 provider 动作面板，当前保留类型契约。
#[allow(dead_code)]
#[derive(Debug, serde::Serialize)]
pub enum ActionResult {
    PortProbe { alive: bool, detail: String },
    OpenUrl(String),
    LoginStatus { logged_in: bool, detail: String },
    RefreshedModels(ProviderModelMappings),
    Quota(serde_json::Value),
    Ok(String),
}

#[derive(serde::Serialize)]
pub struct ConnectionStatus {
    pub ok: bool,
    pub detail: String,
}

pub trait ProviderStrategy: Send + Sync {
    fn kind(&self) -> ProviderKind;
    /// 纯 cfg 派生的 env（不读 std::env）。
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String>;
    /// build_runtime_env_vars 用它决定从进程 env 兜底哪些 key。
    fn fallback_env_keys(&self) -> &'static [&'static str];
    // Task 8-10 脚手架：动作列表面板届时会调用，当前保留 trait 契约。
    #[allow(dead_code)]
    fn actions(&self) -> Vec<ActionDef> {
        Vec::new()
    }
    fn run_action(&self, _cfg: &ProviderConfig, action: &str) -> Result<ActionResult, String> {
        Err(format!(
            "action '{action}' not supported by {:?} kind",
            self.kind()
        ))
    }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String>;
}

const SMALL_FALLBACK: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// 共享预置策略：base_url 来自 catalog（非空），api_key 认证，仅 test_connection。
pub(crate) struct PresetStrategy {
    pub kind: ProviderKind,
    pub base_url: String,
}

impl ProviderStrategy for PresetStrategy {
    fn kind(&self) -> ProviderKind {
        self.kind
    }
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), self.base_url.clone());
        if !cfg.api_key.is_empty() {
            env.insert("ANTHROPIC_API_KEY".into(), cfg.api_key.clone());
        }
        if !cfg.auth_token.is_empty() {
            env.insert("ANTHROPIC_AUTH_TOKEN".into(), cfg.auth_token.clone());
        }
        if !cfg.effort_level.is_empty() {
            env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), cfg.effort_level.clone());
        }
        if !cfg.auto_compact_window.is_empty() {
            env.insert(
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(),
                cfg.auto_compact_window.clone(),
            );
        }
        if !cfg.autocompact_pct_override.is_empty() {
            env.insert(
                "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(),
                cfg.autocompact_pct_override.clone(),
            );
        }
        if !cfg.max_context_tokens.is_empty() {
            env.insert(
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(),
                cfg.max_context_tokens.clone(),
            );
        }
        env.extend(mappings_to_env(&cfg.model_mappings));
        env
    }
    fn fallback_env_keys(&self) -> &'static [&'static str] {
        SMALL_FALLBACK
    }
    fn actions(&self) -> Vec<ActionDef> {
        vec![ActionDef {
            name: "test_connection".into(),
            label: "测试连接".into(),
        }]
    }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String> {
        common_test_connection(cfg, Some(&self.base_url))
    }
}

pub mod cpa_gpt;
pub mod custom;
pub mod deepseek;
pub mod kimi;
pub mod ollama;
pub mod qwen;
pub mod system_default;
pub mod zhipu;

pub fn strategy_for(kind: ProviderKind) -> Box<dyn ProviderStrategy> {
    match kind {
        ProviderKind::Custom => Box::new(custom::CustomStrategy),
        ProviderKind::SystemDefault => {
            Box::new(crate::provider::strategy::system_default::SystemDefaultStrategy)
        }
        ProviderKind::CpaGpt => {
            Box::new(crate::provider::strategy::cpa_gpt::CpaGptStrategy)
        }
        ProviderKind::Ollama => crate::provider::strategy::ollama::strategy(),
        ProviderKind::Kimi => crate::provider::strategy::kimi::strategy(),
        ProviderKind::DeepSeek => crate::provider::strategy::deepseek::strategy(),
        ProviderKind::Zhipu => crate::provider::strategy::zhipu::strategy(),
        ProviderKind::Qwen => crate::provider::strategy::qwen::strategy(),
    }
}

/// 通用连接测试：发一个最小 Anthropic /v1/messages 请求验证端点+凭证。
/// `base_url_override`：预置 kind 传 catalog 的 base_url；None 则用 cfg.base_url / 默认。
pub(crate) fn common_test_connection(
    cfg: &ProviderConfig,
    base_url_override: Option<&str>,
) -> Result<ConnectionStatus, String> {
    use crate::proxy::detect_proxy;
    use std::time::Duration;

    let base_url = base_url_override
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            if cfg.base_url.is_empty() {
                None
            } else {
                Some(cfg.base_url.clone())
            }
        })
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());

    let (auth_name, auth_val): (&str, String) = if !cfg.api_key.is_empty() {
        ("x-api-key", cfg.api_key.clone())
    } else if !cfg.auth_token.is_empty() {
        ("Authorization", format!("Bearer {}", cfg.auth_token))
    } else {
        return Ok(ConnectionStatus {
            ok: false,
            detail: "no api_key / auth_token configured".to_string(),
        });
    };

    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(10));
    if let Some(proxy_url) = detect_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy_url) {
            builder = builder.proxy(p);
        }
    }
    let agent = builder.build();
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let resp = agent
        .get(&url) // 用 GET 探活，避免构造 messages body；部分网关可能 405，仍算"活着"
        .set(auth_name, &auth_val)
        .set("anthropic-version", "2023-06-01")
        .call();
    match resp {
        Ok(r) => Ok(ConnectionStatus {
            ok: true,
            detail: format!("HTTP {}", r.status()),
        }),
        Err(ureq::Error::Status(code, _)) => Ok(ConnectionStatus {
            ok: true,
            detail: format!("HTTP {code}（端点活着，鉴权/路径可能需调整）"),
        }),
        Err(e) => Ok(ConnectionStatus {
            ok: false,
            detail: format!("连接失败: {e}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_for_returns_some_for_every_kind() {
        for k in [
            ProviderKind::Custom,
            ProviderKind::SystemDefault,
            ProviderKind::CpaGpt,
            ProviderKind::Ollama,
            ProviderKind::Kimi,
            ProviderKind::DeepSeek,
            ProviderKind::Zhipu,
            ProviderKind::Qwen,
        ] {
            let s = strategy_for(k);
            assert_eq!(
                s.kind(),
                k,
                "strategy_for({:?}) must return a strategy whose kind matches",
                k
            );
        }
    }
}
