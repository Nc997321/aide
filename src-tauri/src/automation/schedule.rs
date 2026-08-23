//! 调度时间运算：全部纯函数、本地墙钟（NaiveDateTime）语义。
//!
//! 刻意不做 UTC/DST 换算——「每天 18:30」跟随用户本地墙钟，跨时区/DST 切换时
//! 语义仍是「当地的 18:30」，这正是一个桌面端定时任务该有的行为。
//!
//! 两组核心函数：
//! - `next_fire`：now 之后的下一个触发点（列表展示「下次运行」用）
//! - `last_scheduled_fire`：now 之前（含）的最近触发点（due 判定与 missed-run 检测用——
//!   触发点 > lastRunAt 即该跑）

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime};

use super::{AutomationTaskInput, IntervalUnit, Schedule};

/// "HH:MM" → NaiveTime。
pub fn parse_hhmm(s: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(s, "%H:%M").map_err(|_| format!("无效时间格式（期望 HH:MM）: {s:?}"))
}

/// 本地 ISO 日期时间：接受 "YYYY-MM-DDTHH:MM" 或带秒。
pub fn parse_dt(s: &str) -> Result<NaiveDateTime, String> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
        .map_err(|_| format!("无效日期时间格式: {s:?}"))
}

/// "YYYY-MM-DD" → NaiveDate。
pub fn parse_date(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| format!("无效日期格式（期望 YYYY-MM-DD）: {s:?}"))
}

/// 统一落盘格式（带秒）。
pub fn fmt_dt(dt: NaiveDateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// 某年某月的天数（monthly 钳日用）。
fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    // 次月 1 号的前一天 = 当月最后一天
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(30)
}

/// ISO  weekday：周一=1 .. 周日=7。
fn iso_weekday(d: NaiveDate) -> u8 {
    (d.weekday().num_days_from_monday() + 1) as u8
}

fn at_time(d: NaiveDate, t: NaiveTime) -> NaiveDateTime {
    d.and_time(t)
}

/// now 之后的下一个触发点（严格大于 now）。非法调度返回 None。
/// `anchor` 仅 interval 用（= createdAt，固定网格不随运行漂移）。
/// M3 列表「下次运行」展示消费（M1 只有单测引用）。
#[allow(dead_code)]
pub fn next_fire(schedule: &Schedule, anchor: NaiveDateTime, now: NaiveDateTime) -> Option<NaiveDateTime> {
    match schedule {
        Schedule::Daily { time } => {
            let t = parse_hhmm(time).ok()?;
            let today = at_time(now.date(), t);
            Some(if today > now { today } else { at_time(now.date() + Duration::days(1), t) })
        }
        Schedule::Weekly { time, weekdays } => {
            let t = parse_hhmm(time).ok()?;
            if weekdays.is_empty() {
                return None;
            }
            for offset in 0..=7i64 {
                let d = now.date() + Duration::days(offset);
                if weekdays.contains(&iso_weekday(d)) {
                    let cand = at_time(d, t);
                    if cand > now {
                        return Some(cand);
                    }
                }
            }
            None
        }
        Schedule::Monthly { time, day } => {
            let t = parse_hhmm(time).ok()?;
            let (mut y, mut m) = (now.year(), now.month());
            for _ in 0..2 {
                let clamped = (*day as u32).min(days_in_month(y, m));
                let cand = at_time(NaiveDate::from_ymd_opt(y, m, clamped)?, t);
                if cand > now {
                    return Some(cand);
                }
                // 滚到下个月
                if m == 12 {
                    y += 1;
                    m = 1;
                } else {
                    m += 1;
                }
            }
            None
        }
        Schedule::Interval { every, unit } => {
            let delta = interval_duration(*every, *unit)?;
            if now < anchor {
                return Some(anchor);
            }
            let elapsed = (now - anchor).num_seconds();
            let step = delta.num_seconds();
            let k = elapsed / step; // floor
            Some(anchor + Duration::seconds((k + 1) * step))
        }
        Schedule::Once { at } => {
            let at = parse_dt(at).ok()?;
            (at > now).then_some(at)
        }
    }
}

/// now 之前（含）的最近触发点。None = 调度网格还没走到第一个点（once 未到 /
/// interval 锚点在未来）。due 判定：`last_scheduled_fire(...) > lastRunAt`。
pub fn last_scheduled_fire(schedule: &Schedule, anchor: NaiveDateTime, now: NaiveDateTime) -> Option<NaiveDateTime> {
    match schedule {
        Schedule::Daily { time } => {
            let t = parse_hhmm(time).ok()?;
            let today = at_time(now.date(), t);
            Some(if today <= now { today } else { at_time(now.date() - Duration::days(1), t) })
        }
        Schedule::Weekly { time, weekdays } => {
            let t = parse_hhmm(time).ok()?;
            if weekdays.is_empty() {
                return None;
            }
            for offset in 0..=7i64 {
                let d = now.date() - Duration::days(offset);
                if weekdays.contains(&iso_weekday(d)) {
                    let cand = at_time(d, t);
                    if cand <= now {
                        return Some(cand);
                    }
                }
            }
            None
        }
        Schedule::Monthly { time, day } => {
            let t = parse_hhmm(time).ok()?;
            let (mut y, mut m) = (now.year(), now.month());
            for _ in 0..2 {
                let clamped = (*day as u32).min(days_in_month(y, m));
                let cand = at_time(NaiveDate::from_ymd_opt(y, m, clamped)?, t);
                if cand <= now {
                    return Some(cand);
                }
                if m == 1 {
                    y -= 1;
                    m = 12;
                } else {
                    m -= 1;
                }
            }
            None
        }
        Schedule::Interval { every, unit } => {
            let delta = interval_duration(*every, *unit)?;
            if now < anchor {
                return None;
            }
            let elapsed = (now - anchor).num_seconds();
            let k = elapsed / delta.num_seconds();
            Some(anchor + Duration::seconds(k * delta.num_seconds()))
        }
        Schedule::Once { at } => {
            let at = parse_dt(at).ok()?;
            (at <= now).then_some(at)
        }
    }
}

fn interval_duration(every: u32, unit: IntervalUnit) -> Option<Duration> {
    if every == 0 {
        return None;
    }
    let secs = match unit {
        IntervalUnit::Minutes => every as i64 * 60,
        IntervalUnit::Hours => every as i64 * 3600,
        IntervalUnit::Days => every as i64 * 86400,
    };
    Some(Duration::seconds(secs))
}

/// 生效区间判定。区间边界损坏时 fail-closed（不触发）并告警——
/// 宁可漏跑一次，也不在配置损坏时无人值守乱跑。
pub fn in_valid_range(valid_from: Option<&str>, valid_to: Option<&str>, date: NaiveDate) -> bool {
    if let Some(f) = valid_from {
        match parse_date(f) {
            Ok(f) if date >= f => {}
            Ok(_) => return false,
            Err(e) => {
                tracing::warn!("[automation] validFrom 损坏，任务按不生效处理: {}", e);
                return false;
            }
        }
    }
    if let Some(t) = valid_to {
        match parse_date(t) {
            Ok(t) if date <= t => {}
            Ok(_) => return false,
            Err(e) => {
                tracing::warn!("[automation] validTo 损坏，任务按不生效处理: {}", e);
                return false;
            }
        }
    }
    true
}

/// 输入校验（create/update 命令调用）。错误信息面向用户，直接进 toast。
pub fn validate_input(input: &AutomationTaskInput) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("名称不能为空".into());
    }
    if input.prompt.trim().is_empty() {
        return Err("提示词不能为空".into());
    }
    match &input.schedule {
        Schedule::Daily { time } => {
            parse_hhmm(time)?;
        }
        Schedule::Weekly { time, weekdays } => {
            parse_hhmm(time)?;
            if weekdays.is_empty() {
                return Err("每周任务至少选择一个星期几".into());
            }
            if weekdays.iter().any(|d| !(1..=7).contains(d)) {
                return Err("星期取值必须在 1（周一）到 7（周日）之间".into());
            }
        }
        Schedule::Monthly { time, day } => {
            parse_hhmm(time)?;
            if !(1..=31).contains(day) {
                return Err("每月日期必须在 1 到 31 之间".into());
            }
        }
        Schedule::Interval { every, .. } => {
            if *every == 0 {
                return Err("间隔必须大于 0".into());
            }
        }
        Schedule::Once { at } => {
            parse_dt(at)?;
        }
    }
    if let (Some(f), Some(t)) = (&input.valid_from, &input.valid_to) {
        let f = parse_date(f)?;
        let t = parse_date(t)?;
        if f > t {
            return Err("生效区间的开始日期不能晚于结束日期".into());
        }
    }
    const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
    if !EFFORTS.contains(&input.effort.as_str()) {
        return Err(format!("无效的 effort 档位: {:?}", input.effort));
    }
    // model 允许为空 = 跟随提供商默认（自定义 provider 的兜底）；
    // 显式指定时不校验取值（provider 专属 id 前端下拉给出）。
    Ok(())
}
