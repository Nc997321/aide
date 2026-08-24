//! SystemDefault kind：Anthropic 官方。base_url 空（SDK 默认）。
//! env_vars 只注入 model_mappings + 凭证（凭证通常空，靠进程 env 兜底——
//! 大 fallback 集在 build_runtime_env_vars 里补 ANTHROPIC_* from env）。

use std::collections::HashMap;

use crate::runtime::provider::{mappings_to_env, ProviderConfig, ProviderModelMappings};

use super::{ActionDef, ActionResult, ConnectionStatus, ProviderStrategy};

const LARGE_FALLBACK: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];

pub struct SystemDefaultStrategy;

impl ProviderStrategy for SystemDefaultStrategy {
    fn kind(&self) -> crate::runtime::provider::ProviderKind {
        crate::runtime::provider::ProviderKind::SystemDefault
    }

    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String> {
        let mut env = mappings_to_env(&cfg.model_mappings);
        // 凭证非空才注入（通常空，靠 env 兜底）
        if !cfg.api_key.is_empty() {
            env.insert("ANTHROPIC_API_KEY".into(), cfg.api_key.clone());
        }
        if !cfg.auth_token.is_empty() {
            env.insert("ANTHROPIC_AUTH_TOKEN".into(), cfg.auth_token.clone());
        }
        // effort / compact（与 custom 同形）
        if !cfg.effort_level.is_empty() {
            env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), cfg.effort_level.clone());
        }
        if !cfg.auto_compact_window.is_empty() {
            env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), cfg.auto_compact_window.clone());
        }
        if !cfg.autocompact_pct_override.is_empty() {
            env.insert("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), cfg.autocompact_pct_override.clone());
        }
        if !cfg.max_context_tokens.is_empty() {
            env.insert("CLAUDE_CODE_MAX_CONTEXT_TOKENS".into(), cfg.max_context_tokens.clone());
        }
        // base_url 不注入（SDK 默认）；靠 env 兜底
        env
    }

    fn fallback_env_keys(&self) -> &'static [&'static str] {
        LARGE_FALLBACK
    }

    fn actions(&self) -> Vec<ActionDef> {
        vec![
            ActionDef { name: "refresh_models".into(), label: "刷新模型列表".into() },
            ActionDef { name: "view_quota".into(), label: "查看额度".into() },
            ActionDef { name: "test_connection".into(), label: "测试连接".into() },
        ]
    }

    fn run_action(&self, cfg: &ProviderConfig, action: &str) -> Result<ActionResult, String> {
        match action {
            "refresh_models" => {
                let m = refresh_models_blocking(cfg)?;
                Ok(ActionResult::RefreshedModels(m))
            }
            "view_quota" => Err("view_quota 尚未实现（v1）".to_string()),
            other => Err(format!("action '{other}' not supported by SystemDefault")),
        }
    }

    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String> {
        // base_url 走 env 兜底（不传 override → common_test_connection 用 cfg.base_url/默认）
        super::common_test_connection(cfg, None)
    }
}

/// 调 Anthropic GET /v1/models，按省钱档映射返回 mappings。纯逻辑（不写盘）。
/// 认证：优先 cfg.api_key/auth_token，否则进程 env 兜底。
pub fn refresh_models_blocking(cfg: &ProviderConfig) -> Result<ProviderModelMappings, String> {
    use crate::commands::proxy::detect_proxy;
    use std::time::Duration;

    let api_key = if !cfg.api_key.is_empty() {
        Some(cfg.api_key.clone())
    } else {
        std::env::var("ANTHROPIC_API_KEY").ok().filter(|s| !s.is_empty())
    };
    let auth_token = if !cfg.auth_token.is_empty() {
        Some(cfg.auth_token.clone())
    } else {
        std::env::var("ANTHROPIC_AUTH_TOKEN").ok().filter(|s| !s.is_empty())
    };
    let base_url = if !cfg.base_url.is_empty() {
        cfg.base_url.clone()
    } else {
        std::env::var("ANTHROPIC_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://api.anthropic.com".to_string())
    };

    let (auth_name, auth_val): (&str, String) = match (api_key, auth_token) {
        (Some(k), _) => ("x-api-key", k),
        (_, Some(t)) => ("Authorization", format!("Bearer {t}")),
        (None, None) => return Ok(cfg.model_mappings.clone()), // 无认证：保留旧值
    };

    let mut agent_builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(10));
    if let Some(proxy_url) = detect_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy_url) {
            agent_builder = agent_builder.proxy(p);
        }
    }
    let agent = agent_builder.build();
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let resp = agent
        .get(&url)
        .set(auth_name, &auth_val)
        .call()
        .map_err(|e| format!("API 请求失败: {e}"))?;
    let body: serde_json::Value = resp.into_json().map_err(|e| format!("解析响应失败: {e}"))?;
    parse_models_response(&body)
}

/// 解析 `GET /v1/models` 响应 `{data: [{id, display_name, ...}]}`，按省钱档映射
/// 到 5 字段：主模型/sonnet 别名 = 最新 Sonnet，opus 别名 = 最新 Opus，haiku 别名/
/// 子代理 = 最新 Haiku。
///
/// family 识别用 id 前缀（`claude-opus-`/`claude-sonnet-`/`claude-haiku-`），**排除**
/// `claude-fable-`/`claude-mythos-`（用户踩过 Fable 5 烧 5 小时窗口的坑）。“最新”
/// 判定按版本号数值比较（`parse_version`），不靠字符串排序——防未来 `4-10` vs
/// `4-9` 字符串反序（`'1' < '9'` 会把 4-10 排到 4-9 后面）。某 family 无模型 →
/// 对应字段留空（不报错）。`data` 缺失 → `Err`；`data` 空数组 → 全空 mappings。
fn parse_models_response(body: &serde_json::Value) -> Result<ProviderModelMappings, String> {
    let data = body
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "响应缺少 data 数组".to_string())?;

    let mut opus: Vec<&str> = Vec::new();
    let mut sonnet: Vec<&str> = Vec::new();
    let mut haiku: Vec<&str> = Vec::new();

    for item in data {
        let id = match item.get("id").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => continue,
        };
        if id.starts_with("claude-opus-") {
            opus.push(id);
        } else if id.starts_with("claude-sonnet-") {
            sonnet.push(id);
        } else if id.starts_with("claude-haiku-") {
            haiku.push(id);
        }
        // fable/mythos/未知 family —— 跳过
    }

    // 取版本号最大的（数值比较，非字符串排序）
    let latest = |models: &Vec<&str>| -> String {
        models
            .iter()
            .max_by(|a, b| parse_version(a).cmp(&parse_version(b)))
            .map(|s| s.to_string())
            .unwrap_or_default()
    };

    let latest_opus = latest(&opus);
    let latest_sonnet = latest(&sonnet);
    let latest_haiku = latest(&haiku);

    Ok(ProviderModelMappings {
        anthropic_model: latest_sonnet.clone(),
        default_opus_model: latest_opus,
        default_sonnet_model: latest_sonnet,
        default_haiku_model: latest_haiku.clone(),
        subagent: latest_haiku,
    })
}

/// 从模型 id 解析版本号元组用于数值比较。如 `claude-opus-4-8` → `[4, 8]`，
/// `claude-sonnet-4-20250514` → `[4, 20250514]`，`claude-sonnet-5` → `[5]`。
/// 非数字段跳过。逐位数值比较避免字符串排序的 `4-10 < 4-9` 反序 bug。
fn parse_version(id: &str) -> Vec<u64> {
    id.split('-')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

    fn sd_cfg() -> ProviderConfig {
        ProviderConfig {
            id: "__system_default__".into(),
            kind: ProviderKind::SystemDefault,
            name: "".into(),
            icon: "".into(),
            base_url: "".into(),
            api_key: "".into(),
            auth_token: "".into(),
            model: String::new(),
            model_mappings: ProviderModelMappings {
                anthropic_model: "sonnet-5".into(),
                ..Default::default()
            },
            effort_level: "".into(),
            auto_compact_window: "".into(),
            autocompact_pct_override: "".into(),
            max_context_tokens: "".into(),
            known_models: vec![],
        }
    }

    #[test]
    fn system_default_env_vars_is_mappings_only_when_creds_empty() {
        // 回归：空凭证时 env_vars == mappings_to_env(model_mappings)（与老 None 分支同形）
        let p = sd_cfg();
        let env = SystemDefaultStrategy.env_vars(&p);
        let expect = mappings_to_env(&p.model_mappings);
        assert_eq!(env, expect);
    }

    #[test]
    fn system_default_env_vars_injects_api_key_when_set() {
        let mut p = sd_cfg();
        p.api_key = "sk-test".into();
        let env = SystemDefaultStrategy.env_vars(&p);
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"sk-test".to_string()));
        assert_eq!(env.get("ANTHROPIC_MODEL"), Some(&"sonnet-5".to_string()));
    }

    #[test]
    fn system_default_env_vars_injects_max_context_tokens_when_nonempty() {
        let mut p = sd_cfg();
        p.max_context_tokens = "800000".into();
        let env = SystemDefaultStrategy.env_vars(&p);
        assert_eq!(env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"), Some(&"800000".to_string()));
    }

    #[test]
    fn system_default_fallback_is_large_set() {
        assert_eq!(
            SystemDefaultStrategy.fallback_env_keys(),
            &[
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "CLAUDE_CONFIG_DIR",
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "http_proxy",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
            ]
        );
    }

    #[test]
    fn system_default_actions_lists_three() {
        let a = SystemDefaultStrategy.actions();
        assert_eq!(a.len(), 3);
        assert!(a.iter().any(|x| x.name == "refresh_models"));
    }

    // ── refresh_system_default_models 的映射逻辑单测 ──

    #[test]
    fn parse_version_extracts_numeric_segments() {
        assert_eq!(parse_version("claude-opus-4-8"), vec![4, 8]);
        assert_eq!(parse_version("claude-sonnet-5"), vec![5]);
        assert_eq!(parse_version("claude-sonnet-4-20250514"), vec![4, 20250514]);
        assert_eq!(parse_version("claude-haiku-4-10"), vec![4, 10]);
        assert_eq!(parse_version("claude-opus-4-9"), vec![4, 9]);
    }

    #[test]
    fn parse_version_numeric_compare_not_string_sort() {
        // 字符串排序会把 '4-9' 排到 '4-10' 后（'9' > '1'）——版本号数值比较必须反过来
        assert!(parse_version("claude-opus-4-10") > parse_version("claude-opus-4-9"));
        assert!(parse_version("claude-sonnet-5") > parse_version("claude-sonnet-4-8"));
    }

    #[test]
    fn parse_models_response_selects_latest_per_family() {
        let body = serde_json::json!({
            "data": [
                {"id": "claude-sonnet-4-20250514"},
                {"id": "claude-sonnet-4-20250402"},
                {"id": "claude-opus-4-8"},
                {"id": "claude-opus-4-7"},
                {"id": "claude-haiku-4-5"},
                {"id": "claude-haiku-4-20250514"},
            ]
        });
        let m = parse_models_response(&body).unwrap();
        assert_eq!(m.anthropic_model, "claude-sonnet-4-20250514");
        assert_eq!(m.default_opus_model, "claude-opus-4-8");
        assert_eq!(m.default_sonnet_model, "claude-sonnet-4-20250514");
        assert_eq!(m.default_haiku_model, "claude-haiku-4-20250514");
        assert_eq!(m.subagent, "claude-haiku-4-20250514");
    }

    #[test]
    fn parse_models_response_excludes_fable_and_mythos() {
        let body = serde_json::json!({
            "data": [
                {"id": "claude-fable-5"},
                {"id": "claude-mythos-5"},
                {"id": "claude-sonnet-5"},
            ]
        });
        let m = parse_models_response(&body).unwrap();
        assert_eq!(m.anthropic_model, "claude-sonnet-5");
        // 没有 opus/haiku —— 对应字段留空
        assert_eq!(m.default_opus_model, "");
        assert_eq!(m.default_haiku_model, "");
        assert_eq!(m.subagent, "");
    }

    #[test]
    fn parse_models_response_skips_unknown_families() {
        let body = serde_json::json!({
            "data": [
                {"id": "some-unknown-model"},
                {"id": "claude-opus-4-8"},
            ]
        });
        let m = parse_models_response(&body).unwrap();
        assert_eq!(m.default_opus_model, "claude-opus-4-8");
        assert_eq!(m.anthropic_model, ""); // 无 sonnet
    }

    #[test]
    fn parse_models_response_empty_data_yields_all_empty() {
        let body = serde_json::json!({"data": []});
        let m = parse_models_response(&body).unwrap();
        assert_eq!(m.anthropic_model, "");
        assert_eq!(m.default_opus_model, "");
        assert_eq!(m.default_sonnet_model, "");
        assert_eq!(m.default_haiku_model, "");
        assert_eq!(m.subagent, "");
    }

    #[test]
    fn parse_models_response_missing_data_field_is_err() {
        let body = serde_json::json!({});
        assert!(parse_models_response(&body).is_err());
    }
}
