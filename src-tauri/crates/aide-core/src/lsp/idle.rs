//! 语言服务器空闲休眠（设计见 docs/superpowers/specs/2026-10-14-lsp-switch-readiness-design.md §4.5）。
//!
//! **判据在 server 侧，与会话解耦**：server 实例按（工作区, 语言）唯一，同工作区的多个会话与编辑器
//! 共用一台；每台记 `last_used`（请求、打开 / 编辑文档时刷新）。关掉一个会话不影响另一个仍在用的；
//! 会话开着但很久没有任何 LSP 请求，照样休眠。编辑器开着该语言的文件时不休眠（用户随时会跳转）。
//!
//! 休眠 = 停进程、状态进 `Sleeping`，**开关不变**：下一条 send 的预热、任何查询、编辑器打开文件都会
//! 把它重新拉起（`ensure_server` 只认开关，不认休眠）。

use std::sync::Arc;
use std::time::Duration;

use crate::lsp::status_board::{Phase, StatusBoard};
use crate::lsp::LspState;
use crate::settings::SettingsService;

/// 巡检间隔。倒计时误差另受 `status_board::SLEEP_AT_SLACK_MS` 约束。
const TICK: Duration = Duration::from_secs(30);

/// 一台 server 这一轮的判定。
#[derive(Debug, PartialEq, Eq)]
pub struct IdleVerdict {
    /// 预计休眠的时间点（unix ms）；编辑器开着文件 / 永不休眠时为 None。
    pub sleep_at: Option<u64>,
    pub kept_by: Option<&'static str>,
    pub sleep_now: bool,
}

/// 纯判定。`idle_ms == 0` = 永不休眠。
pub fn judge(now: u64, last_used: u64, editor_open: bool, idle_ms: u64) -> IdleVerdict {
    if idle_ms == 0 {
        return IdleVerdict { sleep_at: None, kept_by: None, sleep_now: false };
    }
    if editor_open {
        return IdleVerdict { sleep_at: None, kept_by: Some("editor"), sleep_now: false };
    }
    let sleep_at = last_used.saturating_add(idle_ms);
    IdleVerdict { sleep_at: Some(sleep_at), kept_by: None, sleep_now: now >= sleep_at }
}

/// 起巡检任务（每个 Host 一个；第一台 server 拉起时由 `LspManager::ensure_server` 调）。
pub fn spawn_reaper(lsp: Arc<LspState>, board: Arc<StatusBoard>, settings: Arc<SettingsService>) {
    tokio::spawn(async move {
        let sys = Arc::new(std::sync::Mutex::new(sysinfo::System::new()));
        loop {
            let minutes = crate::app_settings::public_settings(&settings)
                .ok()
                .and_then(|s| s.lsp.idle_sleep_minutes)
                .unwrap_or(crate::app_settings::DEFAULT_LSP_IDLE_SLEEP_MINUTES);
            let idle_ms = u64::from(minutes) * 60_000;
            let handles = lsp.0.read().await.alive_handles().await;
            // 顺带采样每台 server 进程树的内存（「语言环境」面板显示占用）。全量刷新进程表在
            // blocking 池里做；采样失败只是不显示，不影响休眠判定。
            let mut pids = Vec::new();
            for (key, h) in &handles {
                if let Some(pid) = h.pid().await {
                    pids.push((key.clone(), pid));
                }
            }
            if !pids.is_empty() {
                let sys = Arc::clone(&sys);
                let sampled = tokio::task::spawn_blocking(move || {
                    let Ok(mut sys) = sys.lock() else { return Vec::new() };
                    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                    pids.into_iter().map(|(key, pid)| (key, tree_memory(&sys, pid))).collect::<Vec<_>>()
                })
                .await
                .unwrap_or_default();
                for ((ws, lang), bytes) in sampled {
                    if bytes > 0 {
                        board.set_memory(&ws, lang, bytes);
                    }
                }
            }
            let now = crate::lsp::manager::now_ms();
            for ((ws, lang), h) in handles {
                let editor_open = h.docs.lock().await.has_editor_docs();
                let last = h.last_used.load(std::sync::atomic::Ordering::Relaxed);
                let v = judge(now, last, editor_open, idle_ms);
                if v.sleep_now {
                    tracing::info!(ws, lang = lang.id_str(), minutes, "lsp: 空闲休眠");
                    // 先取消探测、置 Sleeping，再停机（reader EOF 看到 Sleeping 不会改写成 Off）
                    board.stop_lang(&ws, lang, Phase::Sleeping);
                    lsp.0.write().await.kill_server(&ws, lang).await;
                } else {
                    board.set_sleep(&ws, lang, v.sleep_at, v.kept_by);
                }
            }
            // 先跑一轮再睡：刚拉起的 server 立刻有内存读数，不必干等 30s
            tokio::time::sleep(TICK).await;
        }
    });
}

/// 进程 `root` 及其全部子孙的内存之和（字节）。要算子孙：Windows 上 PATH 里的
/// `javapath\java.exe` 只是转发壳，真正的 JVM 是它起的子进程（2026-10-15 实测）。
fn tree_memory(sys: &sysinfo::System, root: u32) -> u64 {
    let root = sysinfo::Pid::from_u32(root);
    sys.processes()
        .iter()
        .filter(|(pid, _)| descends_from(sys, **pid, root))
        .map(|(_, p)| p.memory())
        .sum()
}

fn descends_from(sys: &sysinfo::System, pid: sysinfo::Pid, root: sysinfo::Pid) -> bool {
    let mut cur = Some(pid);
    for _ in 0..32 {
        match cur {
            Some(p) if p == root => return true,
            Some(p) => cur = sys.process(p).and_then(|x| x.parent()),
            None => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN30: u64 = 30 * 60_000;

    #[test]
    fn sleeps_after_threshold() {
        assert_eq!(
            judge(MIN30 + 1, 1, false, MIN30),
            IdleVerdict { sleep_at: Some(MIN30 + 1), kept_by: None, sleep_now: true }
        );
        assert!(!judge(MIN30, 1, false, MIN30).sleep_now);
    }

    #[test]
    fn editor_open_keeps_it_awake() {
        let v = judge(10 * MIN30, 0, true, MIN30);
        assert!(!v.sleep_now);
        assert_eq!(v.kept_by, Some("editor"));
        assert_eq!(v.sleep_at, None);
    }

    /// 本进程自己就是一棵「进程树」：内存采样拿得到读数（> 0）。
    #[test]
    fn samples_own_process_tree() {
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        assert!(tree_memory(&sys, std::process::id()) > 0);
    }

    #[test]
    fn zero_means_never() {
        let v = judge(u64::MAX, 0, false, 0);
        assert!(!v.sleep_now);
        assert_eq!(v.sleep_at, None);
    }
}
