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

/* App.vue 的 .app-layout 为防止拖拽分栏/标签时误选界面文字，全局设了
 * user-select: none；该属性可继承，会一路传导到消息正文导致整段对话
 * 都无法选中复制。这里在消息容器局部恢复，子内容（代码块、工具调用块等）
 * 会随继承一并变回可选，不影响其余界面元素的防误选行为。 */
.msg-bubble,
.msg-turn {
  user-select: text;
  -webkit-user-select: text;
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
/* Tailwind preflight 把 ul/ol 的 list-style 统一清成 none，仅补 padding 会
   导致有序列表看不到 1./2./3. 编号、无序列表看不到圆点——这里显式复原标记。 */
.msg-text :deep(ul), .msg-text :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
  list-style-position: outside;
}
.msg-text :deep(ul) {
  list-style-type: disc;
}
.msg-text :deep(ol) {
  list-style-type: decimal;
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
