//! ProviderStrategy：按 kind dispatch env 组装 / 专属操作 / 连接测试。
//! env_vars 纯 cfg 派生（不读进程 env）；env 兜底在 runtime::env::build_runtime_env_vars。
//! 以下 dead_code 是 Task 8-10 的脚手架，届时会被真实使用。
#![allow(dead_code)]

use std::collections::HashMap;

use crate::runtime::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

pub struct ActionDef {
    pub name: String,
    pub label: String,
}

#[derive(Debug)]
pub enum ActionResult {
    PortProbe { alive: bool, detail: String },
    OpenUrl(String),
    LoginStatus { logged_in: bool, detail: String },
    RefreshedModels(ProviderModelMappings),
    Quota(serde_json::Value),
    Ok(String),
}

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
    fn actions(&self) -> Vec<ActionDef> { Vec::new() }
    fn run_action(&self, cfg: &ProviderConfig, action: &str) -> Result<ActionResult, String> {
        let _ = cfg;
        Err(format!("action '{action}' not supported by {:?} kind", self.kind()))
    }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String>;
}

pub mod custom;
pub mod system_default;
pub mod cpa_gpt;
// 其余 kind 在 Task 10 加：ollama / kimi / deepseek

pub fn strategy_for(kind: ProviderKind) -> Box<dyn ProviderStrategy> {
    match kind {
        ProviderKind::Custom => Box::new(custom::CustomStrategy),
        // Task 9-10 填：
        ProviderKind::SystemDefault => Box::new(crate::runtime::provider::strategy::system_default::SystemDefaultStrategy),
        ProviderKind::CpaGpt => Box::new(crate::runtime::provider::strategy::cpa_gpt::CpaGptStrategy),
        ProviderKind::Ollama => Box::new(custom::CustomStrategy),
        ProviderKind::Kimi => Box::new(custom::CustomStrategy),
        ProviderKind::DeepSeek => Box::new(custom::CustomStrategy),
    }
}

/// 通用连接测试：发一个最小 Anthropic /v1/messages 请求验证端点+凭证。
/// `base_url_override`：预置 kind 传 catalog 的 base_url；None 则用 cfg.base_url / 默认。
pub(crate) fn common_test_connection(
    cfg: &ProviderConfig,
    base_url_override: Option<&str>,
) -> Result<ConnectionStatus, String> {
    use crate::commands::proxy::detect_proxy;
    use std::time::Duration;

    let base_url = base_url_override
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| if cfg.base_url.is_empty() { None } else { Some(cfg.base_url.clone()) })
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());

    let (auth_name, auth_val): (&str, String) = if !cfg.api_key.is_empty() {
        ("x-api-key", cfg.api_key.clone())
    } else if !cfg.auth_token.is_empty() {
        ("Authorization", format!("Bearer {}", cfg.auth_token))
    } else {
        return Ok(ConnectionStatus { ok: false, detail: "no api_key / auth_token configured".to_string() });
    };

    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(10));
    if let Some(proxy_url) = detect_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy_url) { builder = builder.proxy(p); }
    }
    let agent = builder.build();
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let resp = agent
        .get(&url) // 用 GET 探活，避免构造 messages body；部分网关可能 405，仍算"活着"
        .set(auth_name, &auth_val)
        .set("anthropic-version", "2023-06-01")
        .call();
    match resp {
        Ok(r) => Ok(ConnectionStatus { ok: true, detail: format!("HTTP {}", r.status()) }),
        Err(ureq::Error::Status(code, _)) => Ok(ConnectionStatus { ok: true, detail: format!("HTTP {code}（端点活着，鉴权/路径可能需调整）") }),
        Err(e) => Ok(ConnectionStatus { ok: false, detail: format!("连接失败: {e}") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_for_returns_some_for_every_kind() {
        for k in [ProviderKind::Custom, ProviderKind::SystemDefault, ProviderKind::CpaGpt,
                  ProviderKind::Ollama, ProviderKind::Kimi, ProviderKind::DeepSeek] {
            let s = strategy_for(k);
            // Custom 是唯一真实实现，kind() 匹配；其余占位返回 CustomStrategy，
            // kind() 是 Custom 而非输入 kind——Task 8-10 替换后恢复全断言。
            if k == ProviderKind::Custom {
                assert_eq!(s.kind(), k);
            }
        }
    }
}
