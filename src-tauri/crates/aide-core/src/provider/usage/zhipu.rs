//! 智谱用量策略：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`。
//!
//! 控制台「用量统计」页调用的 monitor 端点，非公开 API。响应 `data.limits[]`：
//! `unit` 1秒/2分/3时/4天/5月/6年 + `number` 决定窗口；`TOKENS_LIMIT` 的
//! `percentage` 就是已用百分比；`TIME_LIMIT` 用 `currentValue/usage` 算。
//! `nextResetTime` 已是 unix 毫秒，直接透传。鉴权用套餐 Key 的 Bearer。

use serde_json::Value;

use super::{bearer, get_json, ms, num_at, push_window, str_at, utilization, window};
use crate::provider::{ProviderConfig, ProviderKind};

const USAGE_URL: &str = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

pub struct ZhipuUsage;

impl super::UsageStrategy for ZhipuUsage {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Zhipu
    }

    fn fetch(&self, cfg: &ProviderConfig) -> Result<Vec<super::UsageWindow>, String> {
        let body = get_json(USAGE_URL, &bearer(cfg)?)?;
        parse(&body)
    }
}

fn parse(body: &Value) -> Result<Vec<super::UsageWindow>, String> {
    let limits = body
        .get("data")
        .and_then(|d| d.get("limits"))
        .and_then(Value::as_array)
        .ok_or_else(|| "用量接口响应缺少 data.limits（接口可能已变更）".to_string())?;
    let mut out = Vec::new();
    for l in limits {
        let pct = if str_at(l, "type") == Some("TIME_LIMIT") {
            utilization(num_at(l, "currentValue"), num_at(l, "usage"))
        } else {
            num_at(l, "percentage")
        }
        .or_else(|| utilization(num_at(l, "currentValue"), num_at(l, "usage")))
        .or_else(|| num_at(l, "percentage"));
        let (key, label) = window_label(
            num_at(l, "unit").unwrap_or(0.0) as i64,
            num_at(l, "number").unwrap_or(0.0) as i64,
        );
        if let Some(pct) = pct {
            push_window(
                &mut out,
                window(
                    &key,
                    &label,
                    pct.clamp(0.0, 100.0),
                    ms(l.get("nextResetTime")),
                ),
            );
        }
    }
    Ok(out)
}

fn window_label(unit: i64, number: i64) -> (String, String) {
    match (unit, number) {
        (3, 5) => ("five_hour".into(), "5 小时".into()),
        (4, 7) => ("seven_day".into(), "7 天".into()),
        (5, 1) => ("monthly".into(), "本月".into()),
        (u, n) => {
            let name = match u {
                1 => "秒",
                2 => "分钟",
                3 => "小时",
                4 => "天",
                5 => "月",
                6 => "年",
                _ => "周期",
            };
            (format!("window_{u}_{n}"), format!("{n} {name}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::usage::UsageStrategy;

    // fixture 原文来自 jiegec/coding-plan-usage 的 tests/test_bigmodel.py
    const RESPONSE: &str = r#"{
      "code":200,"msg":"操作成功","success":true,
      "data":{"level":"lite","limits":[
        {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":42,"nextResetTime":1769776934422},
        {"type":"TIME_LIMIT","unit":5,"number":1,"usage":100,"currentValue":92,"remaining":8,
         "percentage":92,"nextResetTime":1769776934422}
      ]}
    }"#;

    #[test]
    fn parses_five_hour_and_month_windows() {
        let body: Value = serde_json::from_str(RESPONSE).unwrap();
        let windows = parse(&body).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].key, "five_hour");
        assert_eq!(windows[0].utilization, 42.0);
        assert_eq!(windows[0].resets_at, Some(1769776934422));
        assert_eq!(windows[1].key, "monthly");
        assert_eq!(windows[1].utilization, 92.0);
        assert_eq!(windows[1].resets_at, Some(1769776934422));
    }

    #[test]
    fn missing_limits_is_an_error_not_empty_success() {
        assert!(parse(&serde_json::json!({"data":{}})).is_err());
    }

    #[test]
    fn strategy_declares_zhipu() {
        assert_eq!(ZhipuUsage.kind(), ProviderKind::Zhipu);
    }
}
