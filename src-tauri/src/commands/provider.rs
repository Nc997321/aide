use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

use super::proxy::detect_proxy;
use super::settings::{load_config, with_config_mut};
use std::time::Duration;

/// Claude 专属的模型 env 变量映射——5 个变量统一在此，换 provider 时整块重写，
/// 不污染调用方（chat.rs 只调 provider_to_env_vars / system_default_mappings_to_env）。
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
fn mappings_to_env(m: &ProviderModelMappings) -> HashMap<String, String> {
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
fn migrate_provider_model(p: &mut ProviderConfig) {
    if !p.model.is_empty() && p.model_mappings.anthropic_model.is_empty() {
        p.model_mappings.anthropic_model = p.model.clone();
    }
}

/// 决定子进程是否需要因连接身份变化而重启的字段白名单：base_url / api_key /
/// auth_token / 配置目录 / 代理。故意不含 ANTHROPIC_MODEL 等模型相关字段——
/// 模型切换有专门的运行时 `set_model` 通道，不该触发整进程重启（见
/// `chat.rs::set_model`）。
const CONNECTION_ENV_KEYS: &[&str] = &[
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

#[tauri::command]
pub fn get_providers() -> Result<Vec<ProviderConfig>, String> {
    let _trace = crate::diagnostics::trace_command("get_providers");
    let config = load_config();
    if let Some(arr) = config.get("providers").and_then(|v| v.as_array()) {
        let mut out = Vec::new();
        for item in arr {
            if let Ok(mut p) = serde_json::from_value::<ProviderConfig>(item.clone()) {
                migrate_provider_model(&mut p);
                out.push(p);
            }
        }
        Ok(out)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn set_providers(providers: Vec<ProviderConfig>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_providers");
    with_config_mut(move |config| {
        config["providers"] =
            serde_json::to_value(&providers).map_err(|e| format!("Serialize error: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_active_provider_id() -> Result<String, String> {
    let _trace = crate::diagnostics::trace_command("get_active_provider_id");
    let config = load_config();
    let id = config
        .get("active_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("__system_default__")
        .to_string();
    Ok(id)
}

#[tauri::command]
pub fn set_active_provider_id(provider_id: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_active_provider_id");
    with_config_mut(move |config| {
        config["active_provider"] = Value::String(provider_id);
        Ok(())
    })
}

// ── 系统默认 provider 的模型变量映射 ──
//
// 系统默认不是 provider 条目（认证走系统 env 兜底，load_active_provider 返回 None），
// 但模型变量需要可配——否则用系统默认的用户摸不到 CLAUDE_CODE_SUBAGENT_MODEL，
// 子代理全继承主会话模型（见 chat.rs spawn 合并点 None 分支）。
// 独立存储在 config["system_default_model_mappings"]，与 providers 数组并列。

fn load_system_default_mappings() -> ProviderModelMappings {
    load_config()
        .get("system_default_model_mappings")
        .and_then(|v| serde_json::from_value::<ProviderModelMappings>(v.clone()).ok())
        .unwrap_or_default()
}

/// spawn 时 load_active_provider 返回 None 走这条路径：读系统默认模型变量映射
/// 注入 5 个 env。复用 mappings_to_env，与自定义 provider 同一注入逻辑。
pub fn system_default_mappings_to_env() -> HashMap<String, String> {
    mappings_to_env(&load_system_default_mappings())
}

#[tauri::command]
pub fn get_system_default_model_mappings() -> Result<ProviderModelMappings, String> {
    let _trace = crate::diagnostics::trace_command("get_system_default_model_mappings");
    Ok(load_system_default_mappings())
}

#[tauri::command]
pub fn set_system_default_model_mappings(mappings: ProviderModelMappings) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_system_default_model_mappings");
    let mappings_val =
        serde_json::to_value(&mappings).map_err(|e| format!("Serialize error: {}", e))?;
    with_config_mut(move |config| {
        config["system_default_model_mappings"] = mappings_val;
        Ok(())
    })
}

// ── 启动时拉最新模型覆盖"系统默认" ──
//
// 模型会持续迭代（opus 4.8 → 4.9 → …），硬编码默认会随版本老化。启动时（和点
// "手动刷新"时）调 Anthropic `GET /v1/models` 拉真实可用列表，按省钱档映射覆盖
// "系统默认"的 5 字段。模型变量本就该自动维护、不该让用户手改（手改易出 opus4.8
// 这种 404 错名）——前端 ProviderSettings 系统默认下 5 字段改只读 + 刷新按钮。
//
// 认证走系统 env 兜底（与 chat.rs spawn 合并点 None 分支同源）。无认证时静默返回
// 旧 mappings（系统默认允许无认证），网络/解析失败返回 Err 让前端 toast 提示。
//
// async + spawn_blocking：CLAUDE.md 规矩——重 IO 命令一律 async + spawn_blocking，
// 同步 ureq 调用放 blocking 闭包不阻塞 tokio worker。**不埋 trace_command**——
// async 命令的 guard 在 dispatch 后立刻 drop，埋了也抓不到（CLAUDE.md 红线）。

/// 启动时（和点"手动刷新"时）调 Anthropic `GET /v1/models` 拉最新模型列表，
/// 按省钱档映射覆盖"系统默认"的 5 个模型变量字段，写回 config 并返回新 mappings。
#[tauri::command]
pub async fn refresh_system_default_models() -> Result<ProviderModelMappings, String> {
    tokio::task::spawn_blocking(|| {
        // 1. 认证 env（镜像 chat.rs:52-71 系统默认 env 读取）
        let api_key = std::env::var("ANTHROPIC_API_KEY")
            .ok()
            .filter(|s| !s.is_empty());
        let auth_token = std::env::var("ANTHROPIC_AUTH_TOKEN")
            .ok()
            .filter(|s| !s.is_empty());
        let base_url = std::env::var("ANTHROPIC_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());

        // 无认证：静默保留旧值（系统默认本来就允许无认证）
        let (auth_header_name, auth_header_val): (&str, String) = match (api_key, auth_token) {
            (Some(key), _) => ("x-api-key", key),
            (_, Some(token)) => ("Authorization", format!("Bearer {}", token)),
            (None, None) => return Ok(load_system_default_mappings()),
        };

        // 2. ureq agent + 代理 + 10s 超时
        let mut agent_builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(10));
        if let Some(proxy_url) = detect_proxy() {
            if let Ok(proxy) = ureq::Proxy::new(&proxy_url) {
                agent_builder = agent_builder.proxy(proxy);
            }
        }
        let agent = agent_builder.build();

        // 3. GET {base_url}/v1/models
        let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
        let response = agent
            .get(&url)
            .set(auth_header_name, &auth_header_val)
            .call()
            .map_err(|e| format!("API 请求失败: {}", e))?;

        let body: serde_json::Value = response
            .into_json()
            .map_err(|e| format!("解析响应失败: {}", e))?;

        // 4. 映射省钱档
        let mappings = parse_models_response(&body)?;

        // 5. 持久化（走临界区，与 set_providers/set_settings 串行，避免陈旧快照覆盖）
        let mappings_val =
            serde_json::to_value(&mappings).map_err(|e| format!("Serialize error: {}", e))?;
        with_config_mut(move |config| {
            config["system_default_model_mappings"] = mappings_val;
            Ok(())
        })?;

        Ok(mappings)
    })
    .await
    .map_err(|e| format!("任务调度失败: {}", e))?
}

/// 解析 `GET /v1/models` 响应 `{data: [{id, display_name, ...}]}`，按省钱档映射
/// 到 5 字段：主模型/sonnet 别名 = 最新 Sonnet，opus 别名 = 最新 Opus，haiku 别名/
/// 子代理 = 最新 Haiku。
///
/// family 识别用 id 前缀（`claude-opus-`/`claude-sonnet-`/`claude-haiku-`），**排除**
/// `claude-fable-`/`claude-mythos-`（用户踩过 Fable 5 烧 5 小时窗口的坑）。"最新"
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

    fn provider_with(model: String, anthropic: String) -> ProviderConfig {
        ProviderConfig {
            id: "x".to_string(),
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

    // ── refresh_system_default_models 的映射逻辑单测 ──

    #[test]
    fn parse_version_extracts_numeric_segments() {
        assert_eq!(parse_version("claude-opus-4-8"), vec![4, 8]);
        assert_eq!(parse_version("claude-sonnet-5"), vec![5]);
        assert_eq!(
            parse_version("claude-sonnet-4-20250514"),
            vec![4, 20250514]
        );
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
