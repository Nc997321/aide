# 工具调用折叠组 + 墨线装帧视觉改版 · 设计文档

日期：2026-07-07
状态：已与用户确认（分组行为 + 视觉方向 B「墨线装帧」+ 整页形态 B2「通页」）

## 背景与目标

Agent 回合中动辄十几条连续的工具调用，每条一张卡片，把消息流刷成命令墙，可读性极差（见用户截图：18 条 Read/Glob/Grep 连排）。同时现有对话视觉（emoji 状态图标 ✅❌⏳、通用灰卡片、字符箭头 ▲▼）质感平庸，与 aide 暖铜工匠主题不符。

目标：

1. 连续工具调用默认折叠成一行摘要，按需展开。
2. 对话区整体改版为「墨线装帧」视觉语言：去盒子、上书脊线、描边 SVG 图标全面替换 emoji。

## 一、分组行为（已确认）

- **分组范围**：仅 assistant 消息参与分组。user 消息里的 @mention（也是 tool_call 块）是附件展示，保持原样。
- **分组规则**：顺序扫描 `blocks[]`，连续的 `tool_call` 归为一组；被 text / image / subagent 块打断则开新组。**单条也成组**（全部折叠，无阈值）。
- **收起行（默认，完成态）**：`18 次工具调用  Read ×10 · Glob ×4 · Grep ×4`。工具种类按次数降序取前 3 种，其余归入 `…`。
- **失败提示**：组内有 `isError` 的调用时，收起行追加红色 `· N 失败`；**不**自动展开（agent 流程中探测性失败很常见，自动展开会重新制造刷屏）。
- **流式态**：组是消息最后一段且末条 `isPending` 时，收起行实时更新为 `正在执行 Read …\SpectralServiceImpl.java · 已完成 11`（复用 `summarizeToolInput()`），节点呼吸闪烁。始终只占一行，无布局跳动。
- **展开**：点击摘要行 → 组内逐条列出工具调用（沿墨线挂节点），每条仍可再点开看参数 / 结果（保留现有 BashOutputBlock、Edit diff 渲染）。流式期间用户展开的组保持展开，新块实时追加，不自动收回。
- **展开状态**：组件内 `ref`，默认收起。随 `useMessageWindow` 窗口化卸载而重置——上滚加载的旧消息天然收起，正合适。

## 二、视觉系统「墨线装帧 · 通页」（已确认）

用户从三个方向（A 鎏铜细作 / B 墨线装帧 / C 活字档案）中选定 B，并在整页形态对比（B1 留盒 / B2 通页）中选定 **B2**。mockup 存档于 `.superpowers/brainstorm/712-1783403521/content/`。

### 布局

- **assistant 气泡移除**：正文直接落在页面背景（`--aide-bg-base`）上，不再有 `--aide-surface-default` 面板。
- **回合书脊**：整个 assistant 回合（正文 + 工具墨线 + 用量）左侧一条 2px 铜色书脊 `rgba(212,165,116,.45)`，`padding-left: 18px`，最大宽度约 94%。
- **user 消息不变**：右对齐铜底签条（`--aide-accent` 底、深色字）。

### 工具墨线（ToolCallGroup）

- 摘要行挂在 1px 铜色垂线（`rgba(212,165,116,.35)`）上，行首一枚 9px 空心铜圈节点；流式态节点实心 + 呼吸动画（`box-shadow` 扩散脉冲，1.2s）。
- 展开后组内每条是一行：5px 实心小节点（默认 `--aide-surface-active`，失败 `--aide-danger`）+ 工具名（`--aide-text-secondary`，600）+ 参数摘要（`--aide-text-muted`，mono，超长省略）。
- 数字用铜色 `--aide-accent` 强调，种类统计用 `--aide-text-muted`。

### 图标语言（全局替换 emoji）

- 状态一律用**节点圆点**表达：完成 = 灰点、失败 = 红点、执行中 = 铜色呼吸点。不再用 ✅❌⏳。
- 展开/收起箭头用 1.4px 描边 SVG chevron（圆角线帽），不再用字符 ▲▼。（注意项目约定「三角箭头统一 font-size: 14px」是针对字符箭头的，SVG 替换后以 12px 视觉尺寸对齐。）
- Edit diff 的 `+N -N` 统计保留（绿/红），出现在展开后的行内。

### 回合用量（TurnUsageBadge)

- 挂在书脊末端：mono、10.5px、`--aide-text-muted`，形如 `↑ 12.4k · ↓ 3.1k · $0.08`。

## 三、实现结构

数据层完全不动（store、IPC 协议、持久化、历史重建均不涉及）——纯渲染层改版。

新增：

- `src/utils/blockSegments.ts` — 纯函数 `segmentBlocks(blocks): Segment[]`，输出 `{ kind: 'block', block }` 或 `{ kind: 'tool_group', blocks: ToolCallBlock[] }`。
- `src/components/ToolCallGroup.vue` — 墨线组组件：摘要行（完成/流式两态）+ 展开列表，内部复用 `ToolCallBlock`。

修改：

- `src/components/ChatMessage.vue` — v-for 从裸 blocks 换成 segments（仅 assistant 走分组）；assistant 气泡样式改为通页书脊布局。
- `src/components/ToolCallBlock.vue` — 行样式改为墨线节点行；展开箭头换 SVG；状态图标换节点圆点；参数/结果展开区保留现有渲染（BashOutputBlock / diff / pre）。
- `src/components/TurnUsageBadge.vue` — 按新视觉微调（如已符合则不动）。
- `src/components/SubagentCallBlock.vue` — 本期不重做，仅确保在通页布局下不破版。

## 四、性能

- 分组是 O(n) computed，可忽略。
- 收起状态下一个 18 条工具的回合从 18 个卡片 DOM 变 1 行，对切会话挂载卡顿（useMessageWindow 主线）是净收益。
- 呼吸动画只用 opacity/box-shadow，不触发布局。

## 五、测试

- `blockSegments` 纯函数单测：连续 / 被 text 打断 / 单条 / 空 / 首尾工具块 / user 消息不分组。
- 手动验证：流式执行中摘要实时更新、展开中流式追加、历史会话回放、失败计数、窗口化上滚后默认收起。

## 六、明确不做（YAGNI）

- 不做展开状态持久化（跨会话记住哪组展开过）。
- 不做「自动展开失败组」。
- 不动 SubagentCallBlock 的内部视觉（另开任务）。
- 不动数据层 / IPC / sidecar。
