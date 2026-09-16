//! 常驻操作轨迹环（Flight Recorder Timeline）。
//!
//! 连续记录「有意义的操作」——主线程同步命令 enter/exit、chat-event emit、
//! 会话生命周期——冻结报告里保留撞墙前最后一串事件的时间线。
//!
//! **为什么需要它（与单槽 `CURRENT_COMMAND`/stuckCommand 互补）**：单槽只在主线程
//! 正卡在某条埋点同步命令里时有值。2026-07-08 第四次真实冻结是**低 CPU 主线程 park
//! 在命令之外**（emit 编组 / 事件循环 / 锁），stuckCommand 全 null，谁都定不到帧
//! （另有一次同类卡 21.9 分钟）。事后抓状态太迟——真正要的是「事发前到底发生了
//! 哪些事件」。这条时间线就是答案：读报告 `ring.trace` 尾部，最后一条 `cmd_enter`
//! 没配对 `cmd_exit` = 卡在那条命令；最后一条是 `emit` = 主线程 park 在 emit/事件
//! 循环侧，据此再收窄。
//!
//! 全程开启、低开销：每条 ≤ 每秒几十次（命令 + 合并后的 emit，高频 poll 不记），
//! `Mutex<VecDeque>` 足够（写入频率远低于锁争用阈值）。锁 poison 时静默跳过——
//! 常驻埋点绝不能把 app 带崩。

use std::collections::VecDeque;
use std::sync::{Mutex, TryLockError};
use std::time::Duration;

use super::report::{epoch_ms, TraceEvent};

/// 轨迹环容量：512 条 × ≈每秒几十条 ≈ 撞墙前最近十几秒，足够覆盖触发点。
const TRACE_RING_CAP: usize = 512;

/// `VecDeque::new()` 是 const，可直接静态初始化，无需 lazy/OnceLock。
static TRACE: Mutex<VecDeque<TraceEvent>> = Mutex::new(VecDeque::new());

/// 记一条轨迹。`kind`/`thread` 是 &'static（调用点静态已知），`name` 拷成 String。
pub fn record(kind: &'static str, name: &str, thread: &'static str) {
    if let Ok(mut buf) = TRACE.lock() {
        if buf.len() >= TRACE_RING_CAP {
            buf.pop_front();
        }
        buf.push_back(TraceEvent {
            t: epoch_ms(),
            kind,
            name: name.to_string(),
            thread,
        });
    }
}

/// 快照为 Vec（旧→新），落盘报告用。
///
/// **只用 `try_lock`（带极短重试），绝不阻塞**：调用方是 watchdog 报告线程，它
/// 是「谁卡都得活着」的最后一道防线。主线程每条命令/每次 beat 都碰 `TRACE`，万一
/// 恰好 park 在持锁瞬间（record 只按纳秒级持有，概率极低但非零），阻塞式 `lock()`
/// 会把报告线程一起拖死、连现场都写不出。拿不到就返回空——宁可这一份报告缺
/// trace，也不能让黑匣子失效。poison 同样返回空，不 panic。
pub fn snapshot() -> Vec<TraceEvent> {
    for _ in 0..5 {
        match TRACE.try_lock() {
            Ok(buf) => return buf.iter().cloned().collect(),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
            Err(TryLockError::Poisoned(_)) => return Vec::new(),
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::super::report::TraceEvent;
    use super::*;

    /// 本测试写的那些条目（其它测试的 record 不属于我们，必须能被过滤掉）。
    fn is_ours(e: &TraceEvent) -> bool {
        matches!(
            (e.kind, e.name.as_str()),
            ("cmd_enter", "git_log") | ("cmd_exit", "git_log") | ("emit", "text_delta")
        )
    }

    /// 把快照收窄成「从我们第一条起、往后的连续 ours 段」。
    ///
    /// 为什么不能直接拿全量快照断言：`TRACE` 是模块级 static，cargo test 默认并行，
    /// 其它用例埋了 `trace_command` 的路径会并发 `record()`，条目会插进我们的间隙
    /// （旧版直接断言全量，全量跑必挂、单跑必过——2026-09-14 实测）。真实写入路径
    /// 关不掉，所以判据改成「过滤出属于本用例的连续子序列」，对自己只做串行断言。
    fn ours_in_order() -> Vec<(&'static str, String, &'static str)> {
        let snap = snapshot();
        let start = match snap.iter().position(is_ours) {
            Some(i) => i,
            None => return Vec::new(),
        };
        snap[start..]
            .iter()
            .take_while(|e| is_ours(e))
            .map(|e| (e.kind, e.name.clone(), e.thread))
            .collect()
    }

    // 模块级 static，cargo test 默认并行——所有断言放同一个测试函数里串行执行，
    // 避免不同测试互相踩 TRACE（同 trace_command 的做法）。
    #[test]
    fn record_snapshot_and_ring_eviction() {
        // 顺序 + 字段 + 时间戳单调
        TRACE.lock().unwrap().clear();
        record("cmd_enter", "git_log", "main");
        record("emit", "text_delta", "worker");
        record("cmd_exit", "git_log", "main");
        assert_eq!(
            ours_in_order(),
            vec![
                ("cmd_enter", "git_log".to_string(), "main"),
                ("emit", "text_delta".to_string(), "worker"),
                ("cmd_exit", "git_log".to_string(), "main"),
            ]
        );
        let snap = snapshot();
        assert!(snap.windows(2).all(|w| w[0].t <= w[1].t));

        // 超容量淘汰最旧。并发写入会混进别人的条目，所以判据不是「长度恒等于 CAP」
        // （那是并行污染下的假断言），而是三件事同时成立：
        //   ① 我们连写 CAP+10 条后，环里**仍能看到我们的条目**（没被整体挤掉）；
        //   ② 环长度不超过容量（淘汰真的在生效）；
        //   ③ 我们的第一条已被淘汰——它后面还有 CAP+9 条我们自己写的，
        //      超出容量的部分必然把最旧的挤出去。
        TRACE.lock().unwrap().clear();
        for _ in 0..(TRACE_RING_CAP + 10) {
            record("emit", "text_delta", "worker");
        }
        let snap = snapshot();
        assert!(
            snap.iter().any(is_ours),
            "自己写的条目不该在环里消失（并发写入最多占一部分容量）"
        );
        assert!(
            snap.len() <= TRACE_RING_CAP,
            "环长度 {} 超过容量 {}",
            snap.len(),
            TRACE_RING_CAP
        );
        let ours = ours_in_order();
        assert!(
            !ours
                .iter()
                .any(|(k, n, _)| (*k, n.as_str()) == ("cmd_enter", "git_log")),
            "第一条（cmd_enter/git_log）应已被淘汰，实际仍在前段"
        );
        assert!(
            ours.len() >= TRACE_RING_CAP - 1,
            "被并发写入挤占后我们仍应有 ≈CAP 条在环里，实际 {}",
            ours.len()
        );
    }
}
