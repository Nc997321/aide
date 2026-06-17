/// demo_pty_deadlock.rs
///
/// PTY 输出死锁 Demo — 对应 Aide 中 Plan mode / compact 导致 UI 卡死的问题
///
/// 编译运行（不需要 cargo，单文件直接编译）:
///   rustc demo_pty_deadlock.rs -o demo && ./demo
///
/// ─────────────────────────────────────────────────────────────
///
/// 背景：Aide 的架构
///
///   Claude Code 子进程 → PTY pipe → Rust reader 线程 → Tauri emit()
///     → IPC 队列 → WebView → xterm.js 渲染
///
/// 当 Plan mode 或 compact 产生大量输出（几百KB甚至几MB）时，Aide 会卡死。
///
/// 死锁链条（旧代码）：
///
///   ┌──────────────────────────────────────────────────────┐
///   │                                                      │
///   │  xterm.js 渲染卡住                                    │
///   │      ↓                                               │
///   │  WebView 主线程忙 → 无法消费 IPC 事件                   │
///   │      ↓                                               │
///   │  IPC 队列满了                                          │
///   │      ↓                                               │
///   │  emit() 阻塞 → reader 线程停了                         │
///   │      ↓                                               │
///   │  没人从 PTY pipe 读数据了 → pipe 缓冲区满               │
///   │      ↓                                               │
///   │  子进程 stdout write 阻塞 → Claude Code 卡住           │
///   │      ↓                                               │
///   │  没有新数据产生 → IPC 永远不会再被填充                    │
///   │      ↓                                               │
///   │  WebView 还在等事件 → 永远卡死 ❌                       │
///   │                                                      │
///   └──────────────────────────────────────────────────────┘
///
/// 修复方案（新代码）：
///
///   reader 线程和 emit() 之间加一层 unbounded channel + 独立 sender 线程
///
///   Claude Code → PTY → reader → unbounded channel → sender 线程 → emit() → IPC → WebView
///                              ↑                                       ↑
///                         永不阻塞                               可以阻塞，不影响 reader
///
///   即使 IPC 满了，sender 线程阻塞了，reader 线程照样全速读取 PTY。
///   数据安全的存在 channel 里，等 UI 恢复后慢慢传递。死锁被打破。
///
/// ─────────────────────────────────────────────────────────────

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

// ─── 模拟参数 ───
// 真实场景中 Plan mode 可产生数 MB 输出，这里用 2MB 让效果更明显
const TOTAL_OUTPUT: usize   = 2 * 1024 * 1024; // 2MB
const OLD_READ_SIZE: usize  = 4 * 1024;         // 旧代码每次读 4KB → 512 个事件
const NEW_READ_SIZE: usize  = 64 * 1024;        // 新代码每次读 64KB → 32 个事件
const PTY_PIPE_CAPACITY: usize = 16;            // OS PTY pipe 缓冲区（16 chunks）
const IPC_CAPACITY: usize   = 4;                // Tauri IPC 队列容量（很小）
const UI_BLOCK_SECONDS: u64 = 3;                // UI 卡住 3 秒

fn main() {
    println!("╔═══════════════════════════════════════════════════╗");
    println!("║       PTY 输出死锁 Demo（Aide Plan mode 卡死）     ║");
    println!("╠═══════════════════════════════════════════════════╣");
    println!("║                                                   ║");
    println!("║  数据流: 子进程 → PTY → reader → emit → IPC → UI  ║");
    println!("║                                                   ║");
    println!("║  总输出: {} MB                                   ║", TOTAL_OUTPUT / 1024 / 1024);
    println!("║  PTY pipe 缓冲: {} chunks                        ║", PTY_PIPE_CAPACITY);
    println!("║  IPC 队列容量: {} 个事件                           ║", IPC_CAPACITY);
    println!("║  UI 阻塞: {} 秒                                   ║", UI_BLOCK_SECONDS);
    println!("║                                                   ║");
    println!("╚═══════════════════════════════════════════════════╝\n");

    println!("═══════════════════════════════════════════════════");
    println!(" 旧代码: reader 直接调 emit() — 会死锁");
    println!("═══════════════════════════════════════════════════\n");
    test_old_pattern();

    println!("\n═══════════════════════════════════════════════════");
    println!(" 新代码: reader → channel → 独立 sender 线程 — 不死锁");
    println!("═══════════════════════════════════════════════════\n");
    test_new_pattern();

    println!("\n═══════════════════════════════════════════════════");
    println!(" 总结");
    println!("═══════════════════════════════════════════════════\n");
    println!(" 旧代码的死锁本质:");
    println!("   reader 线程既是\"PTY 的消费者\"又是\"IPC 的生产者\"");
    println!("   当 IPC 满了 → reader 阻塞 → 没人消费 PTY → 子进程写阻塞");
    println!("   → 没有新数据 → IPC 永远不会被填充 → 永久死锁");
    println!();
    println!(" 新代码的修复:");
    println!("   把\"PTY 消费\"和\"IPC 生产\"拆到两个线程:");
    println!("   reader 只消费 PTY → 发到 unbounded channel → 永不阻塞");
    println!("   sender 只生产 IPC → 从 channel 取数据 → 阻塞也无所谓");
    println!("   死锁链被切断。");
}

// ┌───────────────────────────────────────────────────────────┐
// │ 模拟子进程: 快速往 PTY pipe 里灌数据                       │
// │ (Plan mode 时 Claude Code 的输出速度)                      │
// └───────────────────────────────────────────────────────────┘
//
// PTY pipe 用 bounded sync_channel 模拟真实 OS pipe 的有限缓冲区。
// 当没人读 pipe 时，pipe 满了以后子进程 write() 阻塞 — 这是真实行为。
//
// 返回 JoinHandle，调用者可以等子进程结束并获取其完成时间。

fn spawn_child_process(
    pty_writer: mpsc::SyncSender<Vec<u8>>,
    chunk_size: usize,
    start: Instant,
) -> thread::JoinHandle<(usize, Duration)> {
    thread::spawn(move || {
        let mut sent = 0usize;
        while sent < TOTAL_OUTPUT {
            let n = chunk_size.min(TOTAL_OUTPUT - sent);
            let data = vec![b'A'; n];
            // PTY pipe 满时这里阻塞 — 模拟真实子进程 stdout write 阻塞
            if pty_writer.send(data).is_err() { break; }
            sent += n;
        }
        (sent, start.elapsed())
    })
}

// ════════════════════════════════════════════════════════════
//  旧代码模式 — 展示死锁
// ════════════════════════════════════════════════════════════

fn test_old_pattern() {
    let t0 = Instant::now();

    // PTY pipe（bounded，模拟 OS pipe 有限缓冲区）
    let (pty_tx, pty_rx) = mpsc::sync_channel::<Vec<u8>>(PTY_PIPE_CAPACITY);

    // IPC 队列（bounded，满时 send() 阻塞 — 就是 emit() 的真实行为）
    let (ipc_tx, ipc_rx) = mpsc::sync_channel::<String>(IPC_CAPACITY);

    // 启动子进程
    let child = spawn_child_process(pty_tx, OLD_READ_SIZE, t0);

    // ── Reader 线程（旧代码）──
    // 从 PTY 读 → 直接 emit（= ipc_tx.send）
    let reader = thread::spawn(move || {
        let mut total_bytes = 0usize;
        let mut events = 0usize;

        while let Ok(data) = pty_rx.recv() {
            total_bytes += data.len();
            events += 1;

            // ═══════════════════════════════════════════
            //  死锁点: emit() = ipc_tx.send()
            //  IPC 满时，这里阻塞！
            //  reader 停了 → 没人读 PTY → PTY 满 → 子进程 write 阻塞
            // ═══════════════════════════════════════════
            let emit_start = Instant::now();
            if ipc_tx.send(format!("chunk-{}", events)).is_err() { break; }
            let emit_wait = emit_start.elapsed();

            // 如果 emit 等了很久，说明 IPC 堵了
            if emit_wait > Duration::from_millis(100) {
                println!("  [reader] t={:.2}s emit() 阻塞了 {:.1}s（IPC 队列满）",
                    t0.elapsed().as_secs_f64(), emit_wait.as_secs_f64());
            }
        }
        (total_bytes, events, t0.elapsed())
    });

    // ── Consumer（模拟 WebView + xterm.js）──
    let consumer = thread::spawn(move || {
        let mut received = 0usize;

        // 阶段 1: 正常工作
        println!("  [UI] t={:.2}s 开始工作", t0.elapsed().as_secs_f64());
        for _ in 0..IPC_CAPACITY {
            if ipc_rx.recv().is_ok() { received += 1; }
        }

        // 阶段 2: UI 卡住！
        // 模拟 xterm.js 渲染大量输出占满主线程
        println!("  [UI] t={:.2}s ⚠️ 卡住 {}s（xterm.js 渲染 Plan mode 大量输出）",
            t0.elapsed().as_secs_f64(), UI_BLOCK_SECONDS);
        thread::sleep(Duration::from_secs(UI_BLOCK_SECONDS));

        // 阶段 3: 恢复
        println!("  [UI] t={:.2}s 恢复", t0.elapsed().as_secs_f64());
        loop {
            match ipc_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(_) => received += 1,
                Err(_) => break,
            }
        }
        (received, t0.elapsed())
    });

    let (read_bytes, read_events, reader_done_at) = reader.join().unwrap();
    let (child_bytes, child_done_at) = child.join().unwrap();
    let (received, consumer_done_at) = consumer.join().unwrap();

    println!();
    println!("  ┌─────────────────────────────────────────────┐");
    println!("  │ 时间线:                                      │");
    println!("  │  子进程完成:  t={:.2}s ({:.0}KB 写入)",
        child_done_at.as_secs_f64(), child_bytes as f64 / 1024.0);
    println!("  │  Reader 完成: t={:.2}s ({:.0}KB 读出, {} 事件)",
        reader_done_at.as_secs_f64(), read_bytes as f64 / 1024.0, read_events);
    println!("  │  Consumer 完成: t={:.2}s (收到 {} 事件)",
        consumer_done_at.as_secs_f64(), received);
    println!("  └─────────────────────────────────────────────┘");

    // 关键指标: reader 完成时间 vs UI 阻塞时间
    let reader_delay = reader_done_at.as_secs_f64() - UI_BLOCK_SECONDS as f64;
    if reader_delay > 0.5 {
        println!();
        println!("  ❌ Reader 在 UI 恢复后又等了 {:.1}s 才完成!", reader_delay);
        println!();
        println!("  死锁链分析:");
        println!("  ┌────────────────────────────────────────────────────────────┐");
        println!("  │ UI 卡住 → IPC 不消费 → IPC 队列满 ({}个)                   │", IPC_CAPACITY);
        println!("  │   → emit() 阻塞 → reader 线程停了                          │");
        println!("  │     → PTY pipe 不被读 → PTY 满 ({} chunks)                │", PTY_PIPE_CAPACITY);
        println!("  │       → 子进程 write() 阻塞 → Claude Code 卡住             │");
        println!("  │         → 没有新输出 → IPC 不再被填充                       │");
        println!("  │           → reader 继续等 IPC 空位 → 死循环 ❌              │");
        println!("  └────────────────────────────────────────────────────────────┘");
        println!();
        println!("  （Demo 用 recv_timeout 避免永久卡死，但真实 Aide 中表现为\"未响应\"）");
    } else {
        println!();
        println!("  ⚠️  这个 demo 数据量不够大，死锁不够明显。");
        println!("  真实场景: Plan mode 可产生数 MB 输出 + 复杂 ANSI 转义序列，");
        println!("  xterm.js 渲染更慢，IPC 阻塞更久，死锁更严重。");
    }
}

// ════════════════════════════════════════════════════════════
//  新代码模式 — 展示修复
// ════════════════════════════════════════════════════════════

fn test_new_pattern() {
    let t0 = Instant::now();

    let (pty_tx, pty_rx) = mpsc::sync_channel::<Vec<u8>>(PTY_PIPE_CAPACITY);
    let (ipc_tx, ipc_rx) = mpsc::sync_channel::<String>(IPC_CAPACITY);

    let child = spawn_child_process(pty_tx, NEW_READ_SIZE, t0);

    // ═══ 关键改动: unbounded channel + 独立 sender 线程 ═══
    let (bridge_tx, bridge_rx) = mpsc::channel::<String>();
    //  ↑ unbounded! send() 永不阻塞

    // Sender 线程: 从 bridge 取数据 → 发到 IPC（可能阻塞，但不影响 reader）
    let sender_thread = thread::spawn(move || {
        let mut sent = 0;
        for payload in bridge_rx {
            let emit_start = Instant::now();
            if ipc_tx.send(payload).is_err() { break; }
            let emit_wait = emit_start.elapsed();
            sent += 1;
            if emit_wait > Duration::from_millis(100) {
                println!("  [sender] t={:.2}s emit() 阻塞了 {:.1}s（没关系，不影响 reader）",
                    t0.elapsed().as_secs_f64(), emit_wait.as_secs_f64());
            }
        }
        (sent, t0.elapsed())
    });

    // ── Reader 线程（新代码）──
    let reader = thread::spawn(move || {
        let mut total_bytes = 0usize;
        let mut events = 0usize;

        while let Ok(data) = pty_rx.recv() {
            total_bytes += data.len();
            events += 1;

            // ═══ 修复点: unbounded channel, 永不阻塞 ═══
            if bridge_tx.send(format!("chunk-{}", events)).is_err() { break; }
            // → reader 全速运行，不受 IPC 快慢影响
        }
        drop(bridge_tx); // 关闭 → sender 的 for 循环退出
        (total_bytes, events, t0.elapsed())
    });

    // ── Consumer（和旧代码完全一样）──
    let consumer = thread::spawn(move || {
        let mut received = 0usize;

        println!("  [UI] t={:.2}s 开始工作", t0.elapsed().as_secs_f64());
        for _ in 0..IPC_CAPACITY {
            if ipc_rx.recv().is_ok() { received += 1; }
        }

        println!("  [UI] t={:.2}s ⚠️ 卡住 {}s...", t0.elapsed().as_secs_f64(), UI_BLOCK_SECONDS);
        thread::sleep(Duration::from_secs(UI_BLOCK_SECONDS));

        println!("  [UI] t={:.2}s 恢复", t0.elapsed().as_secs_f64());
        loop {
            match ipc_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(_) => received += 1,
                Err(_) => break,
            }
        }
        (received, t0.elapsed())
    });

    let (read_bytes, read_events, reader_done_at) = reader.join().unwrap();
    let (child_bytes, child_done_at) = child.join().unwrap();
    let (sent_events, _) = sender_thread.join().unwrap();
    let (received, consumer_done_at) = consumer.join().unwrap();

    println!();
    println!("  ┌─────────────────────────────────────────────┐");
    println!("  │ 时间线:                                      │");
    println!("  │  子进程完成:  t={:.2}s ({:.0}KB 写入)",
        child_done_at.as_secs_f64(), child_bytes as f64 / 1024.0);
    println!("  │  Reader 完成: t={:.2}s ({:.0}KB 读出, {} 事件)",
        reader_done_at.as_secs_f64(), read_bytes as f64 / 1024.0, read_events);
    println!("  │  Sender 发了: {} 个事件到 IPC", sent_events);
    println!("  │  Consumer 完成: t={:.2}s (收到 {} 事件)",
        consumer_done_at.as_secs_f64(), received);
    println!("  └─────────────────────────────────────────────┘");

    if reader_done_at.as_secs_f64() < UI_BLOCK_SECONDS as f64 {
        println!();
        println!("  ✅ Reader 在 UI 卡住之前就跑完了! ({:.2}s < {}s)",
            reader_done_at.as_secs_f64(), UI_BLOCK_SECONDS);
        println!();
        println!("  为什么不死锁:");
        println!("  ┌────────────────────────────────────────────────────────────┐");
        println!("  │ UI 卡住 → IPC 满 → sender 线程阻塞                         │");
        println!("  │   但 reader 线程 → unbounded channel → 永不阻塞!            │");
        println!("  │     → reader 全速读完 PTY → PTY 不会满                      │");
        println!("  │       → 子进程 write() 不阻塞 → 正常运行                    │");
        println!("  │         → 数据安全的存在 channel 中 ({} 个事件待发送)        │", read_events - sent_events);
        println!("  │           → UI 恢复后 sender 继续传 → 全部送达 ✓             │");
        println!("  └────────────────────────────────────────────────────────────┘");
    }
}
