# PTY 输出死锁 Demo

对应 Aide 中 Plan mode / compact 指令导致 UI 卡死的问题。

## 运行

```bash
# 编译（不需要 cargo，单文件即可）
rustc demo_pty_deadlock.rs -o demo

# 运行
./demo       # Linux / macOS / Git Bash
demo.exe     # Windows CMD
```

## 背景

Aide 的架构中，Claude Code 子进程的输出通过以下路径到达屏幕：

```
Claude Code 子进程 (stdout)
    ↓ 写入
PTY pipe（OS 管理的管道，有固定大小的缓冲区，通常 64KB）
    ↓ 读取
Rust reader 线程（从 PTY 读数据）
    ↓ emit()
Tauri IPC 队列（WebView 的事件队列，容量很小）
    ↓ 接收
WebView 主线程（JavaScript）
    ↓
xterm.js terminal.write()（渲染终端内容）
```

## 旧代码（死锁）

```rust
// src-tauri/src/pty.rs — 旧代码
thread::spawn(move || {
    let mut buf = [0u8; 4096];  // 4KB 读缓冲
    loop {
        match reader.read(&mut buf) {
            Ok(n) => {
                let data = String::from_utf8_lossy(&buf[..n]);
                let payload = serde_json::json!({ ... });
                // ↓↓↓ 死锁点 ↓↓↓
                // emit() 在 IPC 队列满时会阻塞！
                let _ = app.emit("pty-output", payload.to_string());
            }
            ...
        }
    }
});
```

**死锁链条**：

```
① xterm.js 渲染大量输出 → WebView 主线程被占满
② WebView 无法消费 IPC 事件 → IPC 队列逐渐填满
③ reader 线程调 emit() → IPC 满 → emit() 阻塞
④ reader 停了 → 没人从 PTY pipe 读数据
⑤ PTY pipe 缓冲区满（64KB）→ 子进程 stdout write() 阻塞
⑥ Claude Code 子进程卡住 → 不再产生输出
⑦ 没有新数据 → IPC 永远不会再被填充
⑧ reader 继续等 IPC 空位 → 永远等不到 → 死锁 ❌
```

关键点：**reader 线程同时承担了"消费 PTY"和"生产 IPC"两个职责**。当 IPC 堵了，reader 停摆，PTY 也没人消费了，整条链断掉。

## 新代码（修复）

```rust
// src-tauri/src/pty.rs — 新代码

// 改动 1: unbounded channel — send() 永不阻塞
let (bridge_tx, bridge_rx) = mpsc::channel::<String>();

// 改动 2: 独立的 sender 线程
thread::spawn(move || {
    for payload in bridge_rx {
        // 这里可能阻塞（IPC 满了），但阻塞的是 sender 线程
        // 不是 reader 线程 — 这就是关键区别
        let _ = app.emit("pty-output", payload);
    }
});

// 改动 3: reader 线程只负责读 PTY
thread::spawn(move || {
    let mut buf = [0u8; 65536];  // 64KB 读缓冲（原来 4KB）
    loop {
        match reader.read(&mut buf) {
            Ok(n) => {
                let payload = serde_json::json!({ ... }).to_string();
                // ↓↓↓ 修复点 ↓↓↓
                // unbounded channel 的 send() 永不阻塞！
                bridge_tx.send(payload);
                // → reader 全速运行，不受 IPC 快慢影响
            }
            ...
        }
    }
    drop(bridge_tx); // 关闭 → sender 线程退出
});
```

**修复原理**：

```
① xterm.js 渲染大量输出 → WebView 主线程被占满
② WebView 无法消费 IPC 事件 → IPC 队列满
③ sender 线程调 emit() → 阻塞（没问题，它是专门的）
④ reader 线程 → bridge_tx.send() → unbounded channel → 永不阻塞
⑤ reader 继续全速读 PTY → PTY 不会满
⑥ 子进程 write() 不阻塞 → 正常运行
⑦ 数据安全的存在 unbounded channel 中
⑧ UI 恢复 → sender 继续传 → 所有数据送达 ✓
```

关键点：**把"消费 PTY"和"生产 IPC"拆到两个线程**。reader 只消费 PTY，sender 只生产 IPC。即使 sender 堵了，reader 照样全速运转。死锁链被切断。

## 前端改动

除了 Rust 侧，前端也加了 `requestAnimationFrame` 批量写入：

```typescript
// 旧代码：每个事件立即调 terminal.write()
ls.terminal.write(p.data);

// 新代码：累积到下一帧再写
batchBuffers.set(p.session_id, existing + p.data);
if (batchRafId === null) {
    batchRafId = requestAnimationFrame(flushBatches);
}
```

这减少了 xterm.js 的同步渲染次数，降低主线程被占满的概率。

## Demo 输出解读

```
旧代码:
  [reader] t=3.00s emit() 阻塞了 3.0s（IPC 队列满）
  子进程完成:  t=3.00s     ← 子进程被卡了 3 秒
  Reader 完成: t=3.00s     ← reader 也被卡了 3 秒

新代码:
  [sender] t=3.00s emit() 阻塞了 3.0s（没关系，不影响 reader）
  子进程完成:  t=0.00s     ← 子进程秒完成
  Reader 完成: t=0.00s     ← reader 秒完成 ✅
```

旧代码中，reader 和子进程都被 IPC 堵住了 3 秒。新代码中，只有 sender 线程被堵了 3 秒（它是专门干这个的），reader 和子进程秒完成。

## 三处改动总结

| # | 文件 | 改动 | 解决什么 |
|---|------|------|----------|
| 1 | `pty.rs` | 读缓冲 4KB → 64KB | 减少事件数量 16 倍 |
| 2 | `pty.rs` | 独立 sender 线程 + mpsc channel | reader 永不阻塞，消除死锁 |
| 3 | `useTerminalManager.ts` | rAF 批量 terminal.write() | 降低前端主线程压力 |
