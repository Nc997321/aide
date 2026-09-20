//! 冻结报告的自检装置：`AIDE_FREEZE_SELFCHECK=<毫秒>` 启动后**注入一场真冻结**，
//! 等 watchdog 落盘报告，再逐项审这份报告是否「现场拿全」，结论落
//! `selfcheck-<epoch>.json`，退出码 = verdict（0 全绿）。
//!
//! 为什么要有它（2026-09-17 教训）：上一轮「LoAF 必能抓到根因」是**没验投递链就
//! 许的愿**——全量明细落在 `frontend` 字段，而该字段在 20/20 份历史报告里都是空的
//! （报告收尾重写把它抹了）。自检把「仪器真的产出完整现场」变成可复跑的一条命令：
//! 它不过，就不该拿这份报告去定案。
//!
//! 同文件原先还挂着 `AIDE_EMIT_EXPERIMENT`（2026-07 那轮「tauri emit 投递就是根因」
//! 的复跑装置）——那个假设已被受控实验**证伪**（结论见
//! docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md 与记忆
//! `aide-session-init-freeze-rootcause`），装置本身于 2026-09-20 随诊断瘦身移除。
//!
//! 审报告那一半（`report::audit` / `report::write_selfcheck`）在 report.rs。

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// 阻塞时长夹逼：太短测不出冻结（watchdog 判定阈值 2s），太长自检自己变成事故。
const MIN_DURATION_MS: u64 = 500;
const MAX_DURATION_MS: u64 = 60_000;
/// 等前端心跳就绪的上限，以及就绪后的静置——`listen()` 是异步注册的。
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_SETTLE: Duration = Duration::from_secs(2);
/// 心跳新鲜度判据：前端 500ms 一跳，2s 内有过就算活着。
const HEARTBEAT_FRESH: Duration = Duration::from_millis(2000);

pub fn selfcheck_on_startup(app: &AppHandle) {
    let Some(ms) = std::env::var("AIDE_FREEZE_SELFCHECK")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        if !wait_frontend_ready(&app, READY_TIMEOUT) {
            eprintln!("[freeze-selfcheck] 前端心跳未就绪，放弃（空监听器下测不出东西）");
            app.exit(2);
            return;
        }
        let block = clamp_duration(ms);
        let since = super::report::epoch_ms();
        println!(
            "[freeze-selfcheck] 注入 {}ms 渲染阻塞，制造真冻结…",
            block.as_millis()
        );
        block_renderer(&app, block);
        let Some((path, finalized)) = wait_for_freeze_report(since, Duration::from_secs(30)) else {
            eprintln!("[freeze-selfcheck] 30s 内没有冻结报告——watchdog 没判定这次阻塞");
            app.exit(3);
            return;
        };
        if !finalized {
            eprintln!(
                "[freeze-selfcheck] ⚠ 报告在 30s 内没收尾（recovered=false）——冻结未恢复，\
                 补交与收尾重写都不会来；下面按「手上这份」审，缺的格子就是缺"
            );
        }
        let verdict = super::report::audit(&path, block.as_millis() as u64);
        let dir = crate::commands::our_config_dir().join("diagnostics");
        match super::report::write_selfcheck(&dir, &verdict) {
            Ok(p) => println!("[freeze-selfcheck] 结论: {}", p.display()),
            Err(e) => eprintln!("[freeze-selfcheck] 结论落盘失败: {e}"),
        }
        for c in &verdict.checks {
            println!(
                "[freeze-selfcheck] {} {} — {}",
                if c.ok { " ok " } else { "FAIL" },
                c.id,
                c.detail
            );
        }
        println!("[freeze-selfcheck] 报告: {}", path.display());
        println!(
            "[freeze-selfcheck] verdict: {}",
            if verdict.ok {
                "PASS（现场拿全）"
            } else {
                "FAIL（还有格子没拿到，见上面 FAIL 行）"
            }
        );
        app.exit(if verdict.ok { 0 } else { 1 });
    });
}

/// 在主窗口渲染进程里塞一段同步忙等——这是**唯一**能造出「真冻结」的手段：
/// 它既不是 Rust 侧阻塞，也不是人为的心跳断流，watchdog 与前端采集器面对的是
/// 和真机完全一样的现场。
fn block_renderer(app: &AppHandle, duration: Duration) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let script = format!(
        "const __t=Date.now();while(Date.now()-__t<{}){{}}",
        duration.as_millis()
    );
    let _ = win.eval(script);
}

/// 等一份**收尾完成**的冻结报告：本次注入之后判定、且 `freeze.recovered == true`
/// （= 补交与收尾重写都已落盘）。
///
/// 为什么必须等收尾（2026-09-17 自检首跑实测）：报告是「进行中增量写 + 恢复后收尾
/// 重写」两次落盘，**第一份文件在冻结判定那一刻就出现了**（注入 8s 阻塞，2s 就判定）。
/// 谁只等「文件出现」谁就会量到半成品：1 帧样本、无补交、`recovered=false`——
/// 首跑就是这么误判成 FAIL 的（把「还没写完」读成了「拿不到」）。
///
/// watchdog 用**最后一拍心跳**当冻结起点，所以文件名的 epoch 会比注入时刻略早
/// ——按 5s 余量过滤，取窗口内最新的那份。
/// 返回 `(路径, 是否已收尾)`；30s 内始终没收尾时退回手上那份 + false（「冻结永不
/// 恢复」本身是要报出来的事实，不能静默丢掉）。
fn wait_for_freeze_report(
    since_epoch_ms: u64,
    timeout: Duration,
) -> Option<(std::path::PathBuf, bool)> {
    /// 收尾写完之后再静置：补交与恢复心跳同拍发出，而收尾重写是 watchdog 下一个
    /// tick（≤500ms）——两种到达顺序都让补交落进文件需要一点余量。
    const SUPPLEMENT_SETTLE: Duration = Duration::from_millis(1200);
    let dir = crate::commands::our_config_dir().join("diagnostics");
    let deadline = Instant::now() + timeout;
    let mut fallback: Option<std::path::PathBuf> = None;
    loop {
        let mut best: Option<(u64, std::path::PathBuf)> = None;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(epoch) = name
                    .strip_prefix("freeze-")
                    .and_then(|s| s.strip_suffix(".json"))
                    .and_then(|s| s.parse::<u64>().ok())
                else {
                    continue;
                };
                let newer = match best.as_ref() {
                    None => true,
                    Some((b, _)) => epoch > *b,
                };
                if newer && epoch + 5_000 >= since_epoch_ms {
                    best = Some((epoch, e.path()));
                }
            }
        }
        if let Some((_, path)) = best {
            if report_is_recovered(&path) {
                std::thread::sleep(SUPPLEMENT_SETTLE);
                return Some((path, true));
            }
            fallback = Some(path);
        }
        if Instant::now() >= deadline {
            return fallback.map(|p| (p, false));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// 报告是否已收尾（`freeze.recovered == true`）。读不动/解析失败按未收尾算。
fn report_is_recovered(path: &std::path::Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("freeze")
                .and_then(|f| f.get("recovered"))
                .and_then(|b| b.as_bool())
        })
        .unwrap_or(false)
}

/// 等前端心跳新鲜。`main.ts` 是「先 mount 再 startDiagnostics」，心跳跳起来就
/// 说明 App.vue 的 setup 跑过了、`useChatSession` 的全局 chat-event 监听已在
/// 注册路上；再静置一段等 `listen()` 的 promise 落地。
fn wait_frontend_ready(app: &AppHandle, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let fresh = app.try_state::<super::DiagnosticsState>().is_some_and(|s| {
            s.0.last_heartbeat
                .lock()
                .unwrap()
                .is_some_and(|t| t.elapsed() < HEARTBEAT_FRESH)
        });
        if fresh {
            std::thread::sleep(READY_SETTLE);
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn clamp_duration(ms: u64) -> Duration {
    Duration::from_millis(ms.clamp(MIN_DURATION_MS, MAX_DURATION_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_duration_夹住两端() {
        assert_eq!(clamp_duration(1).as_millis(), MIN_DURATION_MS as u128);
        assert_eq!(clamp_duration(u64::MAX).as_millis(), MAX_DURATION_MS as u128);
        assert_eq!(clamp_duration(8000).as_millis(), 8000);
    }
}
