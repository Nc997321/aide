# 卡死诊断黑匣子（Freeze Flight Recorder）设计

日期：2026-07-08
状态：已定稿（用户授权实现细节由 Claude 决定）

## 背景与目标

窗口「未响应」问题已修复两轮（2026-07-06 事件洪峰 × O(n²) 渲染；07-07 切会话全量挂载），
但仍有**偶发、无规律、无法复现**的卡死。关键症状：**卡死后难以恢复，窗口一直处于未响应状态，
直到用户在任务管理器里强杀进程**——不是瞬时卡顿。打地鼠式修复不可持续，需要一个**常驻黑匣子**：

- dev 与 release 构建都运行，完全自给足（自采集、自落盘，不依赖 devtools）；
- 平时低开销记录环形缓冲，**自动检测卡死、事发当时主动采样、冻结进行中即增量落盘**——
  进程被强杀时最后一次成功写入留在磁盘上（飞行记录仪模式，而非「等恢复才写」）；
- 报告事后交给 Claude 分析，定位根因。

核心难点有二：
1. WebView 卡死时它自己没法记录自己 → **检测者必须站在被监控者外面**（Rust 独立线程）；
2. 永不恢复的卡死没有「结束时刻」可触发落盘 → **必须在冻结进行中持续写盘**（每 ~2s 增量
   重写同一文件，临时文件 + rename 原子替换，强杀不留半截 JSON）。

## 总体架构

```
src-tauri/src/
├── diagnostics.rs              # 主控：DiagnosticsState + diag_* 命令 + sidecar 计数入口
└── diagnostics/
    ├── watchdog.rs             # 独立后台线程：心跳超时判定 + 冻结期主动采样
    ├── ring.rs                 # 固定容量环形缓冲
    └── report.rs               # 报告组装 + 落盘 + 保留策略

src/
├── composables/useDiagnostics.ts   # 前端采集主控：心跳定时器 + 聚合采集器 + 自愈补交
└── utils/diagnostics/
    ├── eventLoopLag.ts         # event loop 延迟（setInterval 漂移，100ms 采样）
    ├── longTasks.ts            # PerformanceObserver longtask（buffered，含 attribution）
    └── breadcrumbs.ts          # 用户操作面包屑（捕获期 click/keydown/visibilitychange）
```

对现有代码的侵入仅四处：`lib.rs` 注册 state/命令/启动 watchdog、`sidecar.rs` 的
`chat-event` 出口一行计数钩子、`main.ts` 一行 `startDiagnostics()`、`Cargo.toml` 加 `sysinfo`。
其余全部为新增文件，可整体摘除。provider-agnostic：计数钩子挂在统一协议层 `chat-event` 出口。

## 数据流

1. 前端每 **500ms** 调 `diag_heartbeat`，携带本周期指标：`{ lagMaxMs, longTaskCount,
   longTaskMaxMs, crumbs[], hidden }`。Rust 侧纯内存写入（环形缓冲 + 刷新最后心跳时刻），无 IO。
2. `sidecar.rs` 每转发一条 `chat-event` 调 `record_chat_event(session_id)` → 按秒分桶计数进环形缓冲。
3. **watchdog 线程**（`thread::spawn`，独立于 Tauri 主线程与 tokio runtime）每 500ms 检查：
   - 心跳断流 ≥ **2s** → 进入冻结采样模式，每 500ms 采一帧：
     - `sysinfo`：aide 主进程 + 全部后代进程（含 msedgewebview2 渲染进程、node sidecar）的 CPU%/内存；
     - 主线程探针：`run_on_main_thread` 投 no-op 测响应延迟，积压计数（探针发出未返回数）区分「主线程卡」vs「渲染进程卡」；
     - Windows：`IsHungAppWindow(hwnd)`（user32），与系统「未响应」判定互相印证；`#[cfg(windows)]` 隔离。
   - **冻结进行中每 ~2s（4 个 tick）原子重写同一份报告文件**（文件名按 `started` 锚定，
     临时文件 + rename）。进程被强杀时最后一次成功写入留在磁盘上，`recovered=false`。
   - 心跳真恢复 → 最终一次 flush 标 `recovered=true`。
4. 前端心跳定时器自身检测到断档 ≥ 2s（自己刚从卡死中恢复）→ 调 `diag_freeze_supplement`
   补交冻结期间的 longtask 明细（PerformanceObserver 在卡死期间照常记录，恢复后可读）+
   面包屑快照。Rust 把补交合并进最近 30s 内的报告文件。
   **注意**：永不恢复的卡死里前端也永不恢复，补交永不发出——所以补交是「锦上添花」，
   真正的现场证据来自 watchdog 侧的进程采样帧，这部分不依赖前端恢复。

## 关键判定逻辑

- **首心跳前不检测**：`last_heartbeat: Option<Instant>`，为 None 时 watchdog 静默（前端未起）。
- **窗口隐藏抑制**：`document.hidden` 时浏览器节流定时器（可退化到分钟级）。前端在
  `visibilitychange` 时立即发一条带 `hidden: true` 的心跳；Rust 收到后暂停检测，直到
  `hidden: false` 心跳恢复检测。
- **系统休眠防误报**：watchdog 测自己的 tick 漂移，若单次 tick 间隔 > 5s（自己也被挂起 =
  系统级休眠/挂起），重置心跳基线而不是判冻结。
- **状态机**：`Idle → Frozen(采样中, 进行中增量落盘) → Idle(最终落盘 or 丢弃)`，一次冻结一个文件（按 `started` 锚定），不重入。

## 落盘时机（关键）

| 场景 | 落盘行为 | 报告里的标记 |
|---|---|---|
| 永不恢复、被强杀 | 冻结进行中每 ~2s 增量重写，强杀后磁盘留最后一份 | `recovered=false`，`ended`=最后一次 flush 时刻 |
| 自行恢复的瞬时卡 | 恢复时最终一次 flush | `recovered=true`，`ended`=恢复时刻；前端 30s 内补交 `frontend` 字段 |
| 系统休眠挂起 | tick 缺口 >5s 时收尾 | `suspected_sleep=true` |
| 隐藏窗口收尾 | 窗口隐藏时收尾；时长 <4s 丢弃 | 短的丢弃，长的 `recovered=false` |

## 诊断报告

- 目录：`~/.claude-code-desktop/diagnostics/`，文件名 `freeze-<epoch_ms>.json`，保留最新 **20** 份。
- 内容：
  ```
  meta:     app 版本 / debug|release / OS / 报告 schema 版本
  freeze:   开始·结束 epoch_ms、时长、检测时心跳缺口、suspected_sleep 标记、recovered 标记
  samples:  冻结期每 500ms 一帧 [{ t, processes[{pid,name,cpu,mem}], mainThreadProbe{pendingCount,lastLatencyMs}, isHungWindow? }]
  ring:     最近 ~2.5 分钟 { heartbeats[（含指标与面包屑）], eventRates[{tSec,sessionId,count}] }
  frontend: 补交部分 { gapMs, longTasks[{start,duration,attribution}], crumbs[] }（可能缺失，标记 pending）
  ```
- 环形缓冲容量：心跳 300 条（~2.5min）、事件速率 180 桶（3min）、面包屑随心跳走（每条心跳 ≤ 若干条增量）。

## 开销预算

- 前端：100ms 一次的时间戳比较 + 500ms 一次的 invoke（payload 通常 < 300B）；
  PerformanceObserver 是浏览器原生低开销机制；面包屑仅捕获期监听三类事件。
- Rust：心跳命令纯内存；watchdog 空闲态每 500ms 只做一次 Instant 比较；
  **sysinfo 进程刷新只在冻结期发生**，空闲态零成本。

## 测试

- cargo（`--lib`，绕杀软锁）：ring 容量/顺序；报告序列化与 prune；后代进程过滤（纯函数 + 假 parent 表）；休眠防误报判定。
- vitest：eventLoopLag drain（fake timers）；breadcrumbs 环容量与标签提取；longTasks 摘要 drain（mock PerformanceObserver）。
- 手工验证：
  1. 模拟**瞬时恢复**：devtools console 跑 `const t=Date.now();while(Date.now()-t<3000){}` 阻塞渲染线程 3s，确认 diagnostics 目录出现报告（`recovered=true`）且 frontend 补交已合并；
  2. 模拟**永不恢复**：跑 `const t=Date.now();while(Date.now()-t<60000){}` 阻塞 60s 期间，2s 后即应看到 diagnostics 目录出现报告且每 ~2s 更新（文件 mtime 变化），`recovered=false`；随后从任务管理器强杀 aide.exe，确认报告文件保留在磁盘、JSON 完整可解析。

## 非目标（YAGNI）

- 应用内可视化诊断面板（黑匣子抓到现场、问题解决后再议）；
- 独立监控进程；
- 崩溃（进程退出）诊断——已有 panic hook + tracing 日志覆盖；
- 诊断数据上报/回传——纯本地文件。
