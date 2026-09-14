<script setup lang="ts">
import { computed } from "vue";
import { useBtwSession } from "@/composables/useBtwSession";
import { renderMarkdown } from "@/utils/markdown";

const props = defineProps<{ visible: boolean; modelLabel: string }>();
const emit = defineEmits<{
  (e: "close"): void;
}>();

const { store } = useBtwSession();
const text = computed(() => store.value.messages.join(""));
// 与主对话同一渲染管道（.msg-text 样式见 global.css）。侧问走官方 side_question
// 控制通道，结果是整段回来的（无流式帧），所以直接进 renderMarkdown 并吃缓存——
// 不再需要 renderStreaming 那条"流式中暂不高亮"的路径。约 1.6s 出整段。
const html = computed(() => renderMarkdown(text.value));
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
      </div>
      <div class="btw-body">
        <div class="btw-q">{{ store.question }}</div>
        <div class="btw-a msg-text" v-html="html"></div>
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
