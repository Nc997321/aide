//! schedule.rs 的全分支单测。所有时间用 naive 墙钟构造，与机器时区无关。
//! 日期锚点：2026-08-21 是周五（iso=5）。

use super::schedule::*;
use super::{AutomationTaskInput, IntervalUnit, MissedPolicy, PermissionPreset, Schedule};
use chrono::{Datelike, NaiveDate, NaiveDateTime, Weekday};

fn dt(s: &str) -> NaiveDateTime {
    parse_dt(s).unwrap()
}

#[test]
fn anchor_date_is_friday() {
    // 测试前提自检：后续 weekly 用例都建立在这个事实上
    assert_eq!(NaiveDate::from_ymd_opt(2026, 8, 21).unwrap().weekday(), Weekday::Fri);
}

// ── daily ──

#[test]
fn daily_next_same_day_when_time_not_passed() {
    let s = Schedule::Daily { time: "18:30".into() };
    let now = dt("2026-08-21T09:00:00");
    assert_eq!(next_fire(&s, now, now), Some(dt("2026-08-21T18:30:00")));
}

#[test]
fn daily_next_tomorrow_when_time_passed() {
    let s = Schedule::Daily { time: "18:30".into() };
    let now = dt("2026-08-21T18:30:00"); // 恰好等于触发点也算已过（严格大于）
    assert_eq!(next_fire(&s, now, now), Some(dt("2026-08-22T18:30:00")));
}

#[test]
fn daily_last_today_or_yesterday() {
    let s = Schedule::Daily { time: "18:30".into() };
    let after = dt("2026-08-21T19:00:00");
    assert_eq!(last_scheduled_fire(&s, after, after), Some(dt("2026-08-21T18:30:00")));
    let before = dt("2026-08-21T09:00:00");
    assert_eq!(last_scheduled_fire(&s, before, before), Some(dt("2026-08-20T18:30:00")));
}

// ── weekly ──

#[test]
fn weekly_next_picks_nearest_matching_weekday() {
    // 周一+周五 09:00；周五 08:00 → 今天；周五 10:00 → 下周一（08-24）
    let s = Schedule::Weekly { time: "09:00".into(), weekdays: vec![1, 5] };
    let fri_morning = dt("2026-08-21T08:00:00");
    assert_eq!(next_fire(&s, fri_morning, fri_morning), Some(dt("2026-08-21T09:00:00")));
    let fri_noon = dt("2026-08-21T10:00:00");
    assert_eq!(next_fire(&s, fri_noon, fri_noon), Some(dt("2026-08-24T09:00:00")));
}

#[test]
fn weekly_last_scans_back_over_weekend() {
    // 仅周五 17:00；周六中午回看 → 昨天（周五）
    let s = Schedule::Weekly { time: "17:00".into(), weekdays: vec![5] };
    let sat = dt("2026-08-22T12:00:00");
    assert_eq!(last_scheduled_fire(&s, sat, sat), Some(dt("2026-08-21T17:00:00")));
}

#[test]
fn weekly_empty_weekdays_is_invalid() {
    let s = Schedule::Weekly { time: "09:00".into(), weekdays: vec![] };
    let now = dt("2026-08-21T08:00:00");
    assert_eq!(next_fire(&s, now, now), None);
    assert_eq!(last_scheduled_fire(&s, now, now), None);
}

// ── monthly ──

#[test]
fn monthly_clamps_day_to_month_length() {
    // 31 号任务在 2 月（2026 平年 28 天）钳到 28 号
    let s = Schedule::Monthly { time: "09:00".into(), day: 31 };
    let feb = dt("2026-02-10T12:00:00");
    assert_eq!(next_fire(&s, feb, feb), Some(dt("2026-02-28T09:00:00")));
}

#[test]
fn monthly_rolls_to_next_month_after_fire_day() {
    let s = Schedule::Monthly { time: "09:00".into(), day: 15 };
    let now = dt("2026-08-15T09:00:00"); // 恰等于触发点 → 已过
    assert_eq!(next_fire(&s, now, now), Some(dt("2026-09-15T09:00:00")));
    assert_eq!(last_scheduled_fire(&s, now, now), Some(dt("2026-08-15T09:00:00")));
}

#[test]
fn monthly_rolls_over_year_boundary() {
    let s = Schedule::Monthly { time: "00:30".into(), day: 1 };
    let now = dt("2026-12-01T01:00:00");
    assert_eq!(next_fire(&s, now, now), Some(dt("2027-01-01T00:30:00")));
}

// ── interval ──

#[test]
fn interval_next_is_anchor_when_before_anchor() {
    let s = Schedule::Interval { every: 2, unit: IntervalUnit::Hours };
    let anchor = dt("2026-08-21T18:00:00");
    let now = dt("2026-08-21T09:00:00");
    assert_eq!(next_fire(&s, anchor, now), Some(anchor));
    assert_eq!(last_scheduled_fire(&s, anchor, now), None);
}

#[test]
fn interval_grid_is_fixed_to_anchor_not_last_run() {
    // 每 2 小时，锚点 08:00：触发网格 08/10/12/14…；now=13:30 → last=12:00, next=14:00
    let s = Schedule::Interval { every: 2, unit: IntervalUnit::Hours };
    let anchor = dt("2026-08-21T08:00:00");
    let now = dt("2026-08-21T13:30:00");
    assert_eq!(last_scheduled_fire(&s, anchor, now), Some(dt("2026-08-21T12:00:00")));
    assert_eq!(next_fire(&s, anchor, now), Some(dt("2026-08-21T14:00:00")));
}

#[test]
fn interval_exact_grid_point_counts_as_due() {
    let s = Schedule::Interval { every: 30, unit: IntervalUnit::Minutes };
    let anchor = dt("2026-08-21T08:00:00");
    let now = dt("2026-08-21T09:30:00"); // 恰好是网格点
    assert_eq!(last_scheduled_fire(&s, anchor, now), Some(now));
}

#[test]
fn interval_zero_every_is_invalid() {
    let s = Schedule::Interval { every: 0, unit: IntervalUnit::Hours };
    let now = dt("2026-08-21T09:00:00");
    assert_eq!(next_fire(&s, now, now), None);
    assert_eq!(last_scheduled_fire(&s, now, now), None);
}

// ── once ──

#[test]
fn once_fires_then_retires() {
    let s = Schedule::Once { at: "2026-08-25T10:00".into() }; // 无秒也可解析
    let before = dt("2026-08-21T09:00:00");
    assert_eq!(next_fire(&s, before, before), Some(dt("2026-08-25T10:00:00")));
    assert_eq!(last_scheduled_fire(&s, before, before), None);
    let after = dt("2026-08-25T11:00:00");
    assert_eq!(next_fire(&s, after, after), None);
    assert_eq!(last_scheduled_fire(&s, after, after), Some(dt("2026-08-25T10:00:00")));
}

// ── validRange ──

#[test]
fn valid_range_boundaries() {
    let d = NaiveDate::from_ymd_opt(2026, 8, 21).unwrap();
    assert!(in_valid_range(None, None, d));
    assert!(in_valid_range(Some("2026-08-21"), Some("2026-08-21"), d)); // 当天含边界
    assert!(!in_valid_range(Some("2026-08-22"), None, d));
    assert!(!in_valid_range(None, Some("2026-08-20"), d));
}

#[test]
fn valid_range_corrupt_bound_fails_closed() {
    let d = NaiveDate::from_ymd_opt(2026, 8, 21).unwrap();
    assert!(!in_valid_range(Some("not-a-date"), None, d));
    assert!(!in_valid_range(None, Some("2026/08/30"), d));
}

// ── validate_input ──

fn valid_input() -> AutomationTaskInput {
    AutomationTaskInput {
        name: "日报".into(),
        prompt: "汇总提交".into(),
        workspace_path: None,
        model: "claude-sonnet-5".into(),
        effort: "medium".into(),
        permission_preset: PermissionPreset::Auto,
        connectors: vec![],
        schedule: Schedule::Daily { time: "18:30".into() },
        valid_from: None,
        valid_to: None,
        missed_policy: MissedPolicy::Catchup,
        playbook_enabled: true,
        notify_success: true,
        notify_failure: true,
        enabled: true,
    }
}

#[test]
fn validate_accepts_valid_input() {
    assert!(validate_input(&valid_input()).is_ok());
}

#[test]
fn validate_rejects_bad_fields() {
    let cases: Vec<fn(&mut AutomationTaskInput)> = vec![
        |i| i.name = "  ".into(),
        |i| i.prompt = String::new(),
        |i| i.schedule = Schedule::Daily { time: "25:00".into() },
        |i| i.schedule = Schedule::Weekly { time: "09:00".into(), weekdays: vec![] },
        |i| i.schedule = Schedule::Weekly { time: "09:00".into(), weekdays: vec![0] },
        |i| i.schedule = Schedule::Monthly { time: "09:00".into(), day: 32 },
        |i| i.schedule = Schedule::Interval { every: 0, unit: IntervalUnit::Days },
        |i| i.schedule = Schedule::Once { at: "八月二十五".into() },
        |i| i.effort = "ultra".into(),
        |i| {
            i.valid_from = Some("2026-09-01".into());
            i.valid_to = Some("2026-08-01".into());
        },
    ];
    for (idx, mutate) in cases.iter().enumerate() {
        let mut i = valid_input();
        mutate(&mut i);
        assert!(validate_input(&i).is_err(), "case {idx} 应该被拒绝");
    }
}

// ── serde 线格式（前端契约，防手滑改字段名） ──

#[test]
fn schedule_serde_wire_format() {
    let s = Schedule::Weekly { time: "09:00".into(), weekdays: vec![1, 5] };
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v, serde_json::json!({ "kind": "weekly", "time": "09:00", "weekdays": [1, 5] }));
    let back: Schedule = serde_json::from_value(v).unwrap();
    assert_eq!(back, s);
}
