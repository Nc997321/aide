//! 供应商「周期用量」策略：一个供应商一个实现，与 `provider/strategy/` 同构。
//!
//! 只报各时间窗口的**已用百分比 + 重置时间**，不报金额/余额。
//! 全应用不展示按 Anthropic 价目表折算的美元成本（多供应商下不准）；`TurnUsage.costUsd`
//! 仅作为 sidecar 事件协议的 wire 字段保留，UI 不读。
//!
//! 数据流有两条，共用同一份 `ProviderUsage`：
//! 1. 设置页点「查看用量」→ `view_provider_usage` 命令返回值；
//! 2. Host 主动查询 → `chat-event(type=rate_limit, kind=...)` → 聊天页徽标/额度环。
//!
//! ⚠️ 目前两家的端点都**没有出现在供应商公开 API 文档**里（Kimi 是控制台/CLI 内部端点，
//! 智谱是控制台「用量统计」页调用的 monitor 端点）。字段依据来自开源实现
//! `jiegec/coding-plan-usage` 的 `providers/{kimi,bigmodel}.py` 及其测试 fixture。
//! 解析器一律宽松取值：字段变了就跳过该窗口，窗口全空时明确报错，绝不把接口变更
//! 静默显示成「用量 0%」。
//!
//! **新增供应商 = 加一个文件实现 `UsageStrategy` + 在 `strategies()` 里注册一行。**
//! catalog 的 `view_usage` 声明、strategy 的 actions()、命令层可用性全部由注册表派生。

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::provider::{catalog::catalog_find, ProviderConfig, ProviderKind};
use crate::proxy::detect_proxy;

pub mod kimi;
pub mod zhipu;

/// 一个用量窗口。`utilization` 恒为 0–100 的**已用**百分比；`resets_at` 为 unix 毫秒。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub key: String,
    pub label: String,
    pub utilization: f64,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub kind: ProviderKind,
    pub windows: Vec<UsageWindow>,
}

/// 每家供应商自己实现：端点、鉴权、响应解析、窗口命名都在各自的文件里。
pub trait UsageStrategy: Send + Sync {
    fn kind(&self) -> ProviderKind;
    /// 查当前凭证下的周期用量。实现方自行决定 URL / header / 字段映射。
    fn fetch(&self, cfg: &ProviderConfig) -> Result<Vec<UsageWindow>, String>;
}

static KIMI: kimi::KimiUsage = kimi::KimiUsage;
static ZHIPU: zhipu::ZhipuUsage = zhipu::ZhipuUsage;
/// 注册表 = 唯一真相源。`supports()` / `for_kind()` / 命令可用性都从这里派生。
/// 必须是 static：函数内 `&[&KIMI, &ZHIPU]` 会创建临时数组，返回引用触发 E0515。
static REGISTRY: &[&dyn UsageStrategy] = &[&KIMI, &ZHIPU];

pub fn strategies() -> &'static [&'static dyn UsageStrategy] {
    REGISTRY
}

pub fn for_kind(kind: ProviderKind) -> Option<&'static dyn UsageStrategy> {
    strategies().iter().copied().find(|s| s.kind() == kind)
}

pub fn supports(kind: ProviderKind) -> bool {
    for_kind(kind).is_some()
}

pub fn fetch_usage(kind: ProviderKind, cfg: &ProviderConfig) -> Result<ProviderUsage, String> {
    let strategy = for_kind(kind).ok_or_else(|| {
        let name = catalog_find(kind)
            .map(|p| p.name.as_str())
            .unwrap_or("该供应商");
        format!("{name} 暂不提供用量查询")
    })?;
    let windows = strategy.fetch(cfg)?;
    if windows.is_empty() {
        return Err("用量接口未返回可识别的窗口（接口可能已变更）".to_string());
    }
    Ok(ProviderUsage { kind, windows })
}

/// 折成 `rate_limit` 事件的 payload（wire 字段是 snake_case `resets_at`，
/// 与 sidecar `mapper.ts` 产出的形状一致，前端 `events.ts` 无需区分解析）。
///
/// **刻意不带 `session_id`**：用量是账号级事实，不是某个会话的状态。
/// `bus.rs:89-92` 的 `wants()` 对无会话号的事件返回 true（全送），桌面所有窗口
/// 与手机网关都能收到；前端在 session_id 守卫之前提前接住，不建会话 store。
pub fn to_chat_event(usage: &ProviderUsage) -> Value {
    serde_json::json!({
        "type": "rate_limit",
        "kind": usage.kind,
        "subscription": null,
        "windows": usage.windows.iter().map(|w| serde_json::json!({
            "key": w.key,
            "label": w.label,
            "utilization": w.utilization,
            "resets_at": w.resets_at,
        })).collect::<Vec<_>>(),
    })
}

// ── 各实现共用的工具（非业务分派） ──

/// Bearer 凭证：只认 provider 配置里的令牌，不读进程 env，避免查到别的账号。
pub(crate) fn bearer(cfg: &ProviderConfig) -> Result<String, String> {
    let token = if !cfg.auth_token.is_empty() {
        cfg.auth_token.as_str()
    } else {
        cfg.api_key.as_str()
    };
    if token.is_empty() {
        return Err("未配置访问令牌，无法查询用量".to_string());
    }
    Ok(format!("Bearer {token}"))
}

pub(crate) fn get_json(url: &str, auth: &str) -> Result<Value, String> {
    let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(10));
    if let Some(proxy_url) = detect_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy_url) {
            builder = builder.proxy(p);
        }
    }
    let resp = builder
        .build()
        .get(url)
        .set("Authorization", auth)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => {
                format!("用量接口返回 HTTP {code}（令牌可能无效，或接口已变更）")
            }
            other => format!("用量查询失败: {other}"),
        })?;
    resp.into_json()
        .map_err(|e| format!("用量接口响应不是有效 JSON: {e}"))
}

pub(crate) fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

pub(crate) fn num_at(v: &Value, key: &str) -> Option<f64> {
    num(v.get(key))
}

pub(crate) fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub(crate) fn iso_ms(v: Option<&Value>) -> Option<i64> {
    let s = v?.as_str()?;
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc).timestamp_millis())
}

pub(crate) fn ms(v: Option<&Value>) -> Option<i64> {
    v?.as_i64()
}

pub(crate) fn utilization(used: Option<f64>, limit: Option<f64>) -> Option<f64> {
    let (used, limit) = (used?, limit?);
    if limit <= 0.0 {
        return None;
    }
    Some((used / limit * 100.0).clamp(0.0, 100.0))
}

/// 窗口 key 唯一化：同一接口偶尔会回多个同窗口（按模型拆），重复 key 会让 Vue 列表告警。
pub(crate) fn push_window(out: &mut Vec<UsageWindow>, mut w: UsageWindow) {
    let base = w.key.clone();
    let mut n = 2;
    while out.iter().any(|x| x.key == w.key) {
        w.key = format!("{base}_{n}");
        n += 1;
    }
    out.push(w);
}

pub(crate) fn window(
    key: &str,
    label: &str,
    utilization: f64,
    resets_at: Option<i64>,
) -> UsageWindow {
    UsageWindow {
        key: key.to_string(),
        label: label.to_string(),
        utilization,
        resets_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_the_single_source_of_truth() {
        assert!(supports(ProviderKind::Kimi));
        assert!(supports(ProviderKind::Zhipu));
        for k in [
            ProviderKind::SystemDefault,
            ProviderKind::DeepSeek,
            ProviderKind::Qwen,
            ProviderKind::Volcengine,
            ProviderKind::Ollama,
            ProviderKind::CpaGpt,
            ProviderKind::Custom,
        ] {
            assert!(!supports(k), "{k:?} must not claim usage support");
            assert!(for_kind(k).is_none());
        }
    }

    #[test]
    fn every_strategy_declares_a_unique_kind() {
        let mut kinds = Vec::new();
        for s in strategies() {
            assert!(!kinds.contains(&s.kind()), "duplicate kind {:?}", s.kind());
            kinds.push(s.kind());
        }
    }

    #[test]
    fn chat_event_uses_sidecar_wire_shape() {
        let u = ProviderUsage {
            kind: ProviderKind::Kimi,
            windows: vec![window("five_hour", "5 小时", 65.0, Some(1769776934422))],
        };
        let e = to_chat_event(&u);
        assert_eq!(e["type"], "rate_limit");
        assert_eq!(e["kind"], "kimi");
        assert!(e.get("session_id").is_none(), "账号级用量不带会话号 → 全端广播");
        assert_eq!(e["windows"][0]["resets_at"], 1769776934422i64);
        assert!(e["windows"][0].get("resetsAt").is_none());
    }

    #[test]
    fn utilization_clamps_and_rejects_zero_limit() {
        assert_eq!(utilization(Some(130.0), Some(100.0)), Some(100.0));
        assert_eq!(utilization(Some(1.0), Some(0.0)), None);
        assert_eq!(utilization(None, Some(100.0)), None);
    }

    #[test]
    fn push_window_deduplicates_keys() {
        let mut out = Vec::new();
        push_window(&mut out, window("five_hour", "5 小时", 10.0, None));
        push_window(&mut out, window("five_hour", "5 小时", 20.0, None));
        assert_eq!(out[0].key, "five_hour");
        assert_eq!(out[1].key, "five_hour_2");
    }
}
