# 会话用量面板（Session Info Panel）设计

- 日期：2026-07-08
- 状态：设计定稿，待评审 → writing-plans
- 关联记忆：aide 用量烧太快＝用了最贵的 Fable 5（`aide-fable5-quota-burn`）

## 1. 背景与目标

排查「迁 Agent SDK 后 aide 用量烧得特别快、一个任务没跑完就把 5 小时窗口耗尽」，用真实 session 账本坐实根因：**用户长期坐在最贵的模型 Fable 5 上**（输入 $10 / 输出 $50 每百万 token，是 Sonnet 的 3.3×、比 Opus 还贵一倍），而自己不自知。缓存、SDK、切供应商都不是主因。

**目标**：把「这个会话花了多少、用的哪个模型有多贵、上下文多满、账号 5 小时额度还剩多少」做成一个**一眼可见**的会话信息面板，让用户能主动选便宜模型 / 及时压缩，而不是事后被限额打断。这是一个**可见性 + 引导**功能，不是"机械减 token"（SDK 未暴露可调压缩阈值 / context-editing，无此杠杆）。

## 2. 范围

**本期做**：一个会话信息弹层面板，含以下行——**有数据才显示那一行（自适应）**，不照抄参考图的固定行数：

1. 会话成本（真实美元）
2. 当前模型 + 成本档（如 `Fable 5 · 最贵 3.3×`）
3. 上下文窗口（已用 / 上限 + 百分比 + 进度条 + "保留用于响应"条纹段）
4. 账号 5 小时额度（+ 重置时间）
5. 「压缩对话」按钮 → 发 `/compact`

**先不做（YAGNI）**：
- 模型下拉逐项成本标签（被面板里"当前模型+档"取代）
- `taskBudget` 单任务预算护栏（属另一类"护栏"功能，单独一期）

## 3. 架构与红线

**跨平台 + provider-agnostic 是硬红线**（见 CLAUDE.md）。逐项守住：

- 成本 / 上下文 / 压缩：**全走已有的 provider-agnostic 通路**——`total_cost_usd`、`context_usage`、本地命令回显。零红线问题。
- **成本档（"最贵 3.3×"）是唯一含 Claude 专属知识的部分**：定价表**只准待在 `agent-sidecar/`**。做法——sidecar 侧维护「模型 → 成本档」表，在 `models_available` 事件里给每个 `ModelOption` 附一个**通用形状**的 `costTier` 字段；前端只渲染 sidecar 给的档位标签 + 倍数，**不知道背后是 Claude 价**。第三方模型（glm/mimo）不在表里 → 无 `costTier` → 前端不显示档。

## 4. 数据契约（IPC 变更）

镜像改动：`agent-sidecar/src/types.ts` 与前端 `src/types/chat.ts` 保持一致。

### 4.1 `context_usage` 事件加 `raw_max_tokens`
- sidecar `emitContextUsage` 已读 `getContextUsage()` 的 `totalTokens/maxTokens/percentage`，再加读 `rawMaxTokens`。
- 语义：`rawMaxTokens` = 完整上下文窗（如 1M），`maxTokens` = 可用于输入（窗口减去为响应预留的部分）。**"保留用于响应"段 = `[maxTokens, rawMaxTokens]`**。
- 前端 `ContextUsage` 类型加 `rawMaxTokens?: number`；缺省时不画条纹段（降级）。

### 4.2 `ModelOption` 加 `costTier`
```ts
interface ModelCostTier {
  tier: "economy" | "standard" | "premium" | "max"; // 通用档位，非 Claude 专属词
  relative: number; // 相对基准(standard=1)的倍数，如 fable=3.3
}
interface ModelOption { value: string; displayName: string; costTier?: ModelCostTier; }
```
- 只有 sidecar 侧成本表命中的模型才带 `costTier`；其余（第三方）不带。

### 4.3 会话成本累计（前端，不需新事件）
- `message_stop` 已带 `usage.costUsd`（mapper 从 `modelUsage[].costUSD` 求和 = 本轮成本）。
- 前端在每条 `message_stop`（`usage` 非空）上 **累加** `store.sessionCostUsd += usage.costUsd`。
- **选累加而非直接取 `total_cost_usd`** 的原因：aide 自己持有的累加值能跨 sidecar 重启（切供应商/错误重连）存活，不会被新进程的计数归零。
- 第三方 provider 常报 `costUsd = 0/缺省` → `sessionCostUsd` 恒 0 → 成本行按"无数据"隐藏。

## 5. 成本档表（agent-sidecar）

新增 `agent-sidecar/src/modelCost.ts`（Claude 专属，允许）：

| 档位 | 模型（别名 / wire 前缀） | relative（按输入价 ÷ Sonnet） |
|---|---|---|
| economy | haiku / claude-haiku | 0.3 |
| standard | sonnet / claude-sonnet | 1（基准） |
| premium | opus / claude-opus | 1.7 |
| max | fable / claude-fable、mythos / claude-mythos | 3.3 |

- 导出 `tierFor(model: string): ModelCostTier | undefined`，按**别名优先、wire-id 前缀兜底**匹配（SDK 学到的模型 `value` 是别名、`resolvedModel` 是 wire id，两者都可能出现）。
- `index.ts` 的 `emitModelsAvailable` 在 `map` 每个模型时调用 `tierFor` 附加 `costTier`。
- relative = 输入价 ÷ **Sonnet 标准价 $3**（**刻意用标准价、不用 8/31 前的 $2 intro 价**，否则 intro 期档位会漂到 5×，失去稳定参照）、四舍五入一位小数；定价若变，只改这一张表。

## 6. 组件设计

### 6.1 新组件 `src/components/SessionInfoPanel.vue`（独立模块，不往 ChatPanel 内联堆）
- **折叠态（触发器/药丸）**：显示上下文百分比 + 一个状态点（沿用 `.chat-quota--{ok|warning|exceeded}` 的 80%/100% 阈值色）。放在 ChatPanel 输入区，**取代**现有的 `.chat-ctx-usage` + `.chat-quota` 那排小徽标。
- **展开态（弹层）**：点药丸弹出。**复用 `ContextMenu.vue` 的弹层范式**——`Teleport to body`、`position: fixed` + 视口边缘夹取、`Transition` 缩放淡入、外部点击 / Esc 关闭。
- **自适应行**：每行 `v-if` 各自的数据存在才渲染（成本 / 档位 / 5小时额度都可能缺）。上下文行在有 `contextUsage` 时才显示。
- **样式**：全部用 `--aide-*` 设计令牌（`--aide-bg-deep`/`--aide-surface-default`/`--aide-text-primary|secondary|muted`/`--aide-danger`/`--aide-shadow-lg`/`--aide-radius-sm`），进度条复用 `.chat-ctx-bar`/`.chat-ctx-bar-fill` 的既有观感；scoped `<style>` 即可（非 xterm 动态 DOM）。

### 6.2 Props（provider-agnostic，沿现有 PaneGroup → ChatPanel 传递链）
```ts
contextUsage?: ContextUsage | null   // 已有，加 rawMaxTokens
rateLimit?: RateLimitInfo | null     // 已有
sessionCost?: number | null          // 新增（美元；null=隐藏成本行）
currentModel?: string                // 已有
models?: ModelOption[]               // 已有，元素加 costTier
```
- 面板内按 `currentModel` 在 `models` 里查出 `displayName` 与 `costTier`，拼「Fable 5 · 最贵 3.3×」（`tier=max` 显示「最贵」、`premium`「较贵」、`standard`「标准」、`economy`「最省」，后接 `×relative`）。
- `emit('compact')`。

### 6.3 接线
- `ChatPanel.vue`：删掉现有 `.chat-ctx-usage`/`.chat-quota` 内联块，换成 `<SessionInfoPanel ... @compact="onCompact" />`；`onCompact` 调用 useChatSession 发送 `"/compact"`（无图片）。压缩按钮在 `isBusy` 时禁用。
- `PaneGroup.vue`：像现有 `contextUsage`/`rateLimit` 一样，把 `sessionCost` 透传下去。
- `useChatSession.ts`：per-session store 加 `sessionCostUsd: number | null`（初始 null，首条带 usage 的 message_stop 起累加）；`contextUsage` 结构加 `rawMaxTokens`；对外 computed 暴露 `sessionCost`——**累计 ≤0 时返回 `null`**，让 prop 的「`null`＝隐藏成本行」语义干净（第三方/未计费即隐藏，不会误显 `$0.00`）。

## 7. 边界与降级

| 情况 | 表现 |
|---|---|
| 第三方 provider（glm/mimo），`costUsd` 恒 0 | 成本行隐藏 |
| 第三方模型无 `costTier` | 模型行只显示模型名，无档位徽标 |
| `rate_limit.windows` 为空（非订阅 / SDK 不支持实验性 /usage） | 5 小时额度行隐藏 |
| `context_usage` 尚未到（首轮前） | 上下文行隐藏；药丸显示中性态 |
| `rawMaxTokens` 缺省 | 上下文条正常画，仅不画"保留用于响应"条纹段 |
| 全部行都无数据 | 药丸仍在（保持入口一致），面板显示「等待首轮…」 |

`/compact` 的确认文案走已有 `system/local_command_output → text_delta + message_stop` 通路，无需新协议。

## 8. 测试

- `agent-sidecar/src/modelCost.test.ts`：`tierFor` 对 fable/opus/sonnet/haiku（别名与 wire 前缀两种写法）返回正确档位与倍数；对 `glm-5.2`/未知返回 `undefined`。
- `useChatSession.test.ts`：连续 `message_stop` 的 `usage.costUsd` 正确累加进 `sessionCostUsd`；`usage` 为空的轮次不改动；`context_usage` 的 `rawMaxTokens` 正确落库。
- `SessionInfoPanel`：给定各 props 组合，断言"有数据才显示行"（成本/档位/5小时额度分别缺失时对应行不渲染）。

## 9. 分层与文件清单

```
agent-sidecar/src/
  modelCost.ts            # 新增：Claude 成本档表 + tierFor（provider 专属，允许）
  modelCost.test.ts       # 新增
  types.ts                # 改：ModelOption 加 costTier；context_usage 加 raw_max_tokens
  index.ts                # 改：emitModelsAvailable 附 costTier；emitContextUsage 带 raw_max_tokens
src/
  components/SessionInfoPanel.vue   # 新增：药丸 + 弹层（独立模块）
  components/ChatPanel.vue          # 改：换用 SessionInfoPanel + onCompact
  components/panelayout/PaneGroup.vue # 改：透传 sessionCost
  composables/useChatSession.ts     # 改：sessionCostUsd 累加；contextUsage.rawMaxTokens；暴露 sessionCost
  composables/useChatSession.test.ts # 改：新增用例
  types/chat.ts                     # 改：ContextUsage/ModelOption/store 类型
```

状态层（useChatSession store）/ 事件层（IPC 契约）/ 样式层（SessionInfoPanel scoped + `--aide-*` 令牌）三层分离，符合 CLAUDE.md 代码质量要求。
