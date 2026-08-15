<script setup lang="ts">
import type { Tab } from "./ATabBar.vue";

/**
 * 竖直工具栏（IntelliJ IDEA 风格右侧边缘 stripe）。
 * 与 {@link ./ATabBar.vue} 共用 `Tab` 类型，但布局/交互语义独立：
 * 竖直排列、激活左缘条、badge 角标、点已激活项由父裁决折叠。
 * ATabBar 的横向样式被 GitPanel 依赖，故不复用、不改造。
 */
const props = defineProps<{
  tabs: Tab[];
  /** 当前激活 id（仅用于高亮，不双向绑定——切换/折叠由父经 `select` 处理）。 */
  modelValue: string;
  /** 折叠态：为 true 时不渲染 active 高亮（IDEA 行为：无展开面板则不高亮）。 */
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

function onKeydown(e: KeyboardEvent) {
  const idx = props.tabs.findIndex((t) => t.id === props.modelValue);
  if (e.key === "ArrowDown" && idx < props.tabs.length - 1) {
    e.preventDefault();
    emit("select", props.tabs[idx + 1].id);
  } else if (e.key === "ArrowUp" && idx > 0) {
    e.preventDefault();
    emit("select", props.tabs[idx - 1].id);
  }
}
</script>

<template>
  <div class="a-rail-bar" role="tablist" @keydown="onKeydown">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="a-rail-btn"
      :class="{ 'a-rail-btn--active': !collapsed && modelValue === tab.id }"
      role="tab"
      :aria-selected="!collapsed && modelValue === tab.id"
      :aria-label="tab.label || tab.id"
      :tabindex="!collapsed && modelValue === tab.id ? 0 : -1"
      v-tooltip="tab.label || tab.id"
      @click="emit('select', tab.id)"
    >
      <span v-if="tab.icon" class="a-rail-btn__icon" v-html="tab.icon"></span>
      <span v-if="tab.badge && tab.badge > 0" class="a-rail-badge">{{ tab.badge }}</span>
    </button>
  </div>
</template>

<style scoped>
.a-rail-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  width: var(--aide-rail-w, 40px);
  flex-shrink: 0;
  border-left: 1px solid var(--aide-border-subtle);
  background-color: var(--aide-bg-deep);
}

.a-rail-btn {
  position: relative;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}

.a-rail-btn:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
}

.a-rail-btn--active {
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}

/* IDEA 标志：激活按钮左缘竖条 */
.a-rail-btn--active::before {
  content: "";
  position: absolute;
  left: -4px;
  top: 4px;
  bottom: 4px;
  width: 2.5px;
  border-radius: 2px;
  background: var(--aide-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 60%, transparent);
}

.a-rail-btn__icon {
  font-size: 16px;
  display: inline-flex;
  align-items: center;
}

.a-rail-btn__icon :deep(svg) {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* badge 角标（绝对定位右上角；不用 ABadge——它是流内 inline-flex） */
.a-rail-badge {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  text-align: center;
  border-radius: 8px;
  color: var(--aide-text-on-accent);
  background: var(--aide-accent);
  /* 描边挖空按钮底色，避免与图标混作一团 */
  box-shadow: 0 0 0 1.5px var(--aide-bg-deep);
}
</style>