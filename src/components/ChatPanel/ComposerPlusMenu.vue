<script setup lang="ts">
/**
 * 输入框左侧的 `＋` 菜单（单行输入框，2026-10-16）：把散在框里框外的入口收成一个可见菜单。
 * 键盘直接输 `@` `/`、粘贴 / 拖入文件的行为都不变——菜单只是让这些能力看得见。
 *
 * 只发事件，动作由 ChatInputBox 落实（文件走既有的暂存 / 附件管线，@ 与 / 走既有补全）。
 * 「顺便问一下」在发送按钮的悬停列表里、上下文与用量在环形图上，这里不重复（2026-10-17）。
 */
import { ref } from "vue";
import ComposerPopover from "./ComposerPopover.vue";
import type { PlusAction } from "./composerPlus";

const emit = defineEmits<{ pick: [action: PlusAction] }>();

const open = ref(false);
const triggerRef = ref<HTMLElement | null>(null);

function pick(action: PlusAction) {
  open.value = false;
  emit("pick", action);
}
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="cplus"
    :class="{ 'cplus--open': open }"
    aria-label="添加"
    :aria-expanded="open"
    @click="open = !open"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  </button>
  <ComposerPopover :open="open" :anchor="triggerRef" :min-width="230" @close="open = false">
    <div role="menu" aria-label="添加">
      <button type="button" role="menuitem" class="cplus-item" @click="pick('files')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></svg>
        <span class="cplus-label">添加图片或文件</span>
        <span class="cplus-key">粘贴 / 拖入</span>
      </button>
      <button type="button" role="menuitem" class="cplus-item" @click="pick('mention')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></svg>
        <span class="cplus-label">引用文件或目录</span>
        <span class="cplus-key">@</span>
      </button>
      <button type="button" role="menuitem" class="cplus-item" @click="pick('slash')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M9 20L15 4" /></svg>
        <span class="cplus-label">命令与技能</span>
        <span class="cplus-key">/</span>
      </button>
    </div>
  </ComposerPopover>
</template>

<style scoped>
.cplus {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-text-secondary);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.cplus:hover,
.cplus--open {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.cplus-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.cplus-item:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.cplus-item svg {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--aide-text-muted);
}
.cplus-label {
  flex: 1;
}
.cplus-key {
  font-size: 11px;
  color: var(--aide-text-muted);
}
</style>
