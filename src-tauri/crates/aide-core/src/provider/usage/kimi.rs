//! Kimi 用量策略：`GET https://api.kimi.com/coding/v1/usages`。
//!
//! 顶层 `usage` = 套餐周期额度；`limits[]` = 频限窗口（300 分钟即 5 小时）。
//! 新套餐取消了周额度、只剩 5 小时 + 月额度，所以顶层一律叫「周期额度」，不谎称「7 天」。
//! 鉴权用套餐 Key 的 Bearer，与 `api.kimi.com/coding/` 推理端点同一把 Key。

use serde_json::Value;

use super::{bearer, get_json, iso_ms, num_at, push_window, str_at, utilization, window};
use crate::provider::{ProviderConfig, ProviderKind};

const USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";

pub struct KimiUsage;

impl super::UsageStrategy for KimiUsage {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Kimi
    }

    fn fetch(&self, cfg: &ProviderConfig) -> Result<Vec<super::UsageWindow>, String> {
        let body = get_json(USAGE_URL, &bearer(cfg)?)?;
        parse(&body)
    }
}

fn parse(body: &Value) -> Result<Vec<super::UsageWindow>, String> {
    let mut out = Vec::new();
    if let Some(usage) = body.get("usage") {
        if let Some(pct) = utilization(num_at(usage, "used"), num_at(usage, "limit")) {
            push_window(
                &mut out,
                window(
                    "plan_cycle",
                    "周期额度",
                    pct,
                    iso_ms(usage.get("resetTime")),
                ),
            );
        }
    }
    if let Some(limits) = body.get("limits").and_then(Value::as_array) {
        for l in limits {
            let detail = l.get("detail").unwrap_or(&Value::Null);
            let (key, label) = window_label(l.get("window"));
            if let Some(pct) = utilization(num_at(detail, "used"), num_at(detail, "limit")) {
                push_window(
                    &mut out,
                    window(&key, &label, pct, iso_ms(detail.get("resetTime"))),
                );
            }
        }
    }
    Ok(out)
}

/// `TIME_UNIT_*` → 中文窗口名。只把 300 分钟归一成「5 小时」，其余按服务端给的值直译，
/// 不去猜「哪个是周限」——Kimi 新旧套餐的周期语义不一样。
fn window_label(w: Option<&Value>) -> (String, String) {
    let w = w.unwrap_or(&Value::Null);
    let duration = num_at(w, "duration").unwrap_or(0.0);
    let unit = str_at(w, "timeUnit").unwrap_or("");
    let n = if duration.fract() == 0.0 {
        format!("{}", duration as i64)
    } else {
        format!("{duration}")
    };
    match unit {
        "TIME_UNIT_MINUTE" if duration == 300.0 => ("five_hour".into(), "5 小时".into()),
        "TIME_UNIT_MINUTE" => (format!("minute_{n}"), format!("{n} 分钟")),
        "TIME_UNIT_HOUR" => (format!("hour_{n}"), format!("{n} 小时")),
        "TIME_UNIT_DAY" => (format!("day_{n}"), format!("{n} 天")),
        _ => ("window".into(), "频限窗口".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::usage::UsageStrategy;

    // fixture 原文来自 jiegec/coding-plan-usage 的 tests/test_kimi.py
    const RESPONSE: &str = r#"{
      "user": {"userId":"11111111111111111111","membership":{"level":"LEVEL_TRIAL"}},
      "usage": {"limit":"100","used":"13","remaining":"87","resetTime":"2026-02-06T08:31:59.863136Z"},
      "limits": [{
        "window": {"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
        "detail": {"limit":"100","used":"65","remaining":"35","resetTime":"2026-01-30T13:31:59.863136Z"}
      }]
    }"#;

    #[test]
    fn parses_cycle_and_five_hour_windows() {
        let body: Value = serde_json::from_str(RESPONSE).unwrap();
        let windows = parse(&body).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].key, "plan_cycle");
        assert_eq!(windows[0].label, "周期额度");
        assert_eq!(windows[0].utilization, 13.0);
        assert_eq!(windows[1].key, "five_hour");
        assert_eq!(windows[1].label, "5 小时");
        assert_eq!(windows[1].utilization, 65.0);
        assert!(windows[0].resets_at.unwrap() > 0);
        assert!(windows[1].resets_at.unwrap() > 0);
    }

    #[test]
    fn unknown_shape_yields_no_windows_not_fake_zero() {
        assert!(parse(&serde_json::json!({})).unwrap().is_empty());
    }

    #[test]
    fn strategy_declares_kimi() {
        assert_eq!(KimiUsage.kind(), ProviderKind::Kimi);
    }
}
