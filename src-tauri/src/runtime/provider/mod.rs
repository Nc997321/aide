//! Provider 后端身份：数据模型 + env 组装 + 连接指纹 + 持久化读取。
//! 归位进 runtime 层（原躺 commands/provider.rs，造成 runtime→commands 倒置）。
//! IPC 薄命令留在 commands/provider.rs，调本模块。

pub mod catalog;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::commands::settings::load_config;

/// Provider 类型判别。预置 kind 的 base_url/name/icon 由 catalog 派生、不入 config.json。
/// `#[default] Custom` 让缺 `kind` 字段的旧配置反序列化成 Custom（迁移后不会缺）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    SystemDefault,
    CpaGpt,
    Ollama,
    Kimi,
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[default]
    Custom,
}

impl ProviderKind {
    /// 预置 kind（在 catalog 里）。Custom 不是预置。
    // Task 7-12 将按 kind 派发；暂时未调用，保留 API。
    #[allow(dead_code)]
    pub fn is_preset(self) -> bool {
        !matches!(self, ProviderKind::Custom)
    }
}

/// Claude 专属的模型 env 变量映射——5 个变量统一在此，换 provider 时整块重写，
/// 不污染调用方（chat.rs 调 runtime::env::build_runtime_env_vars；本模块只暴露
/// provider_to_env_vars / mappings_to_env / load_* 给 runtime/env.rs 和 commands 层用）。
///
/// 与会话面板模型下拉（models_available + set_model 运行时切换）互补：下拉是
/// "用户在 UI 选真实模型 id 并运行时切换"，本块是"spawn 时 env 变量层的默认值 +
/// 别名→具体模型映射"。两者不冲突——apply_initial_model_override 最后覆盖
/// ANTHROPIC_MODEL，会话面板选的模型优先级最高。
///
/// - anthropicModel      → ANTHROPIC_MODEL（spawn 时默认模型）
/// - defaultOpusModel    → ANTHROPIC_DEFAULT_OPUS_MODEL（opus 别名→具体模型）
/// - defaultSonnetModel  → ANTHROPIC_DEFAULT_SONNET_MODEL（sonnet 别名→具体模型）
/// - defaultHaikuModel   → ANTHROPIC_DEFAULT_HAIKU_MODEL（haiku 别名→具体模型）
/// - subagent            → CLAUDE_CODE_SUBAGENT_MODEL（子代理默认模型——只是配置载体）
///
/// default*Model 的用途：子代理模型填 opus/sonnet/haiku 别名时，CLI 靠这些解析成
/// 具体模型 id（尤其第三方 provider，别名叫 sonnet 但实际模型 id 不同）；sidecar 把
/// subagent 全 id 反查成别名时也靠它们（subagentModelDefault.ts 的折算表）。
///
/// 注意 CLAUDE_CODE_SUBAGENT_MODEL 在 CLI 内是优先级最高的硬覆盖（高于 Agent 工具
/// 调用的 model 参数）——sidecar 不会把它原样透传给 CLI，而是压成 "inherit" 放行
/// 主代理的逐次动态派发，配置值改由 PreToolUse hook 按「未指定才注入别名」下发
/// （详见 agent-sidecar/src/subagentModelDefault.ts 顶部注释）。本函数只管把配置
/// 值送进 sidecar 进程 env，语义转换全在 sidecar。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelMappings {
    #[serde(default)]
    pub anthropic_model: String,
    #[serde(default)]
    pub default_opus_model: String,
    #[serde(default)]
    pub default_sonnet_model: String,
    #[serde(default)]
    pub default_haiku_model: String,
    #[serde(default)]
    pub subagent: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    #[serde(default)]
    pub kind: ProviderKind,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub auth_token: String,
    /// 已废弃：模型默认值的权威源改到 `model_mappings.anthropic_model`。字段保留
    /// 仅用于读旧配置——`migrate_provider_model` 在反序列化后把非空的顶层 model
    /// 回填到 anthropic_model。新写入不再读它（provider_to_env_vars 只看 model_mappings）。
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub model_mappings: ProviderModelMappings,
    #[serde(default)]
    pub effort_level: String,
    /// → CLAUDE_CODE_AUTO_COMPACT_WINDOW：auto-compact 计算用的上下文容量（token 数），
    /// 默认取模型上下文窗口（200K/1M，Sonnet 5 自带阈值）。填低值（如 500000）可提前
    /// 触发压缩，上限为模型实际窗口。空 = 不注入 = CLI 自带默认。
    #[serde(default)]
    pub auto_compact_window: String,
    /// → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE：1–100，作用在 auto_compact_window 之上微调
    /// 触发时机。空 = 不注入 = CLI 自带默认百分比。
    #[serde(default)]
    pub autocompact_pct_override: String,
    #[serde(default)]
    pub known_models: Vec<String>,
}

/// 把模型变量映射注入 env（5 个变量，非空才注入）。Claude 专属——自定义 provider
/// 和系统默认两条 spawn 路径共用本函数，注入逻辑单一入口。
pub fn mappings_to_env(m: &ProviderModelMappings) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let pairs: &[(&str, &str)] = &[
        ("ANTHROPIC_MODEL", &m.anthropic_model),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", &m.default_opus_model),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", &m.default_sonnet_model),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", &m.default_haiku_model),
        ("CLAUDE_CODE_SUBAGENT_MODEL", &m.subagent),
    ];
    for (key, val) in pairs {
        if !val.is_empty() {
            env.insert(key.to_string(), val.to_string());
        }
    }
    env
}

pub fn provider_to_env_vars(p: &ProviderConfig) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let pairs: &[(&str, &str)] = &[
        ("ANTHROPIC_BASE_URL", &p.base_url),
        ("ANTHROPIC_API_KEY", &p.api_key),
        ("ANTHROPIC_AUTH_TOKEN", &p.auth_token),
        ("CLAUDE_CODE_EFFORT_LEVEL", &p.effort_level),
        ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", &p.auto_compact_window),
        ("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", &p.autocompact_pct_override),
    ];
    for (key, val) in pairs {
        if !val.is_empty() {
            env.insert(key.to_string(), val.to_string());
        }
    }
    env.extend(mappings_to_env(&p.model_mappings));
    env
}

/// 旧配置把默认模型放在 ProviderConfig.model 顶层；新结构统一到
/// model_mappings.anthropic_model。反序列化后做一次性迁移：顶层 model 非空且
/// anthropic_model 为空时回填，避免旧配置丢失默认模型。
pub fn migrate_provider_model(p: &mut ProviderConfig) {
    if !p.model.is_empty() && p.model_mappings.anthropic_model.is_empty() {
        p.model_mappings.anthropic_model = p.model.clone();
    }
}

/// 决定子进程是否需要因连接身份变化而重启的字段白名单：base_url / api_key /
/// auth_token / 配置目录 / 代理。故意不含 ANTHROPIC_MODEL 等模型相关字段——
/// 模型切换有专门的运行时 `set_model` 通道，不该触发整进程重启（见
/// `chat.rs::set_model`）。
pub const CONNECTION_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// 从完整环境变量表里只摘出「连接身份」相关字段并按 key 排序（owned），用于
/// 比较两次 env 快照是不是同一个供应商连接，并可跨 kill 持久存进
/// `AgentRuntimeManager` 的指纹注册表。返回 owned 是因为 env_vars 在 spawn 后即释放，
/// 指纹要在 stop 后 respawn 时仍可读。
pub fn connection_fingerprint(env: &HashMap<String, String>) -> BTreeMap<String, String> {
    CONNECTION_ENV_KEYS
        .iter()
        .filter_map(|&k| env.get(k).map(|v| (k.to_string(), v.clone())))
        .collect()
}

pub fn load_active_provider() -> Option<ProviderConfig> {
    let config = load_config();
    let active_id = config
        .get("active_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("__system_default__");
    if active_id == "__system_default__" {
        return None;
    }
    let providers = config.get("providers").and_then(|v| v.as_array())?;
    for p in providers {
        if let Ok(mut pc) = serde_json::from_value::<ProviderConfig>(p.clone()) {
            if pc.id == active_id {
                migrate_provider_model(&mut pc);
                return Some(pc);
            }
        }
    }
    None
}

// ── 系统默认 provider 的模型变量映射 ──
//
// 系统默认不是 provider 条目（认证走系统 env 兜底，load_active_provider 返回 None），
// 但模型变量需要可配——否则用系统默认的用户摸不到 CLAUDE_CODE_SUBAGENT_MODEL，
// 子代理全继承主会话模型（见 chat.rs spawn 合并点 None 分支）。
// 独立存储在 config["system_default_model_mappings"]，与 providers 数组并列。

pub fn load_system_default_mappings() -> ProviderModelMappings {
    load_config()
        .get("system_default_model_mappings")
        .and_then(|v| serde_json::from_value::<ProviderModelMappings>(v.clone()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_with(model: String, anthropic: String) -> ProviderConfig {
        ProviderConfig {
            id: "x".to_string(),
            kind: ProviderKind::Custom,
            name: String::new(),
            icon: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            auth_token: String::new(),
            model,
            model_mappings: ProviderModelMappings {
                anthropic_model: anthropic,
                ..Default::default()
            },
            effort_level: String::new(),
            auto_compact_window: String::new(),
            autocompact_pct_override: String::new(),
            known_models: Vec::new(),
        }
    }

    /// 旧配置把默认模型放在顶层 model，新结构统一到 model_mappings.anthropic_model。
    /// 反序列化后迁移：顶层 model 非空且 anthropic_model 为空 → 回填，避免丢默认模型。
    #[test]
    fn migrate_backfills_legacy_top_level_model() {
        let mut p = provider_with("claude-sonnet-5".to_string(), String::new());
        migrate_provider_model(&mut p);
        assert_eq!(p.model_mappings.anthropic_model, "claude-sonnet-5");
        assert_eq!(p.model, "claude-sonnet-5"); // 原顶层值保留不丢
    }

    /// anthropic_model 已有值时，旧顶层 model 不覆盖（新配置权威优先）。
    #[test]
    fn migrate_skips_when_anthropic_model_already_set() {
        let mut p = provider_with("legacy".to_string(), "new".to_string());
        migrate_provider_model(&mut p);
        assert_eq!(p.model_mappings.anthropic_model, "new");
    }

    /// 注入逻辑：5 字段非空才注入，空的不进 env。自定义 provider 和系统默认共用。
    #[test]
    fn mappings_to_env_skips_empty_injects_nonempty() {
        let m = ProviderModelMappings {
            anthropic_model: "claude-sonnet-5".to_string(),
            default_sonnet_model: "claude-sonnet-5".to_string(),
            ..Default::default()
        };
        let env = mappings_to_env(&m);
        assert_eq!(env.get("ANTHROPIC_MODEL"), Some(&"claude-sonnet-5".to_string()));
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
            Some(&"claude-sonnet-5".to_string())
        );
        // 空字段不注入
        assert!(env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").is_none());
        assert!(env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").is_none());
        assert!(env.get("CLAUDE_CODE_SUBAGENT_MODEL").is_none());
    }

    /// ProviderModelMappings 全空时 mappings_to_env 不注入任何 env（系统默认未配置的
    /// 安全默认——不会污染 spawn env）。
    #[test]
    fn mappings_to_env_empty_yields_nothing() {
        let env = mappings_to_env(&ProviderModelMappings::default());
        assert!(env.is_empty());
    }

    /// auto_compact_window / autocompact_pct_override 非空时注入对应 env，空时不注入
    /// （空 = CLI 自带默认，与 effort_level 同一注入契约）。
    #[test]
    fn provider_to_env_vars_injects_auto_compact_when_nonempty() {
        let p = ProviderConfig {
            auto_compact_window: "500000".to_string(),
            autocompact_pct_override: "80".to_string(),
            ..provider_with(String::new(), String::new())
        };
        let env = provider_to_env_vars(&p);
        assert_eq!(
            env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW"),
            Some(&"500000".to_string())
        );
        assert_eq!(
            env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"),
            Some(&"80".to_string())
        );
    }

    /// 两个字段为空时不注入，避免污染 spawn env（旧配置无此字段时的安全默认）。
    #[test]
    fn provider_to_env_vars_omits_auto_compact_when_empty() {
        let p = provider_with(String::new(), String::new());
        let env = provider_to_env_vars(&p);
        assert!(env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW").is_none());
        assert!(env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE").is_none());
    }
}
