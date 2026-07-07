# 工具调用折叠组 + 墨线装帧视觉改版 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 连续工具调用默认折叠成一行墨线摘要，同时把对话区改版为「墨线装帧·通页」视觉（去 assistant 气泡、铜色书脊、节点圆点替代 emoji）。

**Architecture:** 纯渲染层改版，数据层/IPC/持久化零改动。新增纯函数 `blockSegments.ts`（blocks → 分段）和 `ToolCallGroup.vue`（墨线组），`ChatMessage.vue` 改为按分段渲染 + 通页书脊布局，`ToolCallBlock.vue` 从卡片改为墨线行。

**Tech Stack:** Vue 3 Composition API + TypeScript + scoped CSS（aide 自有 CSS 变量），vitest（node 环境，`@` → `src`）。

**设计依据:** `docs/superpowers/specs/2026-07-07-tool-group-inkline-design.md`（分组规则、视觉规格、YAGNI 边界均以 spec 为准）。

## Global Constraints

- 仅 assistant 消息分组；user 消息的 @mention tool_call 保持逐条渲染。
- 单条 tool_call 也成组（无阈值）；组内有失败只红字计数，**不**自动展开。
- 展开状态是组件内 `ref`，不持久化。
- 不改 `SubagentCallBlock.vue` 内部视觉、不改 `TurnUsageBadge.vue`（现状已符合）、不动数据层。
- 状态表达：完成 = 灰点（`--aide-surface-active`）、失败 = 红点（`--aide-danger`）、执行中 = 铜色呼吸点（`--aide-accent`）；不用 emoji ✅❌⏳。
- 箭头用 1.4px 描边 SVG chevron（`stroke-linecap="round"`），不用字符 ▲▼。
- 动画只用 opacity/box-shadow/transform，不触发布局。
- 提交信息末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: blockSegments 纯函数（分段 + 组统计）

**Files:**
- Create: `src/utils/blockSegments.ts`
- Test: `src/utils/blockSegments.test.ts`

**Interfaces:**
- Consumes: `ContentBlock` / `ToolCallBlock` 类型（`src/types/chat.ts`，已存在）。
- Produces（后续任务依赖的精确签名）:
  - `type Segment = { kind: "block"; block: ContentBlock; index: number } | { kind: "tool_group"; blocks: ToolCallBlock[]; index: number }`
  - `function segmentBlocks(blocks: ContentBlock[]): Segment[]`
  - `interface GroupStats { total: number; errorCount: number; kinds: { name: string; count: number }[] }`
  - `function groupStats(blocks: ToolCallBlock[]): GroupStats`（kinds 按 count 降序，稳定排序）

- [ ] **Step 1: 写失败测试**

创建 `src/utils/blockSegments.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { ContentBlock, ToolCallBlock } from "@/types/chat";
import { groupStats, segmentBlocks } from "./blockSegments";

let nextId = 0;
function tool(name: string, over: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return { type: "tool_call", id: `t${nextId++}`, name, input: {}, isPending: false, ...over };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });

describe("segmentBlocks", () => {
  it("空 blocks → 空段", () => {
    expect(segmentBlocks([])).toEqual([]);
  });

  it("连续 tool_call 聚成一组，index 是段首块在原数组的下标", () => {
    const blocks: ContentBlock[] = [text("a"), tool("Read"), tool("Glob"), text("b")];
    const segs = segmentBlocks(blocks);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: "block", index: 0 });
    expect(segs[1]).toMatchObject({ kind: "tool_group", index: 1 });
    expect((segs[1] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual(["Read", "Glob"]);
    expect(segs[2]).toMatchObject({ kind: "block", index: 3 });
  });

  it("单条 tool_call 也成组", () => {
    const segs = segmentBlocks([tool("Read")]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ kind: "tool_group", index: 0 });
  });

  it("被非工具块打断则开新组（text/subagent 都算打断）", () => {
    const subagent: ContentBlock = {
      type: "subagent", id: "s1", agentName: "Explore", description: "", entries: [], isPending: false,
    };
    const segs = segmentBlocks([tool("Read"), text("x"), tool("Grep"), subagent, tool("Glob"), tool("Glob")]);
    expect(segs.map((s) => s.kind)).toEqual(["tool_group", "block", "tool_group", "block", "tool_group"]);
    expect((segs[4] as { blocks: ToolCallBlock[] }).blocks).toHaveLength(2);
  });
});

describe("groupStats", () => {
  it("按次数降序统计种类，累计失败数", () => {
    const stats = groupStats([tool("Read"), tool("Glob"), tool("Read"), tool("Grep", { isError: true })]);
    expect(stats.total).toBe(4);
    expect(stats.errorCount).toBe(1);
    expect(stats.kinds).toEqual([
      { name: "Read", count: 2 },
      { name: "Glob", count: 1 },
      { name: "Grep", count: 1 },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/utils/blockSegments.test.ts`
Expected: FAIL（模块不存在 / 找不到导出）

- [ ] **Step 3: 实现**

创建 `src/utils/blockSegments.ts`：

```ts
import type { ContentBlock, ToolCallBlock } from "@/types/chat";

/**
 * 消息 blocks 的渲染分段：连续的 tool_call 聚成一个墨线组（ToolCallGroup），
 * 其余块原样透传。index 是段首块在原 blocks 里的下标——既当 v-for 的稳定 key，
 * 也让 ChatMessage 能继续用原始下标判定流式尾块（blockHtml 的缓存策略）。
 */
export type Segment =
  | { kind: "block"; block: ContentBlock; index: number }
  | { kind: "tool_group"; blocks: ToolCallBlock[]; index: number };

export function segmentBlocks(blocks: ContentBlock[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "tool_call") {
      const last = segments[segments.length - 1];
      if (last?.kind === "tool_group") {
        last.blocks.push(block);
      } else {
        segments.push({ kind: "tool_group", blocks: [block], index: i });
      }
    } else {
      segments.push({ kind: "block", block, index: i });
    }
  }
  return segments;
}

/** 工具组收起态摘要所需的统计：总数、失败数、按次数降序的种类分布。 */
export interface GroupStats {
  total: number;
  errorCount: number;
  kinds: { name: string; count: number }[];
}

export function groupStats(blocks: ToolCallBlock[]): GroupStats {
  const counts = new Map<string, number>();
  let errorCount = 0;
  for (const b of blocks) {
    counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
    if (b.isError) errorCount++;
  }
  const kinds = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { total: blocks.length, errorCount, kinds };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/utils/blockSegments.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/utils/blockSegments.ts src/utils/blockSegments.test.ts
git commit -m "feat(chat): blockSegments 纯函数——连续 tool_call 聚组 + 组统计"
```

---

### Task 2: ToolCallBlock 卡片 → 墨线行

**Files:**
- Modify: `src/components/ToolCallBlock.vue`（整文件替换，脚本逻辑除删掉 `statusIcon` 外不变）

**Interfaces:**
- Consumes: 现有 `parseEditInput` / `buildEditDiffLines`（`@/utils/editDiff`）、`summarizeToolInput`（`@/utils/toolSummary`）、`BashOutputBlock.vue`——均不改。
- Produces: props 签名不变 `defineProps<{ block: ToolCallBlock }>()`，Task 3/4 直接以 `<ToolCallBlock :block="b" />` 使用。类名 `ti-row` / `ti-dot` / `ti-name` / `ti-summary` 被 Task 4 的 user 气泡对比度覆盖引用——不要改名。

唯一使用点是 `ChatMessage.vue`（已确认），改版不影响其他组件。

- [ ] **Step 1: 整文件替换**

`src/components/ToolCallBlock.vue` 全文：

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import type { ToolCallBlock } from "@/types/chat";
import BashOutputBlock from "./BashOutputBlock.vue";
import { parseEditInput, buildEditDiffLines, type EditDiffStats } from "@/utils/editDiff";
import { summarizeToolInput } from "@/utils/toolSummary";

const props = defineProps<{ block: ToolCallBlock }>();
const expanded = ref(false);

const isBash = computed(() => props.block.name === "Bash");

/** Edit 工具且非错误时的 diff 数据；null 表示回退到普通结果文本展示。 */
const editDiff = computed<EditDiffStats | null>(() => {
  if (props.block.name !== "Edit" || props.block.isError) return null;
  const parsed = parseEditInput(props.block.input);
  if (!parsed) return null;
  return buildEditDiffLines(parsed);
});

const inputSummary = computed(() => summarizeToolInput(props.block.name, props.block.input));
</script>

<template>
  <div class="tool-item">
    <button class="ti-row" @click="expanded = !expanded">
      <span
        :class="['ti-dot', block.isPending ? 'ti-dot--run' : block.isError ? 'ti-dot--err' : '']"
      ></span>
      <span class="ti-name">{{ block.name }}</span>
      <span class="ti-summary">{{ inputSummary }}</span>
      <span v-if="editDiff" class="ti-diff">
        <span class="stat-add">+{{ editDiff.addCount }}</span>
        <span class="stat-del">-{{ editDiff.delCount }}</span>
      </span>
      <svg
        :class="['ti-chev', expanded ? 'ti-chev--open' : '']"
        width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"
      >
        <path
          d="M2 1.5l4 4.5-4 4.5"
          stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>
    </button>
    <div v-if="expanded" class="ti-body">
      <BashOutputBlock v-if="isBash && block.result" :content="block.result" :is-error="block.isError ?? false" />
      <pre v-else-if="editDiff" class="ti-result ti-diff-view"><span v-for="(line, i) in editDiff.lines" :key="i" :class="line.cls">{{ line.text }}</span></pre>
      <pre v-else-if="block.result" class="ti-result">{{ block.result }}</pre>
      <div v-else class="ti-pending">等待结果…</div>
    </div>
  </div>
</template>

<style scoped>
.tool-item {
  font-size: 11.5px;
}

.ti-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 4px 3px 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--aide-text-muted);
  border-radius: var(--aide-radius-sm);
  transition: color 0.12s;
}

.ti-row:hover {
  color: var(--aide-text-secondary);
}
.ti-row:hover .ti-name {
  color: var(--aide-text-primary);
}

/* 状态节点：完成灰点 / 失败红点 / 执行中铜色呼吸点（spec·图标语言） */
.ti-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aide-surface-active);
  flex-shrink: 0;
}
.ti-dot--err {
  background: var(--aide-danger);
}
.ti-dot--run {
  background: var(--aide-accent);
  animation: ti-pulse 1.2s ease-in-out infinite;
}
@keyframes ti-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.ti-name {
  font-weight: 600;
  color: var(--aide-text-secondary);
  flex-shrink: 0;
  min-width: 38px;
}

.ti-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
}

.ti-diff {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
}
.stat-add { color: var(--aide-success); }
.stat-del { color: var(--aide-danger); }

.ti-chev {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.12s;
}
.ti-chev--open {
  transform: rotate(90deg);
}

/* 展开区：铜色点线左标尺，正文渲染逻辑不变 */
.ti-body {
  margin: 2px 0 6px 2px;
  padding: 6px 8px 6px 11px;
  border-left: 1px dotted rgba(212, 165, 116, 0.25);
}

.ti-result {
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  color: var(--aide-text-secondary);
  margin: 0;
}
.ti-diff-view {
  white-space: pre;
}

.ti-pending {
  font-style: italic;
  color: var(--aide-text-muted);
}
</style>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 0 errors（此刻 ChatMessage 仍按旧方式引用 ToolCallBlock，props 未变所以不报错）

- [ ] **Step 3: Commit**

```bash
git add src/components/ToolCallBlock.vue
git commit -m "refactor(chat): ToolCallBlock 卡片改墨线行——节点圆点替代 emoji、SVG chevron"
```

---

### Task 3: ToolCallGroup 墨线组组件

**Files:**
- Create: `src/components/ToolCallGroup.vue`

**Interfaces:**
- Consumes: `segmentBlocks` 不用；用 `groupStats`（Task 1）、`summarizeToolInput`（`@/utils/toolSummary`，签名 `(name: string, input: unknown) => string`）、`ToolCallBlock.vue`（Task 2）。
- Produces: `defineProps<{ blocks: ToolCallBlockData[]; live?: boolean }>()`——Task 4 以 `<ToolCallGroup :blocks="seg.blocks" :live="isLiveGroup(seg)" />` 使用。`live` 含义：消息仍在流式生成且本组是最后一段。

- [ ] **Step 1: 创建组件**

`src/components/ToolCallGroup.vue` 全文：

```vue
<script setup lang="ts">
/**
 * 连续工具调用的墨线折叠组（spec·墨线装帧）：
 * 收起（默认）= 挂在铜色垂线上的一行摘要；live 态摘要实时显示正在执行的工具；
 * 展开 = 组内逐条 ToolCallBlock 墨线行。展开状态不持久化，随窗口化卸载重置。
 */
import { computed, ref } from "vue";
import type { ToolCallBlock as ToolCallBlockData } from "@/types/chat";
import ToolCallBlock from "./ToolCallBlock.vue";
import { groupStats } from "@/utils/blockSegments";
import { summarizeToolInput } from "@/utils/toolSummary";

const props = defineProps<{
  blocks: ToolCallBlockData[];
  /** 消息仍在流式生成且本组是最后一段——摘要行进入"正在执行"实时态 */
  live?: boolean;
}>();

const expanded = ref(false);

const stats = computed(() => groupStats(props.blocks));

/** 种类分布按次数降序取前 3，剩余归"…" */
const kindsLabel = computed(() => {
  const top = stats.value.kinds
    .slice(0, 3)
    .map((k) => `${k.name} ×${k.count}`)
    .join(" · ");
  return stats.value.kinds.length > 3 ? `${top} · …` : top;
});

/** 流式态下正在执行的那条（组尾的 pending 块）；null 表示按完成态渲染摘要 */
const running = computed(() => {
  if (!props.live) return null;
  const last = props.blocks[props.blocks.length - 1];
  return last?.isPending ? last : null;
});

const doneCount = computed(() => props.blocks.filter((b) => !b.isPending).length);

const runningSummary = computed(() =>
  running.value ? summarizeToolInput(running.value.name, running.value.input) : "",
);
</script>

<template>
  <div class="tool-group">
    <span :class="['tg-node', running ? 'tg-node--live' : '']"></span>
    <button class="tg-summary" @click="expanded = !expanded">
      <template v-if="running">
        正在执行 <span class="tg-name">{{ running.name }}</span>
        <span class="tg-kinds">{{ runningSummary }}</span>
        <template v-if="doneCount > 0"> · 已完成 {{ doneCount }}</template>
      </template>
      <template v-else>
        <span class="tg-n">{{ stats.total }}</span> 次工具调用
        <span class="tg-kinds">{{ kindsLabel }}</span>
        <span v-if="stats.errorCount > 0" class="tg-err"> · {{ stats.errorCount }} 失败</span>
      </template>
    </button>
    <div v-if="expanded" class="tg-items">
      <ToolCallBlock v-for="b in blocks" :key="b.id" :block="b" />
    </div>
  </div>
</template>

<style scoped>
/* 墨线：1px 铜色垂线 + 行首节点，替代原来的卡片盒子 */
.tool-group {
  position: relative;
  border-left: 1px solid rgba(212, 165, 116, 0.35);
  margin-left: 5px;
  padding: 2px 0 2px 14px;
}

.tg-node {
  position: absolute;
  left: -5px;
  top: 9px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--aide-bg-base);
  border: 1.5px solid var(--aide-accent);
}
.tg-node--live {
  background: var(--aide-accent);
  animation: tg-pulse 1.2s ease-in-out infinite;
}
@keyframes tg-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(212, 165, 116, 0.5); }
  50% { opacity: 0.55; box-shadow: 0 0 0 4px rgba(212, 165, 116, 0); }
}

.tg-summary {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  padding: 3px 0;
  transition: color 0.12s;
}
.tg-summary:hover {
  color: var(--aide-text-primary);
}

.tg-n,
.tg-name {
  color: var(--aide-accent);
  font-weight: 600;
}
.tg-name,
.tg-kinds {
  font-family: 'Cascadia Code', 'Consolas', monospace;
}
.tg-kinds {
  color: var(--aide-text-muted);
  margin-left: 8px;
  overflow-wrap: anywhere;
}
.tg-err {
  color: var(--aide-danger);
}

.tg-items {
  display: flex;
  flex-direction: column;
}
</style>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 0 errors（组件尚未被引用，但单文件要能编译过）

- [ ] **Step 3: Commit**

```bash
git add src/components/ToolCallGroup.vue
git commit -m "feat(chat): ToolCallGroup 墨线折叠组——默认收起 + live 态实时摘要"
```

---

### Task 4: ChatMessage 接入分段 + 通页书脊布局

**Files:**
- Modify: `src/components/ChatMessage.vue`（整文件替换）

**Interfaces:**
- Consumes: `segmentBlocks` / `Segment`（Task 1）、`ToolCallGroup.vue`（Task 3，props `{ blocks, live? }`）、`ToolCallBlock.vue`（Task 2，类名 `ti-row`/`ti-dot`/`ti-name`/`ti-summary`）。
- Produces: 对外 props 不变 `{ message: ChatMessage; workspacePath?: string }`——ChatPanel 无需改动。

要点：
1. v-for 从裸 blocks 换成 segments；user 消息逐块透传（不分组），assistant 走 `segmentBlocks`。
2. assistant 去气泡：`.msg-bubble--assistant` 删除，换 `.msg-turn` 通页书脊（2px 铜线 + 18px 左距）。
3. `blockHtml` 的流式尾块判定继续用**原始下标**（`seg.index`），缓存策略不变。
4. user 气泡内的 mention 墨线行做对比度覆盖（深色字上铜底）。

- [ ] **Step 1: 整文件替换**

`src/components/ChatMessage.vue` 全文：

```vue
<script setup lang="ts">
import { computed } from "vue";
import type { ChatMessage } from "@/types/chat";
import { marked, renderMarkdown } from "@/utils/markdown";
import ToolCallBlock from "./ToolCallBlock.vue";
import ToolCallGroup from "./ToolCallGroup.vue";
import SubagentCallBlock from "./SubagentCallBlock.vue";
import TurnUsageBadge from "./TurnUsageBadge.vue";
import { segmentBlocks, type Segment } from "@/utils/blockSegments";
import { useFileResolver } from "@/composables/useFileResolver";
import { parseFileLink } from "@/utils/fileLink";

const props = defineProps<{
  message: ChatMessage;
  workspacePath?: string;
}>();

const isUser = computed(() => props.message.role === "user");
const { openResolved } = useFileResolver();

/** user 消息不分组（@mention 的 tool_call 是附件展示，保持逐条）；
 *  assistant 消息连续 tool_call 聚成墨线组（spec·分组行为）。 */
const segments = computed<Segment[]>(() =>
  isUser.value
    ? props.message.blocks.map((block, index) => ({ kind: "block" as const, block, index }))
    : segmentBlocks(props.message.blocks),
);

/** 组是否"活着"：消息还在流式生成，且该组是最后一段（新工具块会继续追加进组）。 */
function isLiveGroup(seg: Segment): boolean {
  if (seg.kind !== "tool_group" || !props.message.streaming) return false;
  return seg.index + seg.blocks.length === props.message.blocks.length;
}

// 只响应渲染期已判定为文件的 code（见 utils/markdown.ts codespan 渲染器 +
// utils/fileLink.ts 判定规则），点击层不再自己做路径识别。openResolved 会先探测
// 路径是否存在，不存在时在工作区内搜索（带加载态，多命中弹选择框）。
/** 文本块 → HTML：已定稿的块走 renderMarkdown 缓存（重渲染零解析成本）；
 *  流式中的最后一块每个增量都在变，进缓存只会塞满垃圾键——直接解析。
 *  index 是块在原 blocks 里的下标（Segment.index），分段化后判定依据不变。 */
function blockHtml(text: string, index: number): string {
  const streamingTail =
    !!props.message.streaming && index === props.message.blocks.length - 1;
  return streamingTail ? (marked.parse(text) as string) : renderMarkdown(text);
}

function handleTextClick(e: MouseEvent) {
  const codeEl = (e.target as HTMLElement).closest("code.aide-file-link");
  if (!codeEl) return;
  const link = parseFileLink(codeEl.textContent?.trim() ?? "");
  if (!link) return;
  void openResolved(link.path, props.workspacePath, link.line);
}
</script>

<template>
  <div :class="['msg-row', isUser ? 'msg-row--user' : 'msg-row--assistant']">
    <div :class="isUser ? 'msg-bubble msg-bubble--user' : 'msg-turn'">
      <template v-for="seg in segments" :key="seg.index">
        <ToolCallGroup
          v-if="seg.kind === 'tool_group'"
          :blocks="seg.blocks"
          :live="isLiveGroup(seg)"
        />
        <div
          v-else-if="seg.block.type === 'text'"
          class="msg-text"
          v-html="blockHtml(seg.block.text, seg.index)"
          @click="handleTextClick"
        />
        <ToolCallBlock
          v-else-if="seg.block.type === 'tool_call'"
          :block="(seg.block as any)"
        />
        <img
          v-else-if="seg.block.type === 'image'"
          :src="`data:${(seg.block as any).mediaType};base64,${(seg.block as any).data}`"
          class="msg-image"
          alt="附图"
        />
        <SubagentCallBlock
          v-else-if="seg.block.type === 'subagent'"
          :block="(seg.block as any)"
        />
      </template>
      <TurnUsageBadge v-if="!isUser && message.usage" class="msg-usage" :usage="message.usage" />
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  padding: 4px 12px;
}

.msg-row--user {
  justify-content: flex-end;
}

.msg-row--assistant {
  justify-content: flex-start;
}

.msg-bubble {
  max-width: 85%;
  border-radius: var(--aide-radius-md);
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.msg-bubble--user {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}

/* 通页书脊（spec·B2）：assistant 正文直接落在页面上，
 * 一条铜色书脊纵贯整个回合（正文 + 工具墨线 + 用量）。 */
.msg-turn {
  max-width: 94%;
  min-width: 0;
  border-left: 2px solid rgba(212, 165, 116, 0.45);
  padding: 2px 0 2px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--aide-text-primary);
  word-break: break-word;
}

/* user 铜底气泡里的 mention 墨线行：默认 muted 色在铜底上对比度不够，压成深色 */
.msg-bubble--user :deep(.ti-row),
.msg-bubble--user :deep(.ti-name),
.msg-bubble--user :deep(.ti-summary) {
  color: var(--aide-text-on-accent);
}
.msg-bubble--user :deep(.ti-dot) {
  background: var(--aide-text-on-accent);
}

.msg-text :deep(p) {
  margin: 0 0 8px;
}
.msg-text :deep(p:last-child) {
  margin-bottom: 0;
}
.msg-text :deep(code) {
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  background: var(--aide-bg-deep);
  padding: 1px 5px;
  border-radius: 3px;
}
/* 只有渲染期判定为文件路径的 code 才呈现可点击态 */
.msg-text :deep(code.aide-file-link) {
  cursor: pointer;
  color: var(--aide-accent);
  transition: background 0.12s, color 0.12s;
}
.msg-text :deep(code.aide-file-link:hover) {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}
.msg-text :deep(pre) {
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 10px 12px;
  overflow-x: auto;
  margin: 6px 0;
}
.msg-text :deep(pre code) {
  background: none;
  padding: 0;
}
.msg-text :deep(ul), .msg-text :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}
.msg-text :deep(li) {
  margin: 2px 0;
}
.msg-text :deep(h1), .msg-text :deep(h2), .msg-text :deep(h3) {
  margin: 8px 0 4px;
  font-weight: 600;
}
.msg-text :deep(blockquote) {
  border-left: 3px solid var(--aide-accent);
  margin: 6px 0;
  padding-left: 10px;
  color: var(--aide-text-secondary);
}
.msg-text :deep(a) {
  color: var(--aide-accent);
  text-decoration: none;
}
.msg-text :deep(a:hover) {
  text-decoration: underline;
}
.msg-text :deep(hr) {
  border: none;
  border-top: 1px solid var(--aide-border);
  margin: 8px 0;
}

.msg-usage {
  margin-top: 4px;
  font-size: 11px;
  color: var(--aide-text-secondary);
}

.msg-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: var(--aide-radius-sm);
  display: block;
  margin: 4px 0;
  cursor: pointer;
}
</style>
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `pnpm exec vue-tsc --noEmit && pnpm test`
Expected: 0 type errors；vitest 全绿（既有测试不涉及渲染层，应无回归）

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatMessage.vue
git commit -m "feat(chat): 墨线装帧通页布局——assistant 去气泡 + 连续工具调用折叠成组"
```

---

### Task 5: 文档更新 + 端到端验证

**Files:**
- Modify: `CLAUDE.md`（项目结构树三行）
- Modify: `docs/ARCHITECTURE.md`（若其中描述了 ToolCallBlock 卡片形态——先 grep 再改，无提及则跳过）

**Interfaces:**
- Consumes: Task 1-4 全部落地。
- Produces: 文档与实现一致；手动验证清单结论。

- [ ] **Step 1: 更新 CLAUDE.md 项目结构**

把：

```
│   │   ├── ChatMessage.vue     # 单条消息渲染（Markdown + 工具卡片 + 图片 + 路径点击跳转）
│   │   ├── ToolCallBlock.vue   # 工具调用卡片（可折叠）/ BashOutputBlock.vue（xterm 只读输出）
```

改为：

```
│   │   ├── ChatMessage.vue     # 单条消息渲染（通页书脊布局 + Markdown + 墨线工具组 + 图片 + 路径点击跳转）
│   │   ├── ToolCallGroup.vue   # 连续工具调用的墨线折叠组（默认收起 + 流式实时摘要）
│   │   ├── ToolCallBlock.vue   # 单条工具调用墨线行（可展开）/ BashOutputBlock.vue（xterm 只读输出）
```

并在 utils 区块 `highlight.ts` 之前加一行：

```
│   │   ├── blockSegments.ts    # 消息 blocks → 渲染分段（连续 tool_call 聚组）纯函数
```

- [ ] **Step 2: 检查 ARCHITECTURE.md**

Run: `grep -n "ToolCallBlock\|工具卡片\|气泡" docs/ARCHITECTURE.md`
若有对旧卡片/气泡形态的描述，同步改为墨线组表述；无则跳过。

- [ ] **Step 3: 启动应用做手动验证（spec·五）**

Run: `pnpm tauri dev`（或 `./dev.ps1`），逐项核对：

1. 历史会话回放：连续工具调用显示为一行收起摘要，种类统计降序、失败红字计数。
2. 新发消息流式中：摘要行实时显示「正在执行 X · 已完成 N」，节点呼吸闪烁，无布局跳动。
3. 流式期间点开组：新工具块实时追加进展开列表，不自动收回。
4. 展开单条工具行：Bash 走 xterm 输出、Edit 走 diff、其余走 pre，均正常。
5. assistant 通页书脊布局正常；user 消息（含 @mention 附件行）在铜底上对比度可读。
6. 上滚加载旧消息（useMessageWindow 扩窗）：新挂载的组默认收起。
7. 含子代理的回合：SubagentCallBlock 在通页书脊布局下不破版（spec 明确本期不重做其内部视觉，只保布局兼容）。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/ARCHITECTURE.md
git commit -m "docs: 项目结构同步墨线装帧改版（ToolCallGroup/blockSegments）"
```
