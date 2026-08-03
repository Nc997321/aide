<script setup lang="ts">
import { computed } from "vue";
import { useBtwSession } from "@/composables/useBtwSession";
import { renderMarkdown, renderStreaming } from "@/utils/markdown";

const props = defineProps<{ visible: boolean; lightweight: boolean; modelLabel: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "update:lightweight", v: boolean): void;
}>();

const { store } = useBtwSession();
const text = computed(() => store.value.messages.join(""));
// 与主对话同一渲染管道（.msg-text 样式见 global.css）：流式中走 renderStreaming
// （结构实时渲染、代码围栏暂不高亮），跑完切 renderMarkdown 补高亮并进缓存。
const html = computed(() =>
  store.value.isBusy ? renderStreaming(text.value) : renderMarkdown(text.value),
);
</script>

<template>
  <Transition name="btw-drawer">
    <aside v-if="props.visible" class="btw-drawer" role="complementary" aria-label="顺便问一下">
      <div class="btw-drawer-stripe"></div>
      <div class="btw-head">
        <div class="btw-title-row">
          <div class="btw-title"><span class="btw-fork">↳</span> 顺便问一下 <span class="btw-pill">· {{ props.modelLabel }}</span></div>
          <button class="btw-btn" @click="emit('close')">关闭</button>
        </div>
        <div class="btw-seg-row">
          <div class="btw-seg" role="group">
            <button :aria-pressed="props.lightweight" @click="emit('update:lightweight', true)" :disabled="store.isBusy">轻量</button>
            <button :aria-pressed="!props.lightweight" @click="emit('update:lightweight', false)" :disabled="store.isBusy">完整</button>
          </div>
        </div>
      </div>
      <div class="btw-body">
        <div class="btw-q">{{ store.question }}</div>
        <div class="btw-a msg-text" v-html="html"></div>
        <span v-if="store.isBusy" class="btw-cursor"></span>
        <div v-if="store.error" class="btw-err">{{ store.error }}</div>
      </div>
      <div v-if="store.done" class="btw-foot">
        <span class="btw-ok">已作为批注插入主对话</span>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
/* /btw 浮层：GALLERY .btw 壳层 — accentSubtle 头部 + border-strong + shadow-lg */
.btw-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--aide-bg-raised);
  border-left: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg) 0 0 var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  z-index: 20;
  overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.btw-drawer-stripe {
  display: none;
}

/* 头部：GALLERY .bw-head */
.btw-head {
  padding: 8px 11px;
  border-bottom: 1px solid var(--aide-border-subtle);
  background: var(--aide-accent-subtle);
}

.btw-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.btw-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  font-weight: 600;
  color: var(--aide-accent);
  min-width: 0;
}

.btw-fork {
  font-size: 14px;
  line-height: 1;
}

.btw-pill {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-weight: 400;
}

.btw-seg-row {
  margin-top: 8px;
}

.btw-seg {
  display: inline-flex;
  border: 1px solid var(--aide-border);
  border-radius: 999px;
  overflow: hidden;
}

.btw-seg button {
  background: none;
  border: 0;
  color: var(--aide-text-muted);
  padding: 3px 11px;
  font-size: 11px;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.btw-seg button[aria-pressed="true"] {
  background: color-mix(in srgb, var(--aide-accent) 15%, transparent);
  color: var(--aide-accent);
}

.btw-seg button:disabled {
  opacity: 0.5;
  cursor: default;
}

.btw-btn {
  border: 1px solid var(--aide-border);
  background: transparent;
  color: var(--aide-text-secondary);
  border-radius: var(--aide-radius-sm);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all var(--aide-ease-t);
  flex-shrink: 0;
}

.btw-btn:hover {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
}

.btw-body {
  flex: 1;
  overflow: auto;
  padding: 10px 11px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.btw-q {
  font-size: 12px;
  color: var(--aide-text-secondary);
  border-left: 2px solid var(--aide-border);
  padding-left: 9px;
}

.btw-a {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--aide-text-primary);
  word-break: break-word;
}

.btw-cursor {
  display: inline-block;
  width: 6px;
  height: 13px;
  vertical-align: -2px;
  background: var(--aide-accent);
  animation: btw-blink 1s steps(2, start) infinite;
}

@keyframes btw-blink {
  50% {
    opacity: 0;
  }
}

.btw-err {
  font-size: 12px;
  color: var(--aide-danger);
}

.btw-foot {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-top: 1px solid var(--aide-border);
  background: color-mix(in srgb, var(--aide-success) 6%, transparent);
}

.btw-ok {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--aide-success);
}

.btw-ok::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--aide-success);
}

.btw-drawer-enter-active,
.btw-drawer-leave-active {
  transition: transform var(--aide-ease-t), opacity var(--aide-ease-t);
}

.btw-drawer-enter-from,
.btw-drawer-leave-to {
  transform: translateX(20px);
  opacity: 0;
}
</style>
