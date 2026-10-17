# 会话内组成重排 · 第一期 Implementation Plan

> **状态：已实现（2026-10-16，一个提交）。** 与计划的出入：
> - 两个 dock 组件没有拆成新文件，而是**删掉各自的状态条**、只留面板，由 `activity/ActivityDrawer` 按 tab 挂载；
> - LSP 询问保持原来的轻量一行外观（不改成权限卡家族），只是挪进作答槽；
> - 额度徽标只在吃紧（≥80%）时露面，平时在环的用量弹层里；
> - 真机未走查（本机无法渲染 Tauri 前端），走查清单见文末。

> **For agentic workers:** 按任务顺序做，每个任务一个提交；步骤用 `- [x]` 跟踪。

**Goal:** 把消息区与输入框之间「一条条往下堆」的组成，收成四个固定区位 + 单行输入框，并让会话列默认居中限宽。
本期**不涉及子会话**——子会话进来时只是往活动带加一个 chip、往作答槽加一种卡（第二期）。

**Spec:** `docs/superpowers/specs/2026-10-16-subsessions-design.md` §8.6（线框 A1 / A2 / A4：
https://claude.ai/artifact/YBy6WCCG3d6ChZERoXLouC ）

**改动面：** 只动桌面前端 `src/components/`、`src/composables/` 与 `packages/aide-sdk` 的会话 store（dock 开合字段）。
已核对：remote-pwa 不读 `bgDockOpen` / `subagentDockOpen` / `toggle*Dock`，手机端不受影响。

## 目标组成（自上而下，`ChatPanel.vue`）

| 区位 | 今天 | 第一期之后 |
|---|---|---|
| 会话头条 | `TaskListPanel`：摘要条 + 新任务自动展开、挤压消息区 | 单行头条；清单改为**浮层**下拉，不再挤压；无待办时不渲染 |
| 消息流 | 不变 | 不变（内容列居中限宽） |
| 作答槽 | `PermissionDialog`（权限 / 计划 / 提问 / 发送确认已在一个队列）+ 输入框上方 slot 里的 `LspSendPrompt` | 同一位置**一次一张卡**：权限队列优先，其次 LSP 询问；「另有 N 条」计入两者 |
| 活动带 | 压缩状态 / 思考行 + 子代理状态条 + 后台任务状态条（三条） | **一条**：左侧活动状态（思考 / 压缩 + 计时 + 轮换提示），中间 chip（子代理 N · 后台 N），右侧中断 |
| 活动抽屉 | 两个 dock 各自的展开面板 | **一个**底部抽屉，按 tab 切换「子代理 / 后台任务」，面板内容原样复用 |
| 输入框 | `rows=3` 文本框 + 底部工具栏两层 | **一行横排**，随内容撑高；模型·档位合成一个 chip；`＋` 菜单 |

**不进作答槽**（相对 spec 的修正）：`ModelSwitchConfirm` 是 Teleport 到 body 的模态框，由用户刚点的模型切换直接触发、
10s 超时，本来就不在那一摞里，保持原样。spec §8.6 同步改。

---

## Task 1：会话列居中限宽

**Files:** `src/components/ChatPanel/ChatPanel.vue`（样式）、`src/components/ChatPanel/ChatInputBox.vue`（样式）

- [x] `.chat-panel` 上定义 `--chat-col-max: 860px`（布局尺寸，不是配色，不进主题 token）。
- [x] 滚动容器 `.chat-messages` **保持满宽**（滚动条贴窗格边），内容盒 `.chat-messages-body` 加
      `max-width: var(--chat-col-max); margin: 0 auto; width: 100%`。
- [x] 头条、作答槽、活动带、活动抽屉、输入区外层统一包一层 `.chat-col`（同一套 max-width + 居中），
      不在每个组件里各写一份。
- [x] 窗格比上限窄时自然满宽（`width:100%` + `max-width` 即可，无需媒体查询）。
- [x] hero 欢迎态不受影响（它自己居中）；`chat-panel--hero` 下核对一遍。
- [x] `TurnChangeCard`、回到底部按钮的定位跟着内容列走（按钮仍锚在 `.chat-scroll-wrap`，水平位置对齐列右缘）。
- [x] 验证：`pnpm vitest run src/components/ChatPanel` 绿；`vue-tsc --noEmit` 干净。
- [x] 提交 `feat(chat): 会话列默认居中限宽`

## Task 2：单行头条（TaskListPanel → 浮层下拉）

**Files:** `src/components/TaskListPanel.vue`、`src/composables/useTaskListCollapse.ts`（及其测试）

- [x] 头条恒为一行：`[图标] 计划 ▬▬ 2/4 · 当前步骤文本 ▾`（复用现有摘要条的聚合：completedCount / inProgressTask）。
      加一条细进度条（主题 accent）。
- [x] 清单改为**浮层**：`position:absolute` 挂在头条下方、`z-index` 走 overlay 层约定
      （`check:overlay-layers` 的规则），点外部 / Esc 关闭；不再用 grid-rows 过渡挤压布局。
- [x] **去掉「新任务到来自动展开、稳定后自动收起」状态机**：浮层自动弹出会盖住正在流式的正文。
      `useTaskListCollapse` 简化为纯开合（或删掉改用组件内 ref），测试随之改写。
- [x] 全部完成时头条显示「计划 4/4 · 全部完成」；无待办时整条不渲染（`ChatPanel` 现有 `v-if` 保留）。
- [x] `PermissionDialog` 注释里「与顶部 TaskListPanel 一同挤压」的理由已不成立，顺手更新注释（折叠按钮本身保留）。
- [x] 测试：头条文本 / 进度、点击开合、Esc 关闭、无自动展开。
- [x] 提交 `feat(chat): 待办改单行头条，清单浮层下拉`

## Task 3：活动抽屉——两个 dock 面板合一

**Files:** 新建 `src/components/activity/SubagentPanel.vue`、`src/components/activity/BgTaskPanel.vue`、
`src/components/activity/ActivityDrawer.vue`；删 `SubagentDock.vue` / `BgTaskDock.vue` 的状态条部分；
`packages/aide-sdk/src/composables/useChatSession/state.ts`

- [x] 把 `SubagentDock` / `BgTaskDock` 的 `v-if="open"` 面板（列表 + 阅读区 / xterm）原样抽成两个 Panel 组件，
      逻辑（选中、停止、xterm 生命周期）跟着走，不改行为。
- [x] `ActivityDrawer`：tab 头（`子代理 N` / `后台任务 N`，计数为 0 的 tab 仍可点、显示空态）+ 收起按钮；
      主体按 tab 渲染对应 Panel；高度 `min(440px, 45%)`，inline 挤压消息区（与今天 dock 一致，不做浮层）。
- [x] store：保留 `bgDockOpen` / `subagentDockOpen` 两个字段和现有清理语义（「结束的留着回看，关面板才清」），
      新增 `openActivity(sid, tab: "subagent" | "bg" | null)`：打开一个 tab 时先按原 toggle 语义关掉另一个
      （**同一时刻最多一个为 true**），null = 全关。`toggle*Dock` 改为内部调用它；ChatPanel 的
      「后台运行中」徽章入口照旧可用。
- [x] `state.ts` 现有 dock 测试照跑；补「打开 A 自动关 B 并执行 B 的清理」用例。
- [x] 提交 `refactor(chat): 子代理 / 后台任务面板合并为一个活动抽屉`

## Task 4：活动带——三条状态条合一

**Files:** 新建 `src/components/activity/ActivityStrip.vue`；`ChatPanel.vue`；`ContextCompactionStatus.vue`

- [x] 一行：左 = 活动状态（压缩中 → `ContextCompactionStatus` 的内容；思考中 → Logo 动画 + 「正在思考」+ 计时 +
      轮换提示；空闲 → 不显示），中 = chip `子代理 N`（运行中数 / 有运行中时带脉动点）与 `后台 N`，
      右 = `InterruptButton`（仅 busy）。
- [x] chip 点击 → `openActivity(sid, tab)`；再点当前 tab 的 chip = 收起。chip 的计数口径沿用两个 dock 状态条的
      `barState` / `barText`（运行中优先，否则「已完成 N」），逻辑搬进 `activity/` 下的纯函数并加单测。
- [x] 显隐：busy 或任一 chip 有内容时渲染；都没有时整条不占高度。「有待确认卡片时不显示正在思考」规则保留
      （`!displayedPermission`）。
- [x] 位置：活动抽屉在活动带**上方**展开（抽屉头贴着活动带），输入框始终在最下。
- [x] 删除 ChatPanel 里的 `.chat-thinking` 行、两个 dock 的挂载；`ChatPanel.test.ts` 相应断言迁移到 ActivityStrip 测试。
- [x] 提交 `feat(chat): 思考行与子代理 / 后台状态条合并为一条活动带`

## Task 5：作答槽——一次一张卡

**Files:** 新建 `src/components/ChatPanel/AnswerSlot.vue`；`ChatPanel.vue`；`LspSendPrompt.vue`（只改外观对齐）

- [x] `AnswerSlot` 只做**仲裁**：输入 = `displayedPermission`（已含发送前确认与真实权限队列）、`lspAsk`；
      优先级 权限队列 > LSP 询问；渲染胜出者对应的组件（`PermissionDialog` / `LspSendPrompt`），其余计入「另有 N 条」。
      第二期加「子会话等批准」只是多一个输入、排在最后。
- [x] `PermissionDialog` 的 `queueCount` 改由 AnswerSlot 传「全部待作答数」；组件内部不变。
- [x] `LspSendPrompt` 从 `ChatInputBox` 的 `#above-box` slot 挪进 AnswerSlot；外观改成与权限卡同一家族
      （同圆角、同描边、同按钮），文案与三个动作不变。`#above-box` slot 若无其他使用者则删除。
- [x] `inputStow`（有阻塞卡时收起输入框）判定改为「AnswerSlot 有卡」。
- [x] 测试：两源同时存在时只渲染权限卡且显示「另有 1 条」；权限清空后 LSP 询问顶上来。
- [x] 提交 `feat(chat): 权限确认与 LSP 询问收进同一个作答槽`

## Task 6：单行输入框

**Files:** `src/components/ChatPanel/ChatInputBox.vue`；新建 `src/components/ChatPanel/ModelEffortPicker.vue`、
`src/components/ChatPanel/ComposerPlusMenu.vue`；`ContextUsagePanel.vue`

- [x] 结构：`.chat-input-box` 内上方保留芯片区（btw 横幅 / 场景胶囊 / 圈选 / 引用 / 附加目录 / 图片，原样），
      下方一行 `[＋] [textarea] [模型·档位] [权限] [环] [发送]`，`align-items: flex-end`。底部工具栏那一层删除。
- [x] textarea：`rows=1`，输入时按 `scrollHeight` 自动撑高，上限 = min(12 行, 窗格高度 40%)，超出内滚；
      发送 / 清空后回落一行。撑高逻辑抽成 `useAutoGrow(textareaRef, maxPx)` 并单测（jsdom 下 mock scrollHeight）。
- [x] `ModelEffortPicker`：一个 chip 显示「模型 · 档位」，点开一个弹层，上半模型列表、下半三档 effort；
      复用现有 `handleModelChange` / `handleEffortChange` 与 btw 模式禁用规则（`BTW_SELECTOR_HINT`）。
- [x] 权限模式：单独 chip（仍用 `ThemedSelect`，换紧凑外观）；`bypassPermissions` 时 chip 恒红 + 现有 tooltip，
      原来那枚「⚠️ 跳过确认」徽章并入 chip 本身。
- [x] 额度徽标（`quotaBadge`）从工具栏移除，内容已在 `ContextUsagePanel`（环的弹层）里；无上下文环时
      （欢迎页）额度提示进 `＋` 菜单的「上下文与用量」项。
- [x] `ComposerPlusMenu`：添加图片（文件选择 → 现有 `pendingImages` 管线）、引用文件或目录（在光标处插入 `@`
      并触发现有补全）、命令与技能（插入 `/`）、顺便问一下（切 `btwMode`，禁用规则同发送按钮）、上下文与用量
      （开 `ContextUsagePanel`）。键盘直接输 `@` `/` 的行为不变。
- [x] `ChatSendButton` 不动（快捷动作下拉保留）。
- [x] hero 欢迎态用同一组件：场景条照旧在框上方；核对 hero 下一行布局不挤。
- [x] 测试：`ChatInputBox.test.ts` 里依赖工具栏 DOM 结构的断言迁移；新增 autoGrow、PlusMenu 各项动作、
      ModelEffortPicker 切换与 btw 禁用。
- [x] 提交 `feat(chat): 单行输入框——自动撑高，模型·档位合一，＋ 菜单`

## 收尾

- [x] spec §8.6：作答槽不含 ModelSwitchConfirm（见上）；第一期标记完成。
- [x] 全量 `pnpm test`、`vue-tsc --noEmit`、`pnpm check:overlay-layers` 绿。
- [x] **真机走查清单**（用户来看）：
  1. 宽窗口居中、分屏 / 右栏展开时满宽不留白；
  2. 待办头条浮层不挤压、流式中不自动弹出；
  3. 同时有子代理与后台任务时只有一条活动带，chip 切抽屉 tab；
  4. 权限卡与 LSP 询问同时出现时只见一张 +「另有 1 条」；
  5. 输入框空时一行，粘贴长文逐行撑高到上限后内滚，发送后回落；
  6. 跳过确认模式 chip 恒红；`＋` 菜单五项都能用；
  7. 欢迎页（hero）输入与场景条正常。
