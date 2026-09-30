//! 会话有效期的算术（纯函数，**不碰数据库**——碰了就测不了）。
//!
//! 语义是「滑动续期 + 绝对上限」（spec §4.3）：
//!
//! - **滑动**：一直在用就一直不用重新登录。代价是泄露的凭据「只要攻击者一直
//!   在用就不过期」——这正是绝对上限存在的唯一理由。
//! - **绝对上限**：钉在 `created_at` 上，不随续期移动。钉在 `expires_at` 上
//!   就等于给续期开了无限额度，那条上限永远到不了。
//!
//! 节流：续期要写库，每个请求都写纯属浪费（而且本服务鉴权是每请求一次）。
//! 只在「剩余不足一个节流窗口」时才续 —— 一天最多写一次。

use chrono::{DateTime, Duration, Utc};

/// 会话的绝对死线：从**创建时刻**起算，与后来续过多少次无关。
pub fn hard_deadline(created_at: DateTime<Utc>, hard_ttl_hours: i64) -> DateTime<Utc> {
    created_at + Duration::hours(hard_ttl_hours)
}

/// 续期阈值：`expires_at` 早于它才值得写一次库。
///
/// `now + ttl - throttle`：还剩得比一个节流窗口多，就不动它。
pub fn slide_threshold(now: DateTime<Utc>, ttl_hours: i64, throttle_hours: i64) -> DateTime<Utc> {
    now + Duration::hours(ttl_hours.saturating_sub(throttle_hours))
}

/// 绝对上限的**等价下界**：`created_at` 必须晚于它，会话才还活着。
///
/// 判据用 `created_at > now - hard_ttl` 而不是给每行算 `created_at + hard_ttl`，
/// 是因为前者是常量、能走索引；两者在数学上等价（见测试）。
pub fn earliest_live_created_at(now: DateTime<Utc>, hard_ttl_hours: i64) -> DateTime<Utc> {
    now - Duration::hours(hard_ttl_hours)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn t(hours: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 30, 0, 0, 0).unwrap() + Duration::hours(hours)
    }

    #[test]
    fn hard_deadline_is_anchored_to_creation_not_to_last_use() {
        // 绝对上限必须钉在 created_at 上——钉在 expires_at 上就永远到不了
        let c = t(0);
        assert_eq!(hard_deadline(c, 24 * 90), c + Duration::hours(24 * 90));
    }

    /// 节流：阈值落在「已经用掉一个节流窗口」那一刻——
    /// 也就是说，一个 14 天窗口的会话，第 2 天之后的第一次使用才会写库，
    /// 此后每 13 天最多写一次，而不是每个请求都写。
    #[test]
    fn slide_threshold_leaves_most_of_the_window_alone() {
        let now = t(100);
        let threshold = slide_threshold(now, 24 * 14, 24);
        assert_eq!(threshold, now + Duration::hours(24 * 13));
    }

    #[test]
    fn a_fresh_session_is_not_slid() {
        let now = t(0);
        let threshold = slide_threshold(now, 24 * 14, 24);
        // 刚建出来的 session，expires_at 远晚于阈值 → 不该触发写
        assert!(now + Duration::hours(24 * 14) > threshold);
    }

    /// 真正要钉住的行为：**快到期**的会话必须被续，否则「一直在用」
    /// 也会在 14 天头上掉线（免登录每两周破功一次，正是要修的那件事）。
    #[test]
    fn a_session_running_out_is_slid() {
        let created = t(0);
        let ttl = 24 * 14;
        // 建出来 12 天后才想起来用：窗口 14 天，此刻只剩 2 天
        let now = created + Duration::hours(24 * 12);
        let expires_at = created + Duration::hours(ttl);

        let threshold = slide_threshold(now, ttl, 24);
        assert!(expires_at < threshold, "快到期时必须续期（否则第 14 天掉线）");
        // 而续期后立刻又不满足了 → 不会每个请求都写库
        assert!(now + Duration::hours(ttl) > threshold);
    }

    /// 判据的两种写法必须等价：`created_at > earliest_live(now)` ⟺
    /// `hard_deadline(created_at) > now`。SQL 里用的是前者的变形。
    #[test]
    fn the_bound_is_equivalent_to_the_hard_deadline() {
        let now = t(24 * 91);
        let hard_ttl = 24 * 90;
        let bound = earliest_live_created_at(now, hard_ttl);

        for created in [t(0), t(24 * 89), t(24 * 90), t(24 * 91)] {
            let alive_by_deadline = hard_deadline(created, hard_ttl) > now;
            let alive_by_bound = created > bound;
            assert_eq!(alive_by_deadline, alive_by_bound, "created={created}");
        }
    }
}
