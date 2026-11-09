<script setup lang="ts">
import { ref } from "vue";
import type { CreationMode } from "../../../composables/browser/useBrowserHistory";
import { useBrowserStartActions } from "../../../composables/browser/useBrowserStartActions";
import BrowserDialog from "./BrowserDialog.vue";

const props = defineProps<{ mode: CreationMode }>();
const emit = defineEmits<{ close: []; prepared: [] }>();
const brief = ref("");
const error = ref("");
const actions = useBrowserStartActions();

function prepare(): void {
  try {
    actions.prepareCreation({ mode: props.mode, brief: brief.value });
    emit("prepared");
  } catch (cause) {
    error.value = String(cause);
  }
}
</script>

<template>
  <BrowserDialog :title="props.mode === 'create' ? '制作短视频' : '剪辑已有视频'" @close="emit('close')">
    <p>{{ props.mode === 'create' ? '说说主题、观众和大致时长。先确认分镜，再开始制作。' : '说说要剪哪段、字幕怎么加；素材可以附在会话里，或从媒体预览选择片段。' }}</p>
    <form class="browser-creation-form" @submit.prevent="prepare">
      <label for="browser-creative-brief">{{ props.mode === 'create' ? '视频想法' : '剪辑要求' }}</label>
      <textarea id="browser-creative-brief" v-model="brief" rows="5" :placeholder="props.mode === 'create' ? '例如：做一支 30 秒的产品介绍短片，用文字和录屏讲清三个功能。' : '例如：把产品录屏剪到 60 秒，保留演示操作，加中文字幕。'" />
      <p>填入当前会话草稿，保留已有内容，由你确认发送；不会自动启动制作或渲染。</p>
      <div v-if="error" class="browser-dialog__error" role="alert">{{ error }}</div>
      <button type="submit">填入会话草稿</button>
    </form>
  </BrowserDialog>
</template>

<style scoped>
.browser-creation-form { display: flex; flex-direction: column; gap: calc(var(--aide-space-unit) * 3); }
.browser-creation-form label { color: var(--aide-text-primary); font-size: 13px; }
.browser-creation-form textarea { width: 100%; min-height: 120px; padding: calc(var(--aide-space-unit) * 3); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); background: var(--aide-bg-deep); color: var(--aide-text-primary); resize: vertical; font: inherit; line-height: 1.7; }
.browser-creation-form textarea::placeholder { color: var(--aide-text-muted); }
.browser-creation-form p { font-size: 12px; }
.browser-creation-form button { align-self: flex-start; padding: calc(var(--aide-space-unit) * 2) calc(var(--aide-space-unit) * 3); border: 1px solid var(--aide-border-strong); border-radius: var(--aide-radius-sm); background: var(--aide-surface-active); color: var(--aide-text-primary); cursor: pointer; font-size: 13px; }
</style>
