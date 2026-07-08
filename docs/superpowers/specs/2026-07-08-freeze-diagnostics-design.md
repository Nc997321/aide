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

## 诊断目标进程的筛选（2026-07-08 手工验证发现并修正）

首次手工验证（`while` 阻塞渲染线程 60s + 强杀）暴露了一个盲区：报告的 `processes` 里
**只有 aide.exe、CPU 仅 5~15%，看不到 msedgewebview2.exe 渲染进程**——而后者才是肇事者。

根因：`family_of` 靠父进程链判断归属，但 **WebView2 运行时进程经 COM/broker 拉起，
父进程不是宿主 aide.exe**，不在其进程树下，被家族过滤排除掉了。node sidecar / git 是
aide.exe 的直接子进程，家族规则能抓到；唯独 WebView2 不行。

修正：新增纯函数 `is_diagnostic_target(pid, name, family)`——在 aide 家族内 **或** 进程名
匹配 WebView 运行时（Windows `msedgewebview2.exe`，大小写不敏感；非 Windows 为空集）。
其他 app 的 WebView2 进程可能混入，但通常空闲、按 CPU 降序排列后自然沉底，不影响找出忙的那个。
`mainThread.pending=0` + `isHungWindow=false` 的签名已能在「看不到渲染进程」时仍判定为渲染层卡死，
但补上渲染进程 CPU 后，能看到它单核满载，证据闭环。

**第二轮手工验证（同一 while 测试）确认盲区修复：pid 3088 msedgewebview2.exe 全程
94~102% CPU = busy-loop 的渲染进程，肇事者被精确锁定。** 但暴露新问题：报告 206KB，
因为按名匹配把机器上 ~29 个 msedgewebview2.exe（多为别的 app 的空闲进程）每帧都记了一遍。

**体积控制修正**：新增纯函数 `select_frame_processes(candidates, family, max_webview)`——
每帧按 CPU 降序，aide 家族（宿主 + node sidecar + git 等）全保留（数量少、瞬时 0% 也
informative），非家族的 WebView 进程仅当本帧 `cpu > 0` 且未超 `MAX_WEBVIEW_PER_FRAME=10`
才保留。丢掉的是别的 app 全程 0% CPU 的空闲进程，非肇事者。渲染层 0% CPU 的死锁型卡死
仍由「心跳断流 + 前端 longtask」层捕获，不靠进程 CPU 区分（N 个空闲进程里哪个是我们的
无法区分）。报告体积从 ~200KB 降到 ~40KB。

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

## 首次真实冻结事故复盘（2026-07-08）

黑匣子上线当天即抓到一次真实（非手工模拟）冻结，release 构建，`durationMs: 31601`。

**判读**：
- `mainThreadProbe.pending` 从 4 单调涨到 56、从未回落；`lastLatencyMs` 全程锁死在同一个值
  ——两个信号独立指向同一结论：**Rust/Tauri 主线程被堵死**，不是渲染进程忙（这次
  `aide.exe` CPU 全程 0~55% 抖动，不是持续高位死循环特征）。
- `isHungWindow` 冻结开始约 2.5s 后从 `false` 转 `true` 并保持——Windows 系统级判定与
  我们的心跳判定独立吻合。
- `eventRates` 显示冻结前一秒 chat 事件冲到 15 条/秒（一轮密集回复正在收尾）。

**根因排查**：`useConversationChanges.ts` 的 `takeSnapshot()` 在每轮对话开始都会调
`session_jsonl_size`；这条命令当时是**同步 command**，内部 `find_session_jsonl_globally`
遍历 `~/.claude/projects/` 属同步磁盘 IO——精确复现 CLAUDE.md「同步 command 禁止重 IO」
要防的模式。同名兄弟 `session_last_event` 早已是 async，`session_jsonl_size` /
`session_truncate_jsonl` 是漏网之鱼；顺带发现 `list_sessions_for_workspace`（侧栏展开
工作区 / 分屏布局恢复触发）也是同一个坑，逻辑比前两者更重。三者已改
`async fn` + `spawn_blocking`（`session.rs`）。

**诊断能力缺口与补强**：报告能明确判定「是不是主线程被堵」，但**定不到具体是哪条命令**
——`mainThreadProbe` 的探针只是 no-op，不知道主线程在跑什么。补上 `trace_command()` 埋点
（`diagnostics.rs`）：全局单槽 `CURRENT_COMMAND: Mutex<Option<(&str, Instant)>>`，同步命令
入口写入名字，RAII guard 在返回/panic 时清空；命令卡死时 guard 不执行 Drop，槽位正好留住
肇事命令名。watchdog 冻结采样时读取，写入 `FreezeSample.mainThread.stuckCommand` /
`stuckForMs`。刻意不做地毯式埋点（119 条同步命令里绝大多数是轻量的，盲铺是噪音）：
只埋了 `fetch_marketplace` / `install_plugin`（git clone 子进程 + 网络，无超时保护，
风险最高且暂不改 async——涉及子进程生命周期与代理配置，留作单独评估）和
`git_fingerprint`（3s 高频轮询 + 递归遍历 refs）。后续同类冻结如果指向其他同步命令，
按同样模式精确补埋点，不预先猜测。

## 非目标（YAGNI）

- 应用内可视化诊断面板（黑匣子抓到现场、问题解决后再议）；
- 独立监控进程；
- 崩溃（进程退出）诊断——已有 panic hook + tracing 日志覆盖；
- 诊断数据上报/回传——纯本地文件。

## 第二次真实冻结事故复盘（2026-07-08，首修后约 1.5h）

`freeze-1783482401072.json`，release 构建，`durationMs: 26970`，`recovered: false`
（强杀）。三信号依旧一致指向**主线程被堵**：`mainThreadProbe.pending` 4→48 单调涨、
`lastLatencyMs` 全程锁 0.073、`isHungWindow` 3.2s 后转 true。但**特征与首次不同**：

- **首帧 `aide.exe` 100% CPU**（满核），下一帧降到 5.7% 但主线程仍堵——典型的 **CPU 烧 →
  IO 堵** 两段式。首次 `session_jsonl_size` 是纯目录遍历 IO，`aide.exe` CPU 一直很低（等
  磁盘），全程没有 100% CPU 那一帧。这直接说明本次是**另一个根因**，不是 `session_jsonl_size`
  复发。
- `mainThread.stuckCommand = None` 全程——首修埋的 `fetch_marketplace`/`install_plugin`/
  `git_fingerprint` 都不是它（也侧面证明本次不是这三个）。
- 前端最后一帧 `lagMax=0`、无 longtask，冻结前一秒事件率安静（2-3/秒，一轮刚收尾）——
  触发在 Rust 侧、瞬时发生，排除渲染洪峰。

**根因排查**：逐命令审 `useConversationChanges.ts` 的每轮调用链——`captureChanges` 在
`running/attention → waiting`（每轮 Claude 回完）触发，调 `await save()` → 同步
`save_session_changes`。该命令在主线程上对**累积的全部 `rounds`** 跑
`serde_json::to_string_pretty`（随会话变长，CPU 满核）+ `fs::write`（杀软实时扫描/磁盘争抢
可拖到 27s）——序列化对应首帧 100% CPU，写盘对应其后 CPU 掉但主线程仍堵。同名兄弟
`load_session_changes`（切会话时同步读 + `serde_json::from_str`，CPU 解析）同病。

**诚实说明**：`recovered=false` 无前端补交（crumbs/longtasks），无法 100% 拍死就是这条；
但它是每轮必调、同步、CPU+IO、且未被埋点的唯一一条——属「无悔修复」（无论是不是它都该改，
和 `session_jsonl_size` 同类反模式）。

**已修**：`save_session_changes` / `load_session_changes` 改 `async fn` +
`spawn_blocking`（`session.rs`），序列化与落盘全离主线程。前端早已 `await`，无需改动。
**诊断反思**：`trace_command` 只对同步命令有意义——async 命令的 spawn_blocking 任务不在
主线程，guard 在 dispatch 后立刻 drop，抓不到。所以本轮没有为这两条补埋点（埋了也无效），
直接用 async 消除主线程阻塞这一类。若改 async 后仍复发同类主线程冻结且 `stuckCommand=None`，
则说明根因是**仍未识别的另一条同步命令**，应继续按「逐调用链审 → 精确改 async」推进，
而非扩大 trace_command（它只覆盖刻意保留同步的高风险命令）。
