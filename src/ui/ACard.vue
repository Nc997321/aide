<script setup lang="ts">
withDefaults(
  defineProps<{
    active?: boolean;
    hoverable?: boolean;
    glowColor?: string;
  }>(),
  { active: false, hoverable: true },
);
</script>

<template>
  <div
    class="a-card"
    :class="{ 'a-card--active': active, 'a-card--hoverable': hoverable }"
    :style="glowColor ? { '--glow-color': glowColor } as any : undefined"
  >
    <div v-if="glowColor" class="a-card__glow" />
    <slot />
  </div>
</template>

<style scoped>
.a-card {
  position: relative;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-lg);
  padding: 16px;
  overflow: hidden;
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-sm);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  transition: all var(--aide-ease-t);
}

.a-card--hoverable {
  cursor: pointer;
}

/* 悬停反馈只走光影（边框 + 阴影加深），不做位移：translateY 上浮会让底缘脱离光标
   形成 hover 失而复得的振荡循环（光标停在卡片底缘 2px 条带内时持续震颤）。 */
.a-card--hoverable:hover {
  border-color: var(--aide-border-strong);
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-md);
}

.a-card--active {
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
  background:
    linear-gradient(135deg, var(--aide-accent-subtle) 0%, transparent 60%),
    var(--aide-bg-raised);
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-sm);
}

.a-card__glow {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: linear-gradient(180deg, transparent, var(--glow-color, var(--aide-success)), transparent);
  animation: a-card-glow-pulse 2s ease-in-out infinite;
}

@keyframes a-card-glow-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
</style>
