# 主线程思考流式渲染 设计

- 日期：2026-08-07
- 状态：设计已评审，待写实施计划
- 作者：Heaven + Claude（brainstorming）

## 1. 背景与目标

2026-08-06 的 `feat(chat): 主线程展示模型思考内容`（commit `256f8c2`）让主线程思考可见，但渲染是**结束后一次性蹦出**：sidecar 把 assistant 消息 content 里的 thinking block 整块 `emit({ type: "thinking", text })`，前端 `ThinkingBlock` 一次渲染全文。用户发消息后等很久（模型在思考+生成），思考+文本+工具调用一起蹦出，思考的生成过程不可见。

目标是让**主线程思考逐字流式**——像看模型实时生成一样，思考内容随 token 到达逐字出现，而非结束后一次性渲染。

### 历史坑（决定方案走向的约束）

`includePartialMessages`（SDK 控制是否逐字发 `stream_event` 增量的全局开关）在项目历史上反复变动：

| commit | 日期 | 动作 |
|---|---|---|
| `2782285` | 2026-07-03 | `feat(sidecar): 真流式输出` — `includePartialMessages: true`，mapper 转发 `stream_event` 的 `text_delta`、跳过完整 assistant 整块文本去重 |
| `e15bb45` | 2026-07-06 | `流式增量合并层` — 引入 `deltaCoalescer`（第一次卡死修复） |
| `1a64c8e` | 2026-07-08 | `feat(sidecar): 关闭实时流式(includePartialMessages false),降主线程卡死` — **明确关 partial 止血** |
| `89ee33d` | 2026-07-19 | Agent Runtime 重构，partial 保持 false 至今 |

`1a64c8e` 的 commit message 原话"降主线程卡死"——开 partial 真流式直接导致主线程卡死 30s+，根因是事件洪峰 × 前端每增量重复成本：`ChatMessage.vue` 每个 delta `marked.parse(block.text)` 全文重解析 O(n²)、`ChatPanel` 每 delta 读 `scrollHeight` 强制布局、hljs 对成长中的大代码围栏整体重高亮 O(n²)（见记忆 [[aide-streaming-freeze-fix]] / [[aide-freeze-diagnostics]]）。四层修复（deltaCoalescer / renderMarkdown 缓存 / rAF 滚动 / 同步命令 async 化）后仍连环复发，最终关 partial 止血。

**mapper.ts 注释的矛盾**（463 行"query 开了 includePartialMessages" vs 489 行"index.ts 现在不开 partial"）正是这段反复变动的化石。本次清理。

### 关键观察（为什么本次可安全重开 partial）

当年卡死的 O(n²) 全在 **text 渲染路径**（marked.parse + hljs）。本次只让 **thinking** 流式——thinking 是纯文本插值 `{{ text }}`（`ThinkingBlock.vue`、子代理 `SubagentCallBlock.vue` 的 `.sa-thinking`），**不走 markdown/hljs**，不沾历史卡死主因。只要把 thinking 逐字增量纳入 `deltaCoalescer` 合并、details 展开时 body 受现有 `max-height:320px + overflow:auto` 限高，reflow 限定在视窗内，成本可控。

## 2. 已定的关键决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 流式类型 | **B 真流式（只 thinking）**：开 `includePartialMessages`，但 mapper 只放 `thinking_delta`，text 仍走完整 message 整块 | 思考逐字 = 看真实生成；text 整块 = 不重踩当年 text 流式卡死坑；thinking 纯文本绕开所有历史 O(n²) 陷阱 |
| 不选 A（全开 partial） | 排除 | 直接逆向止血 commit `1a64c8e`，text 重新逐字 = 重踩 marked.parse + emit 编组卡死 |
| 不选 C（假流式打字机） | 排除 | 不是真实生成速度；长思考（实测上万字）匀速吐很久 |
| thinking 增量事件类型 | **新增 `thinking_delta`**（带 text 增量），与 `subagent_thinking_delta` 对称 | 语义无歧义（明确增量）；保留 `thinking` 整块事件给 partial=off / 历史回放；deltaCoalescer 注册 `thinking_delta` |
| 子代理隔离 | **选项 Z**：`emitSubagentProgress` stream_event 分支 `partialMode` 守卫丢弃，子代理走 `emitSubagentBlocks` 整块不变 | `includePartialMessages` 是全局开关，开了会连带让子代理 text/thinking 逐字；丢弃子代理逐字 delta，子代理仍走整块 = 与现状一致 |
| btw / titleGenerator | 保持 `partial=off` | btw 轻量支线不需要思考流式；titleGenerator 独立 query 不展示。`startLoop` 用 `!this.btwMode` 区分 |
| 去重依据 | partial=on 时 SDK 必先发 `stream_event` thinking_delta 逐字、再发完整 assistant message；mapper assistant 分支 `partialMode=true` 跳过 thinking 整块 | SDK 时序保证；空 thinking（display=omitted）两边都不发，不丢 |
| details 流式期展开 | 流式期默认展开、结束自动折叠、用户手动点过则接管（`userOverride` 标志） | 让用户看到逐字生成；结束回到默认折叠（与非流式一致）；用户意愿优先 |
| 多 thinking block | 不专门处理（YAGNI） | 一个 turn 内思考被工具打断后又思考（罕见），多个 block 的 delta 追加合并成一个 block——与现状（partial=off 多整块也合并）一致，不退化 |

## 3. 复用的现有基础设施

| 设施 | 出处 | 复用点 |
|---|---|---|
| `deltaCoalescer` 增量合并 | `agent-sidecar/src/deltaCoalescer.ts` | `COALESCABLE_TYPES` 加 `thinking_delta`，40ms 窗口按 key 合并，防思考逐字事件洪峰直冲前端 |
| 子代理逐字管道 | `emitSubagentProgress` stream_event 分支 `mapper.ts:321-331` | 对照主线程 thinking_delta 转发；本次反方向——`partialMode` 守卫丢弃子代理逐字，走整块隔离 |
| 前端追加语义 | `useChatSession.ts:501-512` `case "thinking"` | 已是 `last.text += e["text"]`，天然支持增量；`thinking_delta` fallthrough 合并 |
| `streamingTail` 判定 | `ChatMessage.vue:86-90` `blockHtml` | 复用"最后一块 + message.streaming"，传给 `ThinkingBlock` 的 `streaming` prop |
| details 折叠 + 限高 | `ThinkingBlock.vue` `details` + `.thinking-body` `max-height:320px` | 流式期展开时限高 reflow，成本可控 |
| rAF 滚动节流 | `ChatPanel.vue` `scrollToBottom` | text 流式已在用，思考增高不另开逻辑 |
| 黑匣子冻结诊断 | `src-tauri/src/diagnostics/` + `freeze-*.json` | 回归护栏：卡死时 `event_rates` 桶 `maxBytesType=thinking_delta` 指认思考洪峰；`ring.trace` 尾部指触发点 |
| 历史回放 | `useChatSession.ts:973-977` `historyBlockToContentBlocks` thinking 分支 | Rust `parse_transcript_lines` 重建整块 → 前端整块 case，不动 |

## 4. 引入的依赖

无。纯协议事件 + 现有管道扩展。

## 5. 架构

### 5.1 目标态数据流（主会话一个 turn，partial=on）

```
SDK (includePartialMessages: true)
 ├─ stream_event: thinking_delta ×N  ──► mapper 转发 ──► thinking_delta 事件 ──► deltaCoalescer 合并 ──► 前端追加 (流式)
 ├─ stream_event: text_delta ×N      ──► mapper 丢弃 (text 不流式)
 ├─ stream_event: tool_use 等        ──► 不在 delta 分支（走完整 message）
 └─ 完整 assistant message
     ├─ thinking block  ──► mapper 跳过 (已被 stream_event 逐字发过，去重)
     ├─ text block      ──► mapper emit 整块 text_delta (现状不变)
     └─ tool_use block  ──► mapper emit (现状不变)

子代理消息 (parent_tool_use_id 非空)
 └─ stream_event: 子代理 text/thinking delta  ──► emitSubagentProgress 丢弃 (partialMode 守卫)
 └─ 完整子代理 message  ──► emitSubagentBlocks 整块发 subagent_text_delta / subagent_thinking_delta (与现状一致)
```

### 5.2 协议层

**`agent-sidecar/src/types.ts`** ChatEvent 联合新增，紧贴现有 `thinking` 整块事件：

```ts
// 主线程 thinking 逐字增量——partial=on 下 stream_event 的 thinking_delta 转发。
// 与 thinking 整块互补：partial=on 走这条（流式），partial=off / 历史回放走 thinking 整块。
// 与 subagent_thinking_delta 对称，不带 id（主线程一轮只有一个思考增量流）。
| { type: "thinking_delta"; text: string }
```

保留 `{ type: "thinking"; text: string }` 整块事件不动。前端 `src/types/chat.ts` 的 `ThinkingBlock` 类型不变（前端把 `thinking_delta` 追加到现有 `ThinkingBlock.text`）。

### 5.3 sidecar 改动

**`agent-sidecar/src/deltaCoalescer.ts`**

`COALESCABLE_TYPES` 加 `"thinking_delta"`。`keyOf` 沿用 `type:id`，主线程 `thinking_delta` 无 id → key `"thinking_delta:"`，一轮一个增量流，40ms 合并。

**`agent-sidecar/src/mapper.ts`**

`mapSdkMessage` 新增参数 `partialMode: boolean`（SessionWorker 注入）：

- **`stream_event` 分支**（当前只转发 `text_delta`，mapper.ts:465-471）：
  - `partialMode=true`：改为转发 `thinking_delta`（`emit({ type: "thinking_delta", text: ev.delta.thinking })`），**不再转发 `text_delta`**
  - `partialMode=false`：分支不触发（SDK 不发 stream_event），现状不变
- **`assistant` 分支**（mapper.ts:485-517 遍历 content blocks）：
  - `partialMode=true` 时：`thinking` block 整块**跳过**；`text` block 整块照发；`tool_use` 照发
  - `partialMode=false` 时：`thinking` block 整块照发（现状）
- **`emitSubagentProgress`**（mapper.ts:316-346）加 `partialMode` 参数，stream_event 分支首行 `if (partialMode) return;`——丢弃子代理逐字 delta，子代理走 `emitSubagentBlocks` 整块（与现状一致）
- **`emitSubagentBlocks` 不动**（text+thinking 整块照发；`.output` 回放路径 `parseOutputLine` 不涉及 stream_event，天然不受影响）
- `mapSdkMessage` 调 `emitSubagentProgress` 透传 `partialMode`

清理 mapper.ts 注释矛盾：统一描述 partial=on/off 与 thinking 流式关系，删除 463 行"开了 partial"、489 行"不开 partial" 的过时表述。

**`agent-sidecar/src/session-worker.ts`**

- `startLoop` query options：`includePartialMessages: false` → `!this.btwMode`（主会话开，btw 关）
- `mapSdkMessage` 调用注入 `partialMode: !this.btwMode`
- `titleGenerator.ts` 不走 startLoop、独立 queryFn，保持 `partial=false`，不受影响

### 5.4 前端改动

**`src/composables/useChatSession.ts`** `handleChatEvent` 的 `case "thinking"` fallthrough 合并 `thinking_delta`：

```ts
case "thinking":
case "thinking_delta": {
  // partial-on 走 thinking_delta 逐字增量，partial-off / 历史回放走 thinking 整块；
  // 前端都是"追加到末尾同类型 block，否则新建"，行为一致。
  const msg = getOrCreateAssistant(store);
  const last = msg.blocks[msg.blocks.length - 1];
  if (last?.type === "thinking") {
    (last as ThinkingBlock).text += e["text"] as string;
  } else {
    msg.blocks.push({ type: "thinking", text: e["text"] as string });
  }
  break;
}
```

注释从"整块（partial-off）"更新为"增量 + 整块两路"。`historyBlockToContentBlocks` 历史 thinking 整块分支不动。

**`src/components/ThinkingBlock.vue`** 加 `streaming?: boolean` prop，details open 逻辑：

```ts
const props = defineProps<{ text: string; streaming?: boolean }>();
const userOverride = ref(false);
const userOpen = ref(false);
const open = computed(() => (userOverride.value ? userOpen.value : !!props.streaming));
function onToggle(e: Event) {
  userOverride.value = true;
  userOpen.value = (e.target as HTMLDetailsElement).open;
}
```
```html
<details class="thinking" :open="open" @toggle="onToggle">
```

行为：流式期（`streaming=true`，用户没动过）→ 展开；结束 `streaming` 翻 false → 自动折叠；用户手动点一次 → `userOverride=true` 接管。

**`src/components/ChatMessage.vue`** 抽 `isStreamingTail(seg)` 共用判定，`blockHtml` 与 `ThinkingBlock` 共用，避免 `segments.length`（分段后含 tool_group 聚合）与 `blocks.length`（原 block 数）混淆埋 bug：

```ts
/** 该 block 是否是消息最后一块且消息还在流式——流式尾块判定。
 *  seg.index 是原 blocks 下标（segmentBlocks 保留），不是 segments 下标。 */
function isStreamingTail(seg: Segment): boolean {
  return !!props.message.streaming && seg.index === props.message.blocks.length - 1;
}
```

`blockHtml` 原内联判定改调它；`ThinkingBlock` 传 `:streaming="isStreamingTail(seg)"`：

```html
<ThinkingBlock
  v-else-if="seg.block.type === 'thinking'"
  :text="seg.block.text"
  :streaming="isStreamingTail(seg)"
/>
```

（思考块是原 blocks 最后一块且消息还在流式时才判定思考流式中。思考流式中 text 还没到——`text_delta` stream_event 被 mapper 丢弃，text 只在完整 message 到达时整块 emit，所以思考逐字期间 thinking 块就是最后一块；text 整块到达瞬间 thinking 变非尾块、`streaming` 翻 false 自动折叠。）

**滚动 / 中断不改**：沿用 `ChatPanel.vue` rAF `scrollToBottom`；中断时 `thinking_delta` 发到一半，前端留半截 `ThinkingBlock`，`message.streaming` 翻 false → details 自动折叠，半截思考保留反映"被打断"。

## 6. 测试

- **`agent-sidecar/src/mapper.test.ts`**：
  - `partialMode=true`：stream_event `thinking_delta` → 转发 `thinking_delta` 事件；stream_event `text_delta` → 不转发；assistant `thinking` block 跳过；assistant `text` block 整块照发；子代理 stream_event 丢弃走整块
  - `partialMode=false`：现状不变（assistant 整块发 text+thinking，stream_event 分支不触发）
  - 空 thinking（display=omitted）两边都不发
  - 现有 `mapSdkMessage streaming (includePartialMessages)` 测试组更新——之前测 `text_delta` 转发，新语义下 `text_delta` 不转发
- **`agent-sidecar/src/deltaCoalescer.test.ts`**：`thinking_delta` 按 key 合并
- **`src/composables/useChatSession.test.ts`**：`thinking_delta` 追加到现有 ThinkingBlock

## 7. 卡死回归护栏

这是踩过坑的项目，重点护栏：

- **重建**：sidecar 改源码必须重建 `dist/runtime.js` + 重启 app 才生效（记忆 [[sidecar-dev-rebuild-restart]]）
- **验证场景**：长思考（上万字）逐字流式时——任务管理器看 `msedgewebview2.exe` vs `aide.exe` 谁满载；thinking 纯文本不沾 markdown/hljs，但 details 展开时 body reflow 需确认 320px 限高下可控
- **黑匣子**：`freeze-*.json` 的 `event_rates` 桶（schema v2）若 `maxBytesType=thinking_delta` 且字节大 = 思考洪峰；卡死时 `ring.trace` 尾部指触发点
- **回归基线**：同体量思考，partial=on 流式 vs partial=off 整块，前端响应不退化、无新 `freeze-*.json`

## 8. 不做的事（YAGNI）

- **缓冲**：用户曾问"逐字生成能加个缓冲吗"后撤回，本次不加。如未来需要，缓冲可加在前端（ThinkingBlock 对 text 节流显示）或 sidecar（deltaCoalescer 已是 40ms 缓冲，可调窗口）
- **多 thinking block 专门处理**：罕见场景，追加合并与现状一致不退化
- **子代理思考流式**：本次子代理走整块不变；未来若要子代理也流式，再开 `emitSubagentProgress` stream_event 转发
- **btw 思考流式**：btw 保持 partial=off，轻量支线不需要