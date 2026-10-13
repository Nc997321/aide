<script setup lang="ts">
/** 标题栏徽标：侧栏应用在所有工作区里正在跑的进程。没有进程时不出现。
 *  应用起的进程归 Host 管，面板关了也在跑——用户得有一个不依赖应用界面的地方看到并结束它。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import AppProcessList from "../apps/AppProcessList.vue";
import { useAppProcesses } from "../../composables/useAppProcesses";
import { useApps } from "../../composables/useApps";

defineProps<{ workspaceRoot?: string }>();

const { visible, running } = useAppProcesses();
const { apps } = useApps();
const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

/** 按应用分组，组名用应用的名字（应用已不在清单里就退回 id）。 */
const groups = computed(() => {
  const byApp = new Map<string, typeof visible.value>();
  for (const p of visible.value) byApp.set(p.appId, [...(byApp.get(p.appId) ?? []), p]);
  return [...byApp].map(([id, items]) => ({ id, name: apps.value.find((a) => a.id === id)?.name ?? id, items }));
});

// 最后一行也消失了：面板跟着收起，徽标随之隐藏
watch(visible, (list) => {
  if (list.length === 0) open.value = false;
});

function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
}
onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div v-if="visible.length > 0" ref="rootEl" class="procs-wrap">
    <button
      class="procs-badge"
      v-tooltip="'侧栏应用正在运行的进程'"
      aria-label="侧栏应用正在运行的进程"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="procs-dot" :class="{ 'procs-dot--idle': running.length === 0 }" />
      <span>{{ running.length }} 个进程在运行</span>
    </button>

    <Transition name="procs-drop">
      <div v-if="open" class="procs-panel" role="dialog" aria-label="侧栏应用正在运行的进程">
        <div class="procs-header">
          <span class="procs-title">应用正在运行的进程</span>
          <span class="procs-scope">全部工作区</span>
        </div>
        <div v-for="g in groups" :key="g.id" class="procs-group">
          <div class="procs-group-name">{{ g.name }}</div>
          <AppProcessList :items="g.items" :current-workspace="workspaceRoot ?? ''" />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.procs-wrap {
  position: relative;
}

.procs-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  margin: 0 4px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: 99px;
  color: var(--aide-text-secondary);
  font-size: 10.5px;
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--aide-ease-t), border-color var(--aide-ease-t);
  box-shadow: var(--aide-highlight-inset);
}

.procs-badge:hover {
  background: var(--aide-surface-hover);
}

.procs-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-success);
  animation: procs-pulse 1.6s ease-in-out infinite;
}

.procs-dot--idle {
  background: var(--aide-text-muted);
  animation: none;
}

@keyframes procs-pulse {
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .procs-dot {
    animation: none;
  }
}

.procs-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 400px;
  max-height: 60vh;
  overflow-y: auto;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  z-index: 900;
  backdrop-filter: var(--aide-surface-blur);
}

.procs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--aide-border);
}

.procs-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.8px;
  color: var(--aide-text-muted);
}

.procs-scope {
  font-size: 11px;
  color: var(--aide-text-muted);
}

.procs-group + .procs-group {
  border-top: 1px solid var(--aide-border);
}

.procs-group-name {
  padding: 8px 12px 2px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.procs-drop-enter-active,
.procs-drop-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}

.procs-drop-enter-from,
.procs-drop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
