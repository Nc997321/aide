<script setup lang="ts">
import { computed } from "vue";

/**
 * 标题栏侧边栏收起/展开按钮 —— VSCode 风格"方块被竖线分成两半"。
 *
 * 窄半代表对应侧边栏，填充程度反映可见状态：
 *   展开态 → 窄半 accent 高亮；收起态 → 窄半低对比半透明。
 * 纯展示 + 点击组件，无内部状态。状态由 App.vue 的 leftCollapsed/rightCollapsed
 * 单一数据源驱动（grid 轨道宽度仍由它算，本组件只是第二个收起入口）。
 */
const props = defineProps<{
  side: "left" | "right";
  collapsed: boolean;
}>();

defineEmits<{ toggle: [] }>();

const tooltipLabel = computed(() => {
  const which = props.side === "left" ? "左侧栏" : "右侧栏";
  return props.collapsed ? `展开${which}` : `收起${which}`;
});

// 竖线 x 坐标：左按钮切线偏左（窄半在左），右按钮切线偏右（窄半在右）。
const dividerX = computed(() => (props.side === "left" ? 5 : 11));
</script>

<template>
  <button
    class="sidebar-toggle"
    :class="[`side-${side}`, { collapsed }]"
    v-tooltip="tooltipLabel"
    @click="$emit('toggle')"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <!-- 方块外框 -->
      <rect
        class="frame"
        x="1"
        y="1"
        width="14"
        height="14"
        rx="2.5"
      />
      <!-- 竖分隔线 -->
      <line
        class="divider"
        :x1="dividerX"
        :x2="dividerX"
        y1="1.5"
        y2="14.5"
      />
      <!-- 窄半填充（侧栏可见性指示） -->
      <rect
        v-if="side === 'left'"
        class="narrow"
        x="1.5"
        y="1.5"
        width="3.5"
        height="13"
        rx="1.5"
      />
      <rect
        v-else
        class="narrow"
        x="11"
        y="1.5"
        width="3.5"
        height="13"
        rx="1.5"
      />
    </svg>
  </button>
</template>

<style scoped>
.sidebar-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition: background var(--aide-ease-t), border-color var(--aide-ease-t);
}

.sidebar-toggle:hover {
  background: color-mix(in srgb, var(--aide-accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--aide-accent) 30%, transparent);
}

.sidebar-toggle:focus-visible {
  outline: 2px solid var(--aide-accent);
  outline-offset: -2px;
}

/* 外框 + 竖线：始终低对比轮廓 */
.frame {
  stroke: var(--aide-border);
  fill: none;
  stroke-width: 1.2;
}

.divider {
  stroke: var(--aide-border);
  stroke-width: 1.2;
}

/* 窄半：展开态高亮 accent，收起态低对比半透明 */
.narrow {
  fill: var(--aide-accent);
  transition: fill var(--aide-ease-t);
}

.sidebar-toggle.collapsed .narrow {
  fill: color-mix(in srgb, var(--aide-text-muted) 40%, transparent);
}

/* hover 提亮窄半：给"可点亮"暗示 */
.sidebar-toggle:hover .narrow {
  fill: var(--aide-accent-hover);
}

.sidebar-toggle.collapsed:hover .narrow {
  fill: var(--aide-text-muted);
}
</style>