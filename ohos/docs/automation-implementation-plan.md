# 自动化任务接入落地计划（抽屉区段 + 详情/表单/转录浮层）

> 状态：实施中
> 原型（已评审定稿）：`design/automation/app.html`（5 屏）+ `design/automation/index.html`（展台）
> 蓝本：`.deveco/plans/1789833713552-silent-lagoon.md` Phase B 章节（已批准全量执行）
> 日期：2026-09-20

## 背景与目标

桌面 aide 的自动化任务（Automation）接入 ohos 客户端。原型已定稿三项评审结论：
**IA=变体 A**（区段紧跟工作区卡）；**模型选项取本地供应商列表**（与聊天模型
chip 同源，不调远程 `get_default_models`，空 = 跟随桌面默认）；**表单不暴露
运行上限**（maxTurns/maxBudgetUsd 编辑透传原值）。

本计划把原型 5 屏落进 ArkTS 工程：抽屉区段 + 四个全屏浮层（详情 / 表单 /
运行转录 / 手册），浮层挂 ChatPage 根 Stack，聊天保持挂载继续流式（对齐桌面
v-show 语义），返回键逐层收起进 `Index.onBackPress`，优先级
**自动化浮层 > 抽屉 > chip 弹层**。

## 上游事实（调研定论）

- **命令面 11 个**（`packages/aide-sdk/src/api/automation.ts` 与
  `src-tauri/src/automation/commands.rs` 1:1）：`list_automations` /
  `get_automation` / `create_automation` / `update_automation` /
  `delete_automation` / `set_automation_enabled` / `list_automation_runs` /
  `automation_run_stats` / `run_automation_now`（busy 时 Err
  `"「{name}」正在运行中"`，错误文本直显 toast）/ `get_automation_playbook`
  （null = 未生成）/ `redistill_automation`。serde 全 camelCase。
- **远程 REGISTRY（rpc.rs）0 收录**：invoke 全部必败——错误态是一等公民
  （桌面后续清单第 1 项落地后点亮）。
- `Schedule` 是 serde tag=`"kind"` 判别联合：daily{time} / weekly{time,
  weekdays:1..7=周一..周日} / monthly{time,day:1..31} / interval{every,unit}
  / once{at}；`once` 触发后服务端自动 `enabled=false`。
- `RunRecord.sessionId`：skipped 记录为空串 → 行置灰不可点；`note` 值
  `overlap` / `missed-skip` / `missed-ask` 有固定摘要文案；`summary` =
  转录尾行 ≤80 字。
- 服务端校验：名称/提示词非空；每周 ≥1 个星期几；单次必须有日期；
  `validFrom<=validTo`；HH:MM；every>0（客户端预检 4 条，其余靠服务端 Err）。
- **事件通路**：`automation_run_finished` / `automation_missed` 现状不达
  远程端（scheduler 经 `app.emit` 只发本地 webview）。**run 的原始事件流
  全量到达**：`session_init` 带 `session_id = run_<base36-ms><4-hex>` 路由键
  + `sdk_session_id` 别名（sidecar 此后 re-key，蒸馏轮路由键 `{run_id}-d`）；
  终态推导镜像 scheduler.rs:649-701：`message_stop.stop_reason=="end_turn"`
  → 成功、其他 → 失败；`error` → 失败；`session_dead` → 全部在跑的失败。
  **live 推导只认生命周期/终态事件**（增量可被 stdout 背压丢弃）。
- **运行转录协议缺口**：automation 转录落 scoped 目录（
  `~/.aide/scopes/automation/<task>/claude`），`load_messages` 只扫全局
  `~/.aide/claude/projects` → 视图照建，桌面补齐前如实呈现空态。

## 改动清单（按文件）

### SDK 层

**1. `sdk/types.ets` — 补自动化 DTO（serde camelCase 镜像）**

- `Schedule`：单 interface + `kind` 字符串 + 全可选臂字段（time / weekdays /
  day / every / unit / at），序列化靠 JSON.stringify 丢 undefined，与 PWA 同形
- `AutomationTask`（22 字段：id/name/prompt/workspacePath|null/model/effort/
  permissionPreset/connectors/schedule/validFrom|null/validTo|null/missedPolicy/
  playbookEnabled/playbookState/notifySuccess/notifyFailure/enabled/createdAt/
  lastRunAt|null/lastRunStatus|null/maxTurns|maxBudgetUsd）
- `AutomationTaskInput`（无 id/createdAt/lastRun 系/playbookState——服务端管理）
- `RunRecord` / `RunUsage` / `RunStats`

**2. `sdk/api.ets` — `AideApi` 追加 11 个方法**

命令名/参数形状与 `automation.ts` 零偏差；Option 参数缺键 = None。**文件头
注释显著标注：此域命令未进远程 REGISTRY，桌面开口子前 invoke 必败。**

### 纯函数 / 状态层

**3. `session/AutomationFormat.ets`（新）**

  `scheduleText`（每天 18:30 / 每周一、三 18:30 / 每月 5 日 18:30 / 每 2 小时 /
单次 · 08-21 10:00）、`shortTime`（MM-DD HH:MM）、`formatDurationMs`（45s /
3m05s）、`runSummary`（error/note/status 分型文案）、`tokensText`
（31.2k · 90%缓）、`presetLabel`（auto=自动/full=全自动；**两档**——上游 v1
定案，readonly 仅是 serde 归并进 auto 的旧档别名，不出假选项）。

**4. `session/AutomationModel.ets`（新）— @ObservedV2 全局单例**

- 状态：`loaded/tasks/refreshing/lastError`、`view('detail'|'editor'|null)`、
  `selectedTaskId/editingTaskId`、`runs/stats/runsLoading/playbookView/
  runView`、`busyTaskId`（runNow 在途）
- 动作：`refreshTasks/selectTask/openEditor/createNew/closeEditor/saveTask/
  deleteTask/toggleEnabled/runNow/redistill/readPlaybook/openRun/closeRun/
  refreshRuns`；`handleBack()` 逐层收起（转录 > 手册 > 表单 > 详情）
- **live 事件层**（第三路 `chat-event` 监听，ChatModel/SessionsModel 双监听
  先例；监听挂传输实例只挂一次，ensureListener 幂等）：
  - `session_id` 以 `run_` 开头的 `session_init` → 登记别名（run_xxx →
    sdk_session_id；`{run_id}-d` 蒸馏轮同法）
  - 别名会话的 `message_stop`（stop_reason=="end_turn" → 成功，否则失败）/
    `error` / `session_dead` → `refreshTasks()` 对账（详情开着且命中当前任务
    则重拉 runs/stats）；**归因靠刷新**——事件流不含任务 id，lastRunStatus
    以列表拉取为权威
  - `onReconnected` → `refreshTasks()` 补断线窗口
  - 增强事件（`automation_run_finished` / `automation_missed`）桌面开口子后
    再消费，本期不解析
- 所有 invoke catch → `lastError` / toast，不崩不白屏

### UI 层

**5. `session/ChatDrawer.ets` — 自动化区段（IA 变体 A）**

插在工作区卡与历史会话区段之间：区段头（chevron 折叠 + 闹钟图标 + 「自动化」+
计数 + 呼吸点(running 在途) + ＋ 新建）；任务行两行制（名称 + 停用后缀 /
调度文本右对齐；第二行 running 字样 / 已暂停 / 从未运行 / 上次 MM-DD HH:MM·
结果）；点击 → `selectTask(id)` + 收抽屉；空态 / 加载中 / 失败重试三态；
抽屉打开且 `!loaded` 自动首拉。

**6. `session/AutomationDetail.ets`（新）— 屏 2 原型 1:1**

头部操作区（启停 Toggle / 立即运行——busy 禁用 / 编辑 / 删除确认自绘半模态，
文案「运行历史与手册将一并删除」）；提示词卡；手册卡三态（ready=查看手册+
重新提炼 / none=未生成+生成按钮 / stale=已过期提示）；统计条（近 30 天运行/
成功率/总成本/平均耗时/缓存命中，runs===0 隐藏）；运行记录 List（limit 100：
状态点/时间/触发 chip/耗时/轮次 chip/摘要/tokens/成本，skipped 行置灰不可点，
点击 → `openRun`）。live 事件命中当前任务（刷新对账）自动重拉。

**7. `session/AutomationEditor.ets`（新）— 屏 3 原型 1:1**

五区段：基本（名称/工作目录——不绑定+listWorkspaces、提示词）、执行配置
（模型——**选项取本地 ProviderConfigView 推导（model + modelMappings +
knownModels 去重），不调 get_default_models**；空 = 跟随桌面默认；思考档
EFFORT_TIERS）、权限与安全（预设**两卡** auto 推荐/full 危险色——上游 v1
两档定案，readonly 别名归并 auto 不出假选项 + 连接器
只读 chips——新建恒 []，编辑透传）、调度（kind 三段分段 + 子控件：周几
chips / 每月 N 日 / every+unit / once 日期+时间；错过策略 seg 补跑一次/
跳过并记录；**生效窗口与运行上限不暴露**——编辑透传原值）、手册与通知
（playbookEnabled / notifySuccess / notifyFailure 三 Toggle）。底部 取消/
保存/保存并运行。校验 4 条（名称/提示词/周几/单次日期）失败 toast。

**8. `session/RunTranscript.ets`（新）— 屏 4 原型 1:1**

`load_messages(record.sessionId, null, 页预算)` → `ChatTranscript` 映射 →
只读时间线（`MarkdownText` / `ThinkingCard` / `toolSummary`，不复制 ChatPage
流式状态机）；running 横幅 + 刷新入口；`nextOffsetBytes>0` → 「加载更早」；
`sessionId` 空串（skipped 行）不可点。协议缺口三未补前为空态，文案如实提示。

**9. `session/PlaybookSheet.ets`（新）— 屏 5 原型 1:1**

手册查看浮层：全屏 markdown（MarkdownText）+ 加载/空/失败三态 + 重新提炼入口。

### 接线

**10. `pages/ChatPage.ets` — 根 Stack 挂浮层**

抽屉层之上挂四个全屏浮层（translate/opacity transition）；`aboutToAppear`
里 `automationModel.ensureListener()`。

**11. `pages/Index.ets` — onBackPress 最前插 `automationModel.handleBack()`**

## 明确不做（后续增量）

- 桌面端三项协议缺口（REGISTRY+11 命令 / emit_finished+missed 进广播 /
  load_messages 支持 scoped）——桌面侧另行落地
- 运行中转录实时流（本期只读历史 + 手动刷新）
- MCP 连接器选择器（v1 只读展示，管理回桌面）
- `automation_missed` 系统级通知（v1 前台 toast 由增强事件驱动，本期未达）
- 表单 maxTurns / maxBudgetUsd / validFrom / validTo / sessionDir 暴露
- 新路由注册（浮层不进 main_pages，仍只有 pages/Index）

## 实现顺序

1. SDK（types → api）→ arkts_check
2. 纯函数（AutomationFormat）→ 状态层（AutomationModel）
3. 抽屉区段（ChatDrawer）→ 详情（AutomationDetail）→ 表单（AutomationEditor）
   → 转录（RunTranscript）→ 手册（PlaybookSheet）
4. 接线（ChatPage / Index）
5. `arkts_check` 逐文件全绿 → `build_project` 通过 → `start_app` 冒烟

每步之间用 `arkts_check` 快速反馈，最终以 `build_project` 收口。

## 验证要点

| 项 | 方法 | 预期 |
| --- | --- | --- |
| ArkTS | `arkts_check` 逐文件 + `build_project` | 零告警通过 |
| 冒烟 | 模拟器走抽屉 → 区段 → 错误态（REGISTRY 未开口子） | 呈现正确无崩溃 |
| live 通路 | 桌面恰在跑任务时 run_ 流监听触发刷新对账 | 呼吸点随 lastRunStatus 点亮 |

## 参考

- 上游 SDK：`packages/aide-sdk/src/api/automation.ts`（命令面唯一事实源）
- 后端：`src-tauri/src/automation/{mod,schedule,scheduler,commands}.rs`；
  事件泵 `src-tauri/src/runtime/mod.rs:396-449`
- 原型规格：`design/automation/app.html`（实现规格书，屏与浮层一一对应）
- 范式基准：`docs/remote-v3-implementation-plan.md`（文档格式）、
  `session/SessionsModel.ets`（三路监听先例）、`session/chat/ChatTranscript.ets`
  （HistoryBlock 映射复用）
