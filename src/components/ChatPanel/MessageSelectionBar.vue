<script setup lang="ts">
/**
 * 消息里选中文字后挂在末尾的小浮条：「引用 | 派给子会话」。
 * 按下不抢焦点（mousedown.prevent），选区保持住；不碰复制（Ctrl+C 照常）。
 * 不能派时用 aria-disabled 而不是 disabled：禁用的按钮收不到悬停，原因提示就出不来。
 */
import { computed } from "vue";
import Icon from "../Icon.vue";
import type { AnchorRect } from "../floatingCard";

const props = defineProps<{
  rect: AnchorRect;
  /** null = 本会话不能派（子会话 / 还没定名）：只留「引用」 */
  spawn: { disabledReason: string | null } | null;
}>();

const emit = defineEmits<{ quote: []; spawn: [] }>();

const style = computed(() => ({
  top: `${Math.min(props.rect.bottom + 6, window.innerHeight - 40)}px`,
  left: `${Math.max(8, Math.min(props.rect.right - 24, window.innerWidth - 220))}px`,
}));
</script>

<template>
  <Teleport to="body">
    <div class="msb" role="toolbar" aria-label="选中的文字" :style="style" @mousedown.prevent>
      <button type="button" class="msb-btn" @click="emit('quote')">
        <Icon name="quote" :size="14" :stroke-width="1.5" class="msb-icon" />
        引用
      </button>
      <template v-if="spawn">
        <span class="msb-sep" aria-hidden="true" />
        <button
          type="button"
          class="msb-btn"
          :class="{ 'msb-btn--off': !!spawn.disabledReason }"
          :aria-disabled="!!spawn.disabledReason"
          v-tooltip="spawn.disabledReason ?? ''"
          @click="!spawn.disabledReason && emit('spawn')"
        >
          <Icon name="subsession" :size="14" :stroke-width="1.5" class="msb-icon msb-icon--accent" />
          派给子会话
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.msb {
  position: fixed;
  z-index: 9000;
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 3px;
  border-radius: 15px;
  border: 1px solid var(--aide-border-strong);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-md), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  animation: msb-in 140ms var(--aide-ease, ease-out);
}
@keyframes msb-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.msb-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px 0 8px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: var(--aide-text-primary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--aide-ease-t);
}
.msb-btn:hover:not(.msb-btn--off) {
  background: var(--aide-surface-hover);
}
.msb-btn--off {
  color: var(--aide-text-muted);
  cursor: default;
}
.msb-icon {
  color: var(--aide-text-secondary);
}
.msb-icon--accent {
  color: var(--aide-accent);
}
.msb-btn--off .msb-icon {
  color: inherit;
}
.msb-sep {
  width: 1px;
  height: 14px;
  background: var(--aide-border);
}
</style>
