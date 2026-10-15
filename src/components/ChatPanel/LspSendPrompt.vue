<script setup lang="ts">
/**
 * 新会话发出首条消息时的一条提示：开不开语言服务器（判定 / 落实见 lspSendGate.ts）。**不阻塞**：
 * 消息已经发出去了，这条留着等用户选；选了「开启」Host 立刻在后台预热（这一轮的 LSP 查询就能接上）。
 *
 * 贴在输入框正上方、与输入框同宽（ChatInputBox 的 `above-box` 插槽），输入框不收起——刚打的字一直
 * 看得见。一开始复用了权限卡的发送前确认，欢迎页里整块横在页面顶上、把欢迎语挤下去、输入框也被收起，
 * 一个轻量的二选一被做成了重型确认（2026-10-15 真机反馈「很丑」），改成这一条。
 */
import type { PreflightLang } from "@aide/sdk/types/lspPacks";
import { computed } from "vue";
import { lspPromptModel } from "./lspSendGate";

const props = defineProps<{ langs: PreflightLang[]; busy?: boolean }>();
const emit = defineEmits<{ enable: []; skip: []; dismiss: [] }>();

const m = computed(() => lspPromptModel(props.langs));
</script>

<template>
  <div class="lsp-prompt" role="group" aria-label="是否开启语言服务器">
    <span class="lsp-prompt-tag">语言服务器</span>
    <span class="lsp-prompt-text">
      检测到 <b>{{ m.langs }}</b> 项目，要开启语言服务器吗？开启后 agent 能精确跳转定义、查找引用。
    </span>
    <span class="lsp-prompt-actions">
      <button type="button" class="lsp-prompt-btn" :disabled="busy" @click="emit('skip')">{{ m.secondaryLabel }}</button>
      <button type="button" class="lsp-prompt-btn lsp-prompt-btn--primary" :disabled="busy" @click="emit('enable')">
        {{ m.primaryLabel }}
      </button>
      <button type="button" class="lsp-prompt-x" v-tooltip="'先不决定，下次新会话再问'" aria-label="先不决定" @click="emit('dismiss')">×</button>
    </span>
  </div>
</template>

<style scoped>
/* 与输入框上方「排队」条同一家族：同宽、紧凑、一行 */
.lsp-prompt {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 5px 6px 5px 8px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  min-width: 0;
}

.lsp-prompt-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  padding: 1px 5px;
  border-radius: 3px;
}

.lsp-prompt-text {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
}

.lsp-prompt-text b {
  font-weight: 600;
  color: var(--aide-text-primary);
}

.lsp-prompt-actions {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.lsp-prompt-btn {
  font-size: 11.5px;
  font-family: inherit;
  padding: 3px 9px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: transparent;
  color: var(--aide-text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--aide-ease-t);
}

.lsp-prompt-btn:hover:not(:disabled) {
  color: var(--aide-text-primary);
  border-color: var(--aide-border-strong);
}

.lsp-prompt-btn--primary {
  color: var(--aide-accent);
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
  background: var(--aide-accent-subtle);
}

.lsp-prompt-btn--primary:hover:not(:disabled) {
  color: var(--aide-accent);
  border-color: var(--aide-accent);
}

.lsp-prompt-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.lsp-prompt-x {
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
  border-radius: 3px;
}

.lsp-prompt-x:hover {
  color: var(--aide-text-primary);
}
</style>
