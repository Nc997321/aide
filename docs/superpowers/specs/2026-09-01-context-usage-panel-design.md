# 上下文用量分段面板设计（环形指示 + usage.html 弹层移植）

> 变更记录：2026-09-01 v2——迷你条方案取消，改为发送按钮左侧静态环形进度条（用户定案）。

- 日期：2026-09-01
- 状态：设计草案，待评审
- 关联：[2026-07-08-session-usage-panel-design.md](2026-07-08-session-usage-panel-design.md)（上一期：迷你条+额度圆点，成本行未实现）
- 关联记忆：memory-bloat 诊断与治理；UI 变体先出可视原型

## 1. 背景与目标

现状：聊天输入框底部的上下文用量只有一条单色迷你条 + 百分比（`ChatInputBox.vue:1049`），sidecar `emitContextUsage`（session-worker.ts:656）只上报 3 个字段。而 SDK `getContextUsage()`（0.3.228 起的 `SDKControlGetContextUsageResponse`，经 0.3.246 验证**类型零变化**）本就返回全量拆解：`categories[]`（含 name/tokens）、`rawMaxTokens`、`memoryFiles`、`mcpTools`、`agents` 等。数据现成，只是没用起来。

目标：把输入框底部的 ctx 条撤除，改为**发送按钮左侧的静态环形进度指示**（样式取自 usage.html 的 ring），点击弹出**会话体检弹层**（分段明细）。升级 SDK 0.3.246 顺带完成：rawMaxTokens 条纹段（原 2026-07-08 设计稿 4.1 未完成项）、Todo 工具回补、超限详情接口留口。

排雷一句话：诊断面板（DiagnosticsDashboard 的累计用量）是**进程级账本**，本期不动、不挪、不合并。

## 2. 范围

**本期做**：
1. SDK 0.3.228 → 0.3.246 升级（含 Todo 工具回补，见 §6）
2. sidecar `context_usage` 事件扩展（categories + raw_max_tokens）
3. 输入框底部 ctx 条撤除；发送按钮左侧新增**静态环形进度指示**（点击弹层）
4. 弹出 usage.html 样式弹层（分段条 + 明细列表 + 额度环 + 压缩按钮）
5. 保留区条纹段（rawMaxTokens，B 项补作业，画在弹层分段条内）

**先不做（YAGNI）**：
- memoryFiles/mcpTools/agents 逐项列表与点击跳转（弹层 v1 与 usage.html 同粒度：5 类聚合；逐项拆解二期再议）
- 0.3.232 消息侧 `SDKContextUsage` 负载与 `over_limit` 详情（控制侧 `getContextUsage()` 已够本期用；消息侧接入另立一期）
- 0.3.239 `costBasis` 价格来源标注
- 费用行/成本档（原 2026-07-08 设计稿 4.2/4.3 范畴，与本面板解耦，另行立项）

## 3. UI 设计

### 3.1 环形指示（发送按钮左侧，v2 定案）

现状底部一行 DOM 顺序：`权限模式徽章 → ctx 条(chat-ctx-usage, 1048-1058) → 5h 额度胶囊 → ChatSendButton`。改动：

- **撤除** `chat-ctx-usage` 整块（ctx 标签 + 单色条 + 百分比文字）及关联 CSS
- 新组件 **`ContextUsageRing.vue`** 插入到 `ChatSendButton` 之前（额度胶囊之后）：SVG 环形，尺寸 ~20px，样式同 usage.html 的 ring——底环（border token 色）+ 进度弧（stroke-linecap round，-90° 起点，`stroke-dashoffset` 随 percentage）
- **静态环形，不分段**：只表达总量占比；分段/保留区条纹只在弹层里
- 进度弧颜色状态联动（沿用现有额度状态色语义）：正常 → `--aide-accent`；≥80% → `--aide-warning`；超限 → `--aide-danger`
- hover tooltip 沿用现有文案（`上下文用量：x / y tokens`）；**点击 → 打开弹层**（从环形位置向上锚定）
- 5h 额度胶囊（chat-quota）不动、不并入

### 3.2 弹层（usage.html 主体移植）

新组件 `ContextUsagePanel.vue`（放 `src/components/ChatPanel/`，与 `ContextCompactionStatus.vue` 同级），从 ContextUsageRing 位置向上锚定，close 按钮 / 点击外部 / Esc 三路关闭。

| HTML 元素 | 移植决策 |
|---|---|
| header 标题 + close | 照搬；标题「上下文用量」 |
| 大百分比 + 已用/上限 | 照搬；tabular-nums 保留 |
| 分段彩条 | 每类一段，段宽 = tokens/rawMaxTokens，段间 2px surface 间隙；末尾**保留区条纹段**（`[maxTokens, rawMaxTokens]`，45° 条纹 + 中性半透明——不是分类，不占色板）；分段渲染抽独立子组件，弹层独有（环形不分段） |
| 明细列表（dot+名称+token） | dot 颜色 = 该分类的主题 token 色；名称/token 数字走 text token（**文字不穿系列色**，dataviz 红线）；段 hover tooltip：`名称 ~xx.xK` |
| 右下角灰环 | **改造成 5h 额度环**：承接 ChatInputBox 已有的 `rateLimit` 数据，环形进度 = 对应额度窗口的占用率，色用现有 status token（success/warning/danger）（迷你条旁的额度胶囊保留不动） |
| —（HTML 无） | 底部一行「压缩对话」按钮 → 发 `/compact`（原 2026-07-08 设计稿遗留项，弹层是其自然归宿，走现有 slash 命令回显通路） |

### 3.3 分类 → 色板映射（颜色跟实体走，不跟位置走）

SDK 的 `categories[]` 是动态列表。建立**稳定映射表**（前端单一常量）：

```
System Prompt → chart1    Tools → chart2    Conversation/消息 → chart3
MCP → chart4              Skills → chart5   未知/兜底 → chartFallback（中性）
```

- `color` 字段 SDK 会给，但**不用**——所有颜色必须走 `var(--aide-*)`（主题红线），SDK 色是 CLI 品牌色，不入主题
- 顺序按 token 槽位固定排列，类别缺席不重排不换色（dataviz：filter 改 series 数不得让幸存者换色）
- `isDeferred` 段以 60% 透明度渲染（表达"延迟加载"，无需新 token）

## 4. 分类色板（ThemeTokens 新槽位，已过校验器）

**usage.html 原色板直接驳回**：`#7B61FF`↔`#A78BFA` 两支紫色 ΔE 12.5（正常视力即难分辨，硬 FAIL）、绿/琥珀对底面对比 <3:1。按 dataviz 色板校验器（相邻对口径 + 2px 间隙二次编码）取参考色板槽位：

| 主题 | chart1~5 种子值（已 ALL PASS） |
|---|---|
| glass / warm-dark / catppuccin（暗） | `#3987e5` `#d95926` `#199e70` `#c98500` `#d55181` |
| smoky-pink-glass（浅） | `#2a78d6` `#eb6834` `#1baf7a` `#eda100` `#e87ba4` |

**落地方式（主题封闭契约）**：`ThemeTokens` 新增 `chart1`~`chart5` + `chartFallback` 槽位 → `apply.ts` 自动生成 `--aide-chart-*` 变量 → 4 个主题文件各给值。上表为种子值：catppuccin 可在**过校验器前提下**换自家色系（换值必须重跑校验）；smoky-pink-glass 浅色组对白底有 contrast WARN，由明细列表可见文字 + 2px 间隙兜底（合规 relief），不再调深。

验收：每主题对 `bgDeep` 实际合成底跑一次校验器（暗 3 主题 × 浅 1 主题各一枪），留输出贴任务日志。

## 5. 数据契约（IPC 变更，镜像 sidecar types.ts ↔ src/types/chat.ts）

```ts
// sidecar：context_usage 事件扩展（emitContextUsage 同点位增读字段）
type ContextUsageEvent = {
  type: "context_usage";
  total_tokens: number;
  max_tokens: number;
  percentage: number;
  raw_max_tokens?: number;                       // 新：完整窗口；缺省不画条纹段
  categories?: { name: string; tokens: number; isDeferred?: boolean }[];  // 新：分段数据
};
```

- 前端 `ContextUsage` 类型同步扩展（`rawMaxTokens?` / `categories?`），全部可选 → 0.3.228 旧数据照常渲染单色条（天然降级）
- emit 点位不变（session-worker 1172/1266 两处），`emitContextUsage` 内补读 `categories` 与 `rawMaxTokens`，try/catch 静默语义保留
- 前端 `useChatSession.ts` 的 `case "context_usage"` 补两个可选字段透传

## 6. Todo 工具回补（0.3.233 应对，**升级破坏的唯一直接用户可感项**）

0.3.233 起 Todo/task 工具（`TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`/`TodoWrite`）在 Opus 4.8 / Sonnet 5 / Fable 5 等模型**不再默认进工具面**。Aide 的 `TaskListPanel` 与 sidecar TODO 清理逻辑（session-worker.ts:920「有新 todo 才覆盖」）重度依赖这组工具，不回补则任务面板静默变空。

**方案**：sidecar 构造 query env 处（envOverrides 同层）统一注入 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`。选 env 而非 `query.tools` 显式收编的理由：env 只恢复这一组工具的默认地位，不触碰 `tools` 白名单的整体交互（btw taskTools / automation 白名单均已成型，动 tools 列表会牵连）。

验收：升级后新会话发一条会触发建 todo 的消息，TaskListPanel 正常出现（回归点）。

## 7. SDK 升级清单

1. `agent-sidecar/package.json`：`@anthropic-ai/claude-agent-sdk` `0.3.228` → `0.3.246`（保持精确锁）
2. 装依赖（sidecar 走 `npm --prefix`，不进 pnpm workspace）
3. 重建 `dist/runtime.js` + 重启 app（sidecar 改动惯例流程）
4. 已确认无影响项：0.3.234 删 `ExitReason.bypass_permissions_disabled`（全仓 0 引用）；`SDKControlGetContextUsageResponse` 新旧零差异
5. 测试对账：sidecar vitest + 前端 vitest（`useChatSession.test.ts` 的 `context_usage` 用例补 categories/raw_max_tokens 断言）
6. 提交备注版本号；升级后发一轮真实会话确认 TaskListPanel / 发送键左侧环形 / 弹层分段与明细三处

## 8. 红线对账

- **主题**：全部新色走 `--aide-chart-*` token，无硬编码 hex（§4 已给各主题值）；`tailwind.config.js` 不动
- **跨平台**：纯前端 + sidecar TS 改动，无 Rust 路径/进程代码，零平台分支
- **分层**：新组件两个——`ContextUsageRing.vue`（环形指示，ChatInputBox 只插一枚）与 `ContextUsagePanel.vue`（弹层）；分段渲染为弹层内子组件，ChatInputBox 不内联堆码；映射表为前端单常量，不改 useChatSession 结构
- **数据降级**：categories/rawMaxTokens 可选——环形只吃 percentage（旧事件形状照常工作）；categories 缺省时弹层隐藏分段与明细列表（或显示"暂无明细"占位），无 break
## 附录：分支覆盖对账表（2026-09-01 修复轮后）

| 层 | 函数/分支 | 测试 | 实测证据 |
|---|---|---|---|
| 纯逻辑 | chartVarFor 归桶（5 槽+优先级+未知兜底+空串） | `contextUsage.test.ts` 5 例 | v8 分支 100%（审查者第一轮代跑实测） |
| 纯逻辑 | formatTokens（≥1K/999/0）、clampPct（0.5/-5/150 边界） | 同上 | 同上 |
| SDK 路由 | events.ts `context_usage` case：raw_max_tokens 双臂 + categories 双臂 + isUsageCategory 守卫（null/缺 name/tokens 非数值剔除） | `useChatSession.test.ts` 透传+降级+非法元素剔除用例（63/63） | vitest 实测绿 |
| sidecar | emitContextUsage try/catch、categories map、raw_max_tokens 透传 | `session-worker.test.ts` 2 例（color 丢弃断言 + 抛错静默） | 实测绿（564/564） |
| Ring | level 三臂（62.8/80/99.9/100/150 越界）+ dashoffset + open 事件 | `ContextUsageRing.test.ts` 5 例 it.each | 实测绿 |
| Segments | 段宽基准（5.5%）、零 token 过滤、deferred 类、保留区条纹段（20%）、rawMax 缺省空态 | `ContextUsageSegments.test.ts` 5 例 | 实测绿 |
| Panel | 三路关闭（Esc 消费标记/外点/面板内不关）、compact emit（不自行关）、明细空态占位、额度环状态臂（42→ok/96→warning/**100→danger**）、无窗口隐藏、**position 生产路径（openUp 双臂：top 494/16、left 696 clamp、visibility hidden 解除）**、watch null 臂（首帧 hidden，不进 position） | `ContextUsagePanel.test.ts` 11 例（布局桩 stubPanelMetrics/anchorAt，try/finally 还原） | 实测绿 |
| 集成 | ChatInputBox sessionId 切换复位 usagePanelOpen（定名搬迁不拆面板） | `ChatPanel.test.ts` effort 跨会话用例（含 TDZ 回归实锤修复） | 实测绿 |

机械检查终态：前端 vitest **153 files / 1698 tests 全绿**（零 unhandled）；sidecar **564/564**；vue-tsc 与 tsc --noEmit 双零错误；dist/runtime.js 已重建。终审结论：通过（position 生产路径 hits=2、openUp/clamp/danger 全臂实测，对账表与实测逐项吻合）。
