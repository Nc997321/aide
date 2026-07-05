<script setup lang="ts">
import { computed } from "vue";
import type { ChatMessage } from "@/types/chat";
import { marked } from "@/utils/markdown";
import ToolCallBlock from "./ToolCallBlock.vue";
import SubagentCallBlock from "./SubagentCallBlock.vue";
import TurnUsageBadge from "./TurnUsageBadge.vue";
import { useFileViewer } from "@/composables/useFileViewer";
import { parseFileLink, resolveFileLinkPath } from "@/utils/fileLink";

const props = defineProps<{
  message: ChatMessage;
  workspacePath?: string;
}>();

const isUser = computed(() => props.message.role === "user");
const { open, openAndScrollTo } = useFileViewer();

// 只响应渲染期已判定为文件的 code（见 utils/markdown.ts codespan 渲染器 +
// utils/fileLink.ts 判定规则），点击层不再自己做路径识别。
function handleTextClick(e: MouseEvent) {
  const codeEl = (e.target as HTMLElement).closest("code.aide-file-link");
  if (!codeEl) return;
  const link = parseFileLink(codeEl.textContent?.trim() ?? "");
  if (!link) return;
  const fullPath = resolveFileLinkPath(link.path, props.workspacePath);
  if (link.line !== undefined) {
    openAndScrollTo(fullPath, link.line);
  } else {
    open(fullPath);
  }
}
</script>

<template>
  <div :class="['msg-row', isUser ? 'msg-row--user' : 'msg-row--assistant']">
    <div :class="['msg-bubble', isUser ? 'msg-bubble--user' : 'msg-bubble--assistant']">
      <template v-for="(block, i) in message.blocks" :key="i">
        <div
          v-if="block.type === 'text'"
          class="msg-text"
          v-html="marked.parse(block.text)"
          @click="handleTextClick"
        />
        <ToolCallBlock
          v-else-if="block.type === 'tool_call'"
          :block="(block as any)"
        />
        <img
          v-else-if="block.type === 'image'"
          :src="`data:${(block as any).mediaType};base64,${(block as any).data}`"
          class="msg-image"
          alt="附图"
        />
        <SubagentCallBlock
          v-else-if="block.type === 'subagent'"
          :block="(block as any)"
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

.msg-bubble--assistant {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
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
