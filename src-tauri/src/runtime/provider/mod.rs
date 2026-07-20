//! Provider 后端身份：数据模型 + env 组装 + 连接指纹 + 持久化读取。
//! 归位进 runtime 层（原躺 commands/provider.rs，造成 runtime→commands 倒置）。
//! IPC 薄命令留在 commands/provider.rs，调本模块。

pub mod catalog;
pub mod strategy;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::commands::settings::load_config;
use crate::runtime::provider::catalog::catalog_find;

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

/// 取 active provider；迁移后必返回 Some。异常时返回一个空 SystemDefault 实例兜底。
pub fn active_provider_or_system_default() -> ProviderConfig {
    match load_active_provider() {
        Some(p) => p,
        None => ProviderConfig {
            id: "__system_default__".to_string(),
            kind: ProviderKind::SystemDefault,
            name: String::new(), icon: String::new(), base_url: String::new(),
            api_key: String::new(), auth_token: String::new(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: String::new(), auto_compact_window: String::new(),
            autocompact_pct_override: String::new(), known_models: Vec::new(),
        },
    }
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

/// 老配置 provider 顶层 `model` → `model_mappings.anthropic_model` 回填（复用既有逻辑）。
/// 在 migrate 里对每条迁移后的 provider 跑一遍。
fn backfill_legacy_model(p: &mut serde_json::Value) {
    let model = p
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let anthropic = p
        .get("model_mappings")
        .and_then(|m| m.get("anthropic_model"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if !model.is_empty() && anthropic.is_empty() {
        if let Some(obj) = p.get_mut("model_mappings").and_then(|m| m.as_object_mut()) {
            obj.insert("anthropic_model".to_string(), serde_json::json!(model));
        }
    }
}

/// 按 base_url 匹配预置 kind。空 base_url → SystemDefault。命中预置 → 该 kind。其余 → Custom。
fn classify_by_base_url(base_url: &str) -> ProviderKind {
    if base_url.is_empty() {
        return ProviderKind::SystemDefault;
    }
    for kind in [
        ProviderKind::CpaGpt,
        ProviderKind::Ollama,
        ProviderKind::Kimi,
        ProviderKind::DeepSeek,
        ProviderKind::SystemDefault,
    ] {
        if let Some(preset) = catalog_find(kind) {
            if preset.base_url.eq_ignore_ascii_case(base_url.trim_end_matches('/')) {
                return kind;
            }
        }
    }
    ProviderKind::Custom
}

/// 检测老 schema 并原地迁移。返回是否改了。idempotent。
pub fn migrate(config: &mut serde_json::Value) -> bool {
    let providers_arr = config.get("providers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let has_legacy_sdm = config.get("system_default_model_mappings").is_some();
    let all_have_kind = !providers_arr.is_empty()
        && providers_arr.iter().all(|p| p.get("kind").is_some());
    if !has_legacy_sdm && all_have_kind {
        return false; // 已迁移
    }

    let sdm = config
        .get("system_default_model_mappings")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    // 合成 SystemDefault 实例（若顶层 sdm 存在 或 哨兵引用它）
    let mut system_default = serde_json::json!({
        "id": "__system_default__",
        "kind": "system_default",
        "name": "",
        "icon": "",
        "base_url": "",
        "api_key": "",
        "auth_token": "",
        "model": "",
        "model_mappings": sdm,
        "effort_level": "",
        "auto_compact_window": "",
        "autocompact_pct_override": "",
        "known_models": [],
    });

    let mut new_providers: Vec<serde_json::Value> = Vec::new();

    for p in &providers_arr {
        // 已有 kind 的条目原样保留（不应发生在 needs_migration 路径，但稳）
        if p.get("kind").is_some() {
            new_providers.push(p.clone());
            continue;
        }
        let base_url = p.get("base_url").and_then(|v| v.as_str()).unwrap_or("");
        let kind = classify_by_base_url(base_url);
        match kind {
            ProviderKind::SystemDefault => {
                // 合并进 system_default：凭证 / mappings 只在 system_default 空时取
                merge_into(&mut system_default, p);
            }
            ProviderKind::Custom => {
                let mut q = p.clone();
                // 补 kind + 确保字段齐全
                q["kind"] = serde_json::json!("custom");
                backfill_legacy_model(&mut q);
                new_providers.push(q);
            }
            preset_kind => {
                let mut q = p.clone();
                q["kind"] = serde_json::json!(preset_kind);
                // 丢持久化的 base_url/name/icon（改由 catalog 派生）
                if let Some(obj) = q.as_object_mut() {
                    obj.insert("base_url".to_string(), serde_json::json!(""));
                    obj.insert("name".to_string(), serde_json::json!(""));
                    obj.insert("icon".to_string(), serde_json::json!(""));
                }
                backfill_legacy_model(&mut q);
                new_providers.push(q);
            }
        }
    }

    // SystemDefault 放首位
    let mut final_providers = vec![system_default];
    final_providers.extend(new_providers);

    config["providers"] = serde_json::json!(final_providers);
    if has_legacy_sdm {
        config.as_object_mut().map(|o| o.remove("system_default_model_mappings"));
    }
    true
}

/// 把 src 的凭证 / model_mappings 合并进 dst（dst 空才取 src）。
fn merge_into(dst: &mut serde_json::Value, src: &serde_json::Value) {
    let dst_obj = match dst.as_object_mut() { Some(o) => o, None => return };
    let src_obj = match src.as_object() { Some(o) => o, None => return };
    // 凭证：dst 空才取
    for key in ["api_key", "auth_token"] {
        let src_val = src_obj.get(key).and_then(|v| v.as_str()).unwrap_or("");
        let dst_val = dst_obj.get(key).and_then(|v| v.as_str()).unwrap_or("");
        if dst_val.is_empty() && !src_val.is_empty() {
            dst_obj.insert(key.to_string(), serde_json::json!(src_val));
        }
    }
    // model_mappings：逐字段 dst 空才取
    if let Some(dst_m) = dst_obj.get_mut("model_mappings").and_then(|v| v.as_object_mut()) {
        if let Some(src_m) = src_obj.get("model_mappings").and_then(|v| v.as_object()) {
            for (k, v) in src_m {
                let dst_v = dst_m.get(k).and_then(|x| x.as_str()).unwrap_or("");
                let src_v = v.as_str().unwrap_or("");
                if dst_v.is_empty() && !src_v.is_empty() {
                    dst_m.insert(k.clone(), v.clone());
                }
            }
        }
    }
}

static MIGRATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// I/O 包装：读 config → migrate → 若改了则备份 + 原子写回。idempotent。
pub fn ensure_migrated() -> Result<(), String> {
    use crate::commands::config_path;
    use crate::commands::settings::{load_config, save_config};
    let _guard = MIGRATE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut config = load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    if !migrate(&mut config) {
        return Ok(());
    }
    // 备份老 config
    let path = config_path();
    if path.exists() {
        let bak = path.with_extension("json.bak");
        let _ = std::fs::copy(&path, &bak);
    }
    save_config(&config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cfg_with_legacy(providers: serde_json::Value, sdm: serde_json::Value) -> serde_json::Value {
        json!({
            "active_provider": "__system_default__",
            "system_default_model_mappings": sdm,
            "providers": providers,
        })
    }

    #[test]
    fn migrate_idempotent_when_already_new_schema() {
        let mut c = json!({
            "active_provider": "__system_default__",
            "providers": [{"id":"__system_default__","kind":"system_default"}],
        });
        assert!(!migrate(&mut c), "already migrated → false");
    }

    #[test]
    fn migrate_pure_sentinel_synthesizes_system_default_instance() {
        let mut c = cfg_with_legacy(json!([]), json!({"anthropic_model":"claude-sonnet-5"}));
        assert!(migrate(&mut c));
        let providers = c["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["id"], "__system_default__");
        assert_eq!(providers[0]["kind"], "system_default");
        assert_eq!(providers[0]["model_mappings"]["anthropic_model"], "claude-sonnet-5");
        assert!(c.get("system_default_model_mappings").is_none(), "top-level sdm removed");
        assert_eq!(c["active_provider"], "__system_default__");
    }

    #[test]
    fn migrate_custom_provider_gets_custom_kind_keeps_fields() {
        let mut c = cfg_with_legacy(
            json!([{"id":"p1","name":"mygw","icon":"M","base_url":"https://my-gw.example","api_key":"k1","model_mappings":{}}]),
            json!({}),
        );
        assert!(migrate(&mut c));
        let p1 = &c["providers"].as_array().unwrap()[1]; // [0]=system_default
        assert_eq!(p1["kind"], "custom");
        assert_eq!(p1["base_url"], "https://my-gw.example", "custom keeps base_url");
        assert_eq!(p1["name"], "mygw");
    }

    #[test]
    fn migrate_provider_matching_preset_base_url_becomes_preset_kind_strips_identity() {
        let mut c = cfg_with_legacy(
            json!([{"id":"p2","name":"whatever","icon":"X","base_url":"http://127.0.0.1:8317","auth_token":"sk-local-cpa","model_mappings":{}}]),
            json!({}),
        );
        assert!(migrate(&mut c));
        let p2 = &c["providers"].as_array().unwrap()[1];
        assert_eq!(p2["kind"], "cpa_gpt");
        assert_eq!(p2["auth_token"], "sk-local-cpa", "credential kept");
        assert_eq!(p2["base_url"], "", "preset base_url stripped (derived from catalog)");
        assert_eq!(p2["name"], "", "preset name stripped");
        assert_eq!(p2["icon"], "", "preset icon stripped");
    }

    #[test]
    fn migrate_empty_base_url_provider_merges_into_system_default() {
        let mut c = cfg_with_legacy(
            json!([{"id":"p3","base_url":"","api_key":"key-from-empty","model_mappings":{"default_opus_model":"opus-x"}}]),
            json!({"anthropic_model":"sonnet-y"}),
        );
        assert!(migrate(&mut c));
        let providers = c["providers"].as_array().unwrap();
        // system_default 合并了 p3 的 api_key；p3 不独立存在
        assert_eq!(providers.len(), 1, "empty-base_url provider merged, not standalone");
        assert_eq!(providers[0]["id"], "__system_default__");
        assert_eq!(providers[0]["kind"], "system_default");
        assert_eq!(providers[0]["api_key"], "key-from-empty");
        // model_mappings：顶层 sdm 的 anthropic_model 保留，p3 的 default_opus_model 补进来
        assert_eq!(providers[0]["model_mappings"]["anthropic_model"], "sonnet-y");
        assert_eq!(providers[0]["model_mappings"]["default_opus_model"], "opus-x");
    }

    #[test]
    fn migrate_legacy_top_level_model_field_backfilled_via_migrate_provider_model() {
        // 旧 provider 有顶层 model（非 model_mappings.anthropic_model），迁移时回填
        let mut c = cfg_with_legacy(
            json!([{"id":"p4","base_url":"https://gw.example","model":"claude-sonnet-4","model_mappings":{}}]),
            json!({}),
        );
        assert!(migrate(&mut c));
        let p4 = &c["providers"].as_array().unwrap()[1];
        assert_eq!(p4["kind"], "custom");
        assert_eq!(p4["model_mappings"]["anthropic_model"], "claude-sonnet-4", "legacy top-level model backfilled");
    }

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
