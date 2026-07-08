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
        buf.push_back(TraceEvent { t: epoch_ms(), kind, name: name.to_string(), thread });
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
    use super::*;

    // 模块级 static，cargo test 默认并行——所有断言放同一个测试函数里串行执行，
    // 避免不同测试互相踩 TRACE（同 trace_command 的做法）。
    #[test]
    fn record_snapshot_and_ring_eviction() {
        // 顺序 + 字段 + 时间戳单调
        TRACE.lock().unwrap().clear();
        record("cmd_enter", "git_log", "main");
        record("emit", "text_delta", "worker");
        record("cmd_exit", "git_log", "main");
        let snap = snapshot();
        let flat: Vec<(&str, &str, &str)> = snap
            .iter()
            .map(|e| (e.kind, e.name.as_str(), e.thread))
            .collect();
        assert_eq!(
            flat,
            vec![
                ("cmd_enter", "git_log", "main"),
                ("emit", "text_delta", "worker"),
                ("cmd_exit", "git_log", "main"),
            ]
        );
        assert!(snap.windows(2).all(|w| w[0].t <= w[1].t));

        // 超容量淘汰最旧：填满 + 10，稳定在 CAP
        TRACE.lock().unwrap().clear();
        for _ in 0..(TRACE_RING_CAP + 10) {
            record("emit", "x", "worker");
        }
        assert_eq!(snapshot().len(), TRACE_RING_CAP);
    }
}
