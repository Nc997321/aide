# 自动化任务（Automation）实施计划

> 日期：2026-08-21 · 状态：待评审 · 原型：[`docs/prototypes/automation.html`](../prototypes/automation.html)
> 对标 WorkBuddy「自动化」，差异化：运行记录一等公民、预算护栏、执行手册自蒸馏、错过补跑策略。

## 1. 范围（已与用户确认）

**v1 做**：
1. 侧栏底部入口（设置旁）+ 主区面板三视图：任务列表 / 编辑表单 / 运行历史
2. 客户端内调度器（Rust tokio 常驻 task）+ 启动时 missed-run 处理 + 并发跳过
3. 三档权限预设 + 连接器预授权 + 轮次/成本双护栏
4. 运行记录独立存储与视图（状态/耗时/成本/缓存命中统计条）+ 完成/失败通知
5. **执行手册（playbook）自蒸馏**：首跑后自动提炼 playbook.md + scripts/，后续运行注入，省 3–5× token

**v1 不做**：系统级调度（OS 计划任务）、resume 会话模式（被 playbook 替代其价值）、allowedTools 自由编辑、事件触发（git hook 等）。

## 2. 探索结论（架构事实）

| 事实 | 出处 | 对设计的影响 |
|---|---|---|
| Runtime 是**单进程多路复用**：`AgentRuntimeManager` 持有一个 aide-agent.exe，sidecar 内 `Map<session_id, SessionWorker>` | `src-tauri/src/runtime/mod.rs:30-51`、`agent-sidecar/src/session-manager.ts` | 自动化运行 = 向共享 runtime `send` 一个新 session，**不 spawn 新进程** |
| stdin JSONL 协议，`cmd` 路由；`send` 会 getOrCreate worker | `runtime/mod.rs:333-346`、`session-manager.ts:103-137` | 调度器发 run = 构造一条 send 命令 |
| btw 任务支线：tools 白名单、不带主会话历史、`message_stop` 后 `selfTeardown` | `commands/chat.rs:273-342`、`session-worker.ts:1147,1302-1306` | 自动化跑完的自毁直接复用这个模式（加 `autoTeardown` 标志） |
| SDK options 已接通：model/effort/permissionMode/cwd/mcpServers/systemPrompt.append/resume；**maxTurns / maxBudgetUsd 未接通** | `session-worker.ts:967-1028` | sidecar 补两个字段透传 |
| 用量：`result` 分支摊平 `modelUsage` → `message_stop` 带 `total_cost_usd`+`usage`；完成信号 = `message_stop`/`error` | `mapper.ts:645-718` | 调度器在 runtime 事件泵挂钩观测 run 终态 |
| 转录：`~/.aide/claude/projects/<encoded-cwd>/<id>.jsonl`；aide 元数据 `~/.aide/sessions/<id>.json`（无 tags 字段） | `commands/session.rs`、`commands/mod.rs:213-235` | 元数据加 `tags`，`list_sessions` 过滤 automation 会话 |
| headless 可行性已证：smoke 脚本直接 stdin 驱动 runtime 跑完一轮 | `agent-sidecar/smoke-runtime.ts` | 自动化 smoke 测试照抄 |
| 主区 tab 只支持会话（`TabItem{sessionId}`）；非聊天视图 = SettingsPanel 式 overlay（`App.vue:1089` v-if） | `composables/paneLayout/tree.ts:21-34`、`PaneGroup.vue:165-200` | 自动化面板走 overlay，不动 tab 系统（原型需调整） |
| OS 通知：notify-rust 已封装 `api.notifySend` | `composables/useNotification.ts:73-86` | 完成/失败通知直接用 |
| JSON 存储范式：路径 helper + tmp+rename 原子写 + `Lazy<Mutex>` 缓存 | `commands/recent.rs:131-162` | automation store 照抄 |
| setup 启动常驻 task：`tauri::async_runtime::spawn` | `lib.rs:189-209` | 调度器在此启动 |
| 权限：allowedTools 由 sidecar 组装；btw `tools` 白名单是现成挂载点；**tools 白名单管不住 MCP**（实锤） | `session-worker.ts:986,1023-1025` | 连接器收口走 mcpServers 过滤 + canUseTool 编程裁决（见 §5） |
| 幽灵会话坑：普通 worker 跑完不自毁 | session-manager 生命周期 | run 终态后必须 teardown |

## 3. 总体数据流

```
┌─ AutomationService (Rust, tokio 常驻, 30s tick) ─────────────────────┐
│  扫描内存任务表 → due? → 组装 run:                                     │
│  prompt = task.prompt + playbook.md(若有) + 兜底指令                    │
│  → send_to_runtime({ cmd:"send", session_id: runId, model, effort,    │
│      tools: preset映射, mcpAllowlist: connectors,                      │
│      permissionMode:"default", autoTeardown:true,                     │
│      maxTurns, maxBudgetUsd, automation:{taskId,runId}, cwd })        │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ stdin JSONL
                    ┌──────────▼───────────┐
                    │ SessionWorker (新增/  │  query() 驱动 SDK
                    │ 复用现有 startLoop)   │  canUseTool = 白名单编程裁决
                    └──────────┬───────────┘
                               │ stdout JSONL (chat-event)
┌──────────────────────────────▼───────────────────────────────────────┐
│ runtime 事件泵 (runtime/mod.rs 读 stdout 循环)                         │
│  → 透传 emit("chat-event") 给前端（实时输出/查看器复用）                 │
│  → 新增：若 event.automation 存在且为终态(message_stop/error)          │
│      → AutomationService.on_run_finished()                            │
│        写 runs.jsonl / 写 session 元数据 tags / 通知 / 触发蒸馏         │
└──────────────────────────────────────────────────────────────────────┘
```

蒸馏（首跑成功且 playbookEnabled 且 playbookState≠ready）：
`on_run_finished` 后发第二条 send：`resume_session_id = 本次 run 的 session`，prompt = 蒸馏指令，tools = 预设 + Write/Edit。蒸馏轮追加进同一份转录（查看器里可见「手册蒸馏」步骤），完成后同样 autoTeardown。

## 4. 存储设计

```
~/.aide/automations/
  <task-id>/                # aut_<timestamp36><rand4>
    task.json               # 任务定义（唯一权威）
    runs.jsonl              # 每次运行追加一行
    playbook.md             # 执行手册（蒸馏产物，用户可手改）
    scripts/                # 手册引用的确定性脚本
```

**task.json**：
```jsonc
{
  "id": "aut_...", "name": "每日提交汇总", "prompt": "...",
  "workspacePath": "C:\\... | null",
  "model": "claude-sonnet-5", "effort": "medium",        // 显式，不继承
  "permissionPreset": "readonly | workspace-write | full",
  "connectors": ["aide-codegraph"],                       // MCP server key 白名单
  "maxTurns": 50, "maxBudgetUsd": 0.25,
  "schedule": { "kind": "daily", "time": "18:30" }
    // {kind:"weekly",time,weekdays:[1..7]} | {kind:"monthly",time,day}
    // {kind:"interval",every:2,unit:"minutes|hours|days"} | {kind:"once",at:"ISO"}
  ,
  "validFrom": null, "validTo": null,
  "missedPolicy": "catchup | skip | ask",
  "playbookEnabled": true, "playbookState": "none | ready | stale",
  "notifySuccess": true, "notifyFailure": true,
  "enabled": true, "createdAt": "ISO",
  "lastRunAt": "ISO|null", "lastRunStatus": "...|null"   // 列表冗余缓存，权威在 runs.jsonl
}
```

**runs.jsonl**（每行）：
```jsonc
{ "runId": "run_...", "sessionId": "...", "trigger": "schedule|manual|catchup",
  "mode": "explore|playbook", "startedAt": "ISO", "finishedAt": "ISO",
  "status": "succeeded|failed|skipped",
  "stopReason": "end_turn|max_turns|max_budget|error|interrupted",
  "usage": { "input": ..., "cacheRead": ..., "output": ... },
  "costUsd": 0.043, "distillCostUsd": 0.012, "error": null }
```

**会话隔离**：run 的 session 元数据（`~/.aide/sessions/<id>.json`）写 `tags:["automation","aut:<task-id>"]`；`list_sessions` 读到含 `automation` tag 即跳过——运行记录不进会话列表。元数据由 AutomationService 在发 send 前直接写（不走 create_session 命令）。

## 5. 权限模型（无人值守的安全边界）

**2026-08-22 定案（用户拍板，替代三档白名单）**：只读/工作区写入的概念边界连开发者都说不清，不给用户出概念题。预设只两档：

- **`auto`（默认）**：内建工具全量可见，`permissionMode: "auto"`——CLI 自动模式裁决：读/写/安全命令自动放行；高危操作 CLI 想询问 → canUseTool 自动化分支**兜底 deny**（无人值守没人应答）。不用 bypassPermissions（该模式 canUseTool 从不被调，实测结论）。
- **`full`**：`bypassPermissions` + policy hook 全 allow，不做任何拦截（UI danger 色）。

**连接器（MCP）与预设正交，永远显式**：`mcpServers` 按连接器白名单过滤挂载（未授权 server 的工具不存在）；policy hook 自动化分支对 MCP 工具按 `mcp__<server>__` 前缀裁决——白名单内 allow、其余 deny（full 档也不例外）。

三层纵深（M2 实现，M3 末调整）：① 可见性（tools 恒全量，MCP 靠过滤）② policy hook 三值裁决（MCP allow/deny + 内建 full-allow/auto-defer）③ canUseTool 兜底 deny。

自动化运行的其他 options：`skills:[]`/`plugins:[]`（精简基座省钱）、thinking disabled、partial 关、auto_title=false、模型/effort 走 env 通道（ANTHROPIC_MODEL / CLAUDE_CODE_EFFORT_LEVEL，与普通会话同形；模型空 = 跟随提供商默认）。存量三档数据经 serde alias 归并 auto。

## 6. Rust 侧模块

**新增 `src-tauri/src/automation/mod.rs`（store）+ `scheduler.rs`（服务）**：

- store（照 recent.rs 范式）：`automations_dir()` 路径 helper、`load_task/save_task`（tmp+rename 原子写）、`append_run`、`list_runs(id, limit)`（倒序读 tail）、`Arc<Mutex<HashMap<taskId, AutomationTask>>>` 内存缓存（CRUD 命令维护，调度器只读内存）。
- scheduler：
  - `AutomationService { tasks, active_runs: HashMap<taskId, runId>, app, runtime_mgr }`，`.manage(Arc::new(...))` + setup 里 `async_runtime::spawn` 启动，30s `interval` tick。
  - next-fire 纯函数（可单测）：daily/weekly/monthly 按本地时区算下一个 HH:MM；interval 以 `lastRunAt ?? createdAt` 为锚累加；once 到期即触发并 `enabled=false`（保留历史）。validFrom/To 窗口外不触发。
  - due 判定：tick 时 `next_fire(task) <= now`；触发前查 `active_runs` 有则记 skipped（reason=overlap）。
  - **启动 missed-run 扫描**：对每个 enabled 任务，若存在已过去的触发点晚于 lastRunAt → 按 missedPolicy：catchup 立即跑一次 / skip 记一条 skipped / ask 推应用内通知中心（useNotifications）。
  - 发 run 前：写 session 元数据 tags、组装 prompt（读 playbook.md，>8KB 截断）。
- runtime 事件挂钩：`runtime/mod.rs` 的 stdout 泵在 emit 前检查 event 是否带 `automation` 元信息且为终态 → `AutomationService::on_run_finished`（终态映射：`end_turn`→succeeded；`max_turns`/`max_budget`/error→failed；interrupted→failed）。写 runs.jsonl、更新 task.json 冗余缓存、发通知（成功按 notifySuccess）、按需触发蒸馏。
- 命令面（**全部 async + spawn_blocking，State 走 Arc clone**；纯内存读除外）：
  `list_automations` / `get_automation` / `create_automation` / `update_automation` / `delete_automation`（连带删目录，二次确认在前端）/ `set_automation_enabled` / `run_automation_now` / `list_automation_runs(id, limit)` / `automation_run_stats(id)`（聚合：次数/成功率/总成本/平均耗时/缓存命中）/ `redistill_automation`（置 stale）。同步轻量命令（纯内存读）不埋 trace_command；涉及文件 IO 的已是 async 不埋。

## 7. sidecar 改动（agent-sidecar）

- `types.ts`：`SidecarCommand.send` 增字段 `maxTurns?`、`maxBudgetUsd?`、`autoTeardown?`、`automation?: {taskId, runId}`、`mcpAllowlist?: string[]`；`ChatEvent` 终态事件透传 `automation`。
- `session-worker.ts`：
  - query options 补 `maxTurns` / `maxBudgetUsd`（SDK 原生）。
  - `mcpAllowlist` 存在时过滤 mcpServers 合并结果（`:995`）。
  - `automation` 存在时：canUseTool = 白名单编程裁决（不弹 UI、不 defer）；`message_stop`/error 后走 btw 同款 `selfTeardown`（`persistSession` 保持 true——运行转录要落盘）。
- 无新进程、无新协议通道。改完必须 `pnpm build:sidecar`（dist  freshness 坑，见记忆）+ 重启 tauri dev 验证。

## 8. 前端模块

- `src/api/automation.ts`：照 `api/customization.ts` 封装全部命令。
- `src/composables/useAutomation.ts`：模块级 reactive 单例——tasks 列表、当前编辑任务、runs 缓存；`listen("chat-event")` 里识别带 `automation` 的终态事件 → 刷新 runs/stats + toast + OS 通知（`useNotification`）；监听应用内通知（useNotifications）承载 ask 补跑条目。
- `src/components/automation/`（布局按 v3 原型：侧栏分区树 + 主区详情，非 overlay/tab）：
  - `AutomationSidebarSection.vue`：侧栏「自动化」分区（分区头 + 任务节点行 + hover 新建），插入 SidebarLeft 的分区树。
  - `AutomationDetail.vue`：主区任务详情——头部（启停/立即运行/编辑/删除）、提示词卡、playbook 卡（状态/查看/重新提炼）、统计条、运行行列表。
  - `AutomationTaskEditor.vue`：分区表单（基本/执行配置/权限安全/调度/手册与通知）。
- `SidebarLeft.vue`：改造为分区树（会话区下沉为根分区之一，自动化为第二分区；折叠状态本地持久化）；选中任务节点时主区由 App.vue 切换为 AutomationDetail。
- 会话列表过滤已由 Rust `list_sessions` 保证，前端无感。
- 全部配色走 `var(--aide-*)`，零硬编码 hex。

## 9. 执行手册（playbook）子系统

- **蒸馏 prompt**（草案，实施时打磨）：要求回顾本次运行 → 提炼可复用步骤写 `playbook.md`（步骤化、含命令/脚本调用与产出格式要求）→ 确定性步骤写成脚本到 `scripts/`（手册按绝对路径引用）→ 约束：脚本只做取数/格式化，判断与成文留给模型；手册面向「另一个没有本次记忆的会话」写。
- **注入格式**：`task.prompt` + `\n\n# 执行手册（务必遵循）\n<playbook>` + 兜底：「若手册任一步骤失败（结构变化/脚本报错），自由发挥完成任务，并在结束时把改进写回 playbook.md（需写权限预设）」。
- **mode 标注**：有手册运行 = `playbook`，无 = `explore`，历史视图展示「手册执行 4 轮 $0.03 vs 探索 16 轮 $0.12」的对比卖点。
- **重新提炼**：`redistill_automation` 置 stale → 下次运行按 explore 跑 + 跑完再蒸馏。
- 手册文件用户可手改（下次运行即生效），面板提供「查看手册」入口（FileViewer 复用，可选）。

## 10. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 存储+调度骨架 | automation store、scheduler（next-fire 单测）、session tags + list 过滤、命令面 CRUD | cargo test 过；命令行 invoke 建任务/mocked tick 触发有日志 |
| M2 headless 执行闭环 | sidecar 字段透传、canUseTool 白名单、autoTeardown、runtime 事件挂钩、runs.jsonl、通知 | run_automation_now 跑通真任务（只读预设），转录落盘且不进会话列表，runs.jsonl 有成本，进程无残留（幽灵检查） |
| M3 UI 三视图 | 面板+入口+三视图+事件刷新 | 建/编/删/启停/立即跑/历史全通；主题变量审计 |
| M4 playbook 蒸馏 | 蒸馏轮、注入、stale/重提炼、mode 标注 | 首跑 explore→手册产出；二跑 playbook 轮数与成本显著下降（smoke 实测对比） |
| M5 补跑与打磨 | missed-run 三策略、并发跳过、once 自动停用、冒烟脚本 | 改系统时钟/杀进程场景手测；`agent-sidecar/smoke-automation.ts` 一键验证 |

## 11. 测试策略

- **Rust 单测**：next-fire 全分支（daily/weekly/monthly/interval/once + validRange 窗口）、runs 聚合统计、store 原子写恢复。
- **sidecar smoke**：照 `smoke-runtime.ts` 写 `smoke-automation.ts`——起 runtime、发带 automation 标志的 send、断言终态事件带 usage、worker 已自毁、白名单外工具被拒（发一个诱导用 Bash 的 readonly 任务）。
- **手测清单**：运行中看实时输出；杀客户端后重开（missed-run）；护栏触顶（maxBudgetUsd=0.01 任务）；playbook 二次运行成本对比；会话列表无 automation 泄漏。

## 12. 风险与坑位清单（记忆映射）

| 坑 | 预案 |
|---|---|
| sidecar 跑的是 dist 产物，改 src 必须 build + 重启 tauri dev | 每个 sidecar 改动步后 grep dist 查新符号 |
| 幽灵空会话（worker 不自毁） | autoTeardown 复用 btw selfTeardown；M2 验收含进程残留检查 |
| tools 白名单管不住 MCP | mcpAllowlist 过滤 server 挂载 + canUseTool 双保险 |
| 模型/effort 继承主会话（btw 坑） | task.json 显式字段，send 必带 |
| skip-permissions 下 canUseTool 不被调 | 自动化不用 bypass，走 default + 编程裁决 |
| 同步命令堵主线程 | 命令面全 async/spawn_blocking；调度器本就在 tokio |
| 跨线程 emit 投递曾致卡死（**该归因已于 2026-09-13 证伪，见 [决策记录 §更正](../discussions/2026-07-09-sidecar-sse-streaming-architecture.md)**；但"不新增 emit 通道、复用现有 chat-event 管道"的设计结论不变） | 自动化事件低频；实时输出复用现有 chat-event 管道，不新增 emit 通道 |
| CREATE_NO_WINDOW / verbatim 路径 | 不新 spawn 进程（共享 runtime），无新暴露面 |
| Fable 烧钱 | 编辑器默认 Sonnet + effort 中，Fable 选项带成本警告 |

## 13. 对原型的调整点（v2 已按用户决策更新）

1. **入口与布局 = 侧栏分区树**（用户拍板，替代 tab 切换/overlay 方案）：SidebarLeft 改为可折叠分区树（VS Code 资源管理器范式，三角箭头 14px 约定）——「会话」「自动化」是平级根分区、可同时展开；**未来加分区 = 追加根节点，不改布局**（v2 的 tab 切换是封闭结构被否的原因）。自动化模式下：侧栏任务节点 → 主区详情（运行历史+统计+playbook 卡片就地展开）。分区头 hover 出「＋」新建；有任务在跑时分区头亮呼吸点。实现可复用 ATreeItem/TreeNodeItem；SidebarLeft 加分区折叠状态，主区在 PaneLayout 与 AutomationDetail 之间切换（不进 pane 树）。
2. 运行中「实时输出」= 点运行行开一个聊天 tab 挂该 sessionId（免费复用），而非面板内嵌日志视图。
3. 「完全访问」预设的底层是三层纵深（tools 可见性 + policy hook + canUseTool 兜底），M2 已实现并冒烟验证，UI 文案不变。
4. v2 原型数据驱动：顶部 MOCK 对象注入渲染（docs/prototypes/automation.html），已移除系统级调度与 resume 会话模式的 UI。

## 14. 验收实锤的坑（2026-08-22/23 真实运行修出）

1. **worker re-key 与路由表过户**：sidecar SessionManager 在 session_init 后把 worker routingKey 换成 SDK 真实会话 id——之后所有事件（含终态 message_stop/error）的 session_id 都是真实 id。调度器 by_session 路由表必须在 session_init 时跟着过户（run_id → sdk id），否则运行永远卡「运行中」。冒烟测不到这层（smoke 直驱 sidecar，finalize 是 Rust 侧）。
2. **蒸馏轮必须 fork，不能 in-place resume**：与运行会话同 SDK id 时，worker re-key 顶替同键——任何发往运行会话的命令（关 tab 的 session_stop「关闭即停止」、ESC interrupt）都会误杀蒸馏轮，且 stop() 静默无事件 → 蒸馏无声消失。fork 后蒸馏拿全新会话 id，命令面物理隔离；代价是蒸馏转录是新 jsonl。fork 出的新 id 要在 session_init 补写 tags=automation 元数据，否则活体被 list_sessions 的 pid 通道扫成侧栏幽灵会话。
3. **硬停要补终态**：worker.stop() 本身不发任何终态事件——自动化会话被 session_stop 硬杀时调度器永远等不到 message_stop。stop() 在 automationConfig && turnActive 时补发合成 message_stop(interrupted)；自然终态后 turnActive=false 不补，重复也被幂等忽略。
4. **中断自愈不能只看最新一条记录**：overlap-skip 这类后补记录会把卡住的 running 压在下面漏收；扫最近 50 条收所有 running，且启动后 5s 内用户手动开跑的活跃任务不能误收。
5. **cargo test 的 lib-test harness 没有应用清单**：链接进 comctl32 v6 符号（tauri-runtime-wry/muda 的 TaskDialogIndirect）进程加载即 0xc0000139。修法=build.rs 关 tauri 资源版清单（new_without_app_manifest）+ 无作用域 /MANIFESTINPUT 统一嵌（rustc-link-arg-tests 到不了 lib-test，tauri#11179）。
