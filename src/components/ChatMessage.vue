<script setup lang="ts">
import { computed } from "vue";
import type { ChatMessage, ModelOption } from "@/types/chat";
import { renderStreaming, renderMarkdown } from "@/utils/markdown";
import ToolCallBlock from "./ToolCallBlock.vue";
import ToolCallGroup from "./ToolCallGroup.vue";
import SubagentCallBlock from "./SubagentCallBlock.vue";
import TurnUsageBadge from "./TurnUsageBadge.vue";
import { segmentBlocks, type Segment } from "@/utils/blockSegments";
import { useFileResolver } from "@/composables/useFileResolver";
import { parseFileLink } from "@/utils/fileLink";
import { isModelInList } from "@/utils/modelSelect";

const props = defineProps<{
  message: ChatMessage;
  workspacePath?: string;
  /** 当前会话的可选模型列表——模型徽标的别名建议要在列表里才采用，
   *  否则回退 wire 原文（第三方 sidecar 会建议出 Claude 别名，不在真实
   *  id 列表里，采信会显示用户不认识的值）。 */
  models?: ModelOption[];
}>();

const isUser = computed(() => props.message.role === "user");

/** 模型徽标文案：sidecar 的别名建议在列采信（系统默认 → "sonnet"），
 *  否则用 wire 原文（第三方真实 id，如 kimi-for-coding-highspeed）——
 *  无论如何显示的都是 API 落盘标识，不是模型自报身份。 */
const modelBadge = computed(() => {
  const m = props.message;
  if (isUser.value || !m.model) return "";
  const label = m.modelLabel ?? m.model;
  return isModelInList(props.models ?? [], label) ? label : m.model;
});
/** 整条用户消息只有一个 ActionBlock 时，不套铜底气泡——胶囊自身带边框/底色，
 *  套在 accent 实心底上会糊成一团。直接作为右对齐的胶囊落在消息行里。 */
const isActionChip = computed(
  () =>
    isUser.value &&
    props.message.blocks.length === 1 &&
    props.message.blocks[0].type === "action",
);
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
/** 文本块 → HTML：已定稿的块走 renderMarkdown 缓存（重渲染零解析成本，含语法
 *  高亮）；流式中的最后一块每个增量都在变，走 renderStreaming——结构照常实时
 *  渲染，唯独代码围栏不跑 hljs（每个增量重高亮成长中的大围栏是 O(n²) 卡死放大器，
 *  见 utils/markdown.ts）。块定稿后自然切回 renderMarkdown 补上高亮。
 *  index 是块在原 blocks 里的下标（Segment.index），分段化后判定依据不变。 */
function blockHtml(text: string, index: number): string {
  const streamingTail =
    !!props.message.streaming && index === props.message.blocks.length - 1;
  return streamingTail ? renderStreaming(text) : renderMarkdown(text);
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
    <div :class="isActionChip ? 'msg-action-wrap' : (isUser ? 'msg-bubble msg-bubble--user' : 'msg-turn')">
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
        <!-- btw 页边批注：可折叠、视觉权重远低于真实消息，读起来是"贴在边上的便签" -->
        <div
          v-else-if="seg.block.type === 'action' && seg.block.actionId === 'btw'"
          class="msg-row--note"
        >
          <details class="btw-note">
            <summary class="btw-note-head">
              <span class="btw-note-caret tri"></span>
              <span class="btw-note-glyph tri">↳</span>
              <span class="btw-note-tag">btw</span>
              <span class="btw-note-q">{{ seg.block.label }}</span>
            </summary>
            <div class="btw-note-body">
              <div>{{ seg.block.body }}</div>
              <div class="btw-note-warn">↳ 这是支线结论,不会进入主对话上下文。</div>
            </div>
          </details>
        </div>
        <!-- 原 action 药丸(压缩/清空上下文) -->
        <span
          v-else-if="seg.block.type === 'action'"
          class="msg-action-chip"
        >
          <span v-if="seg.block.icon" class="msg-action-chip-icon">{{ seg.block.icon }}</span>
          <span class="msg-action-chip-label">{{ seg.block.label }}</span>
        </span>
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
      <div v-if="!isUser && (modelBadge || message.usage)" class="msg-meta">
        <span
          v-if="modelBadge"
          class="msg-model"
          v-tooltip="'本条回答实际使用的模型（API 落盘标识）——问模型「你是什么模型」得到的自报身份不可靠，以这里为准'"
        >{{ modelBadge }}</span>
        <TurnUsageBadge v-if="message.usage" class="msg-usage" :usage="message.usage" />
      </div>
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

/* 用户气泡：GALLERY「聊天碎片」——渐变浮起表面 + 顶光内描边 + 不对称左下圆角 */
.msg-bubble--user {
  background: linear-gradient(180deg, var(--aide-surface-default), var(--aide-bg-raised));
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-lg) var(--aide-radius-lg) var(--aide-radius-lg) 5px;
  color: var(--aide-text-primary);
  box-shadow: var(--aide-shadow-sm), var(--aide-highlight-inset);
}

/* 动作胶囊（压缩/清空上下文等）：区别于普通用户气泡——半透明 accent 底 + accent
 * 描边 + accent 文字，圆角药丸。底色由 accent token 派生（color-mix），不硬编码 hex。 */
.msg-action-wrap {
  display: inline-flex;
  max-width: 85%;
}

.msg-action-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 15%, transparent);
  color: var(--aide-accent);
  font-size: 13px;
  line-height: 1.6;
  user-select: text;
  -webkit-user-select: text;
}

.msg-action-chip-icon {
  font-size: 12px;
  opacity: 0.9;
}

.msg-action-chip-label {
  white-space: nowrap;
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
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
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

.msg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

/* 模型徽标：GALLERY badge accent 调 */
.msg-model {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 28%, transparent);
  border-radius: var(--aide-radius-sm);
  padding: 2.5px 9px;
  white-space: nowrap;
}

.msg-meta .msg-usage {
  margin-top: 0;
}

/* 用量行：GALLERY 要求 tabular-nums */
.msg-usage {
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}

.msg-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: var(--aide-radius-sm);
  display: block;
  margin: 4px 0;
  cursor: pointer;
}

/* btw 页边批注：右对齐、虚线 accent 边、默认折叠 */
.msg-row--note { display: flex; justify-content: flex-end; padding: 2px 12px; }
.btw-note {
  max-width: 70%; border: 1px dashed var(--aide-accent); border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--aide-accent) 6%, transparent); overflow: hidden;
}
.btw-note-head {
  display: flex; align-items: center; gap: 7px; padding: 5px 11px; cursor: pointer;
  list-style: none; font-size: 12px; color: var(--aide-accent);
}
.btw-note-head::-webkit-details-marker { display: none; }
.btw-note-caret {
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid var(--aide-accent); opacity: 0.7; transition: transform var(--aide-ease-t);
}
.btw-note[open] .btw-note-caret { transform: rotate(90deg); }
.btw-note-glyph { color: var(--aide-accent); }
.btw-note-tag {
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em; padding: 1px 6px;
  border-radius: 999px; border: 1px solid var(--aide-accent); color: var(--aide-accent);
}
.btw-note-q { color: var(--aide-text-secondary); font-size: 12px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btw-note-body { padding: 2px 12px 9px; font-size: 12px; line-height: 1.6; color: var(--aide-text-secondary); border-top: 1px dashed var(--aide-border); }
.btw-note-warn { font-size: 11px; color: var(--aide-text-muted); margin-top: 7px; }
</style>
