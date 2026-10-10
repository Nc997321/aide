<script setup lang="ts">
/**
 * 欢迎页输入盒上方的场景条：没选场景时列场景，选了之后换成该场景的示例提示词
 * （点示例 = 把提示词填进输入框，不直接发送）。选中态由输入盒持有，本组件只管画。
 */
import { SCENES, type Scene, type SceneExample } from "./scenes";

defineProps<{ active: Scene | null }>();

const emit = defineEmits<{
  select: [scene: Scene];
  example: [example: SceneExample];
}>();
</script>

<template>
  <div class="scene-bar" role="toolbar" :aria-label="active ? `${active.label}示例` : '选择场景'">
    <template v-if="active">
      <button
        v-for="ex in active.examples"
        :key="ex.label"
        type="button"
        class="scene-chip scene-chip--example"
        v-tooltip="ex.prompt"
        @click="emit('example', ex)"
      >
        {{ ex.label }}<span class="scene-chip-arrow">↘</span>
      </button>
    </template>
    <template v-else>
      <button
        v-for="s in SCENES"
        :key="s.id"
        type="button"
        class="scene-chip"
        @click="emit('select', s)"
      >
        <span class="scene-chip-icon">{{ s.icon }}</span>{{ s.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.scene-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-bottom: 12px;
}
.scene-chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--aide-border-subtle);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--aide-ease-t), background var(--aide-ease-t), border-color var(--aide-ease-t);
}
.scene-chip:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
  border-color: var(--aide-border-strong);
}
.scene-chip-icon {
  color: var(--aide-accent);
  font-size: 13px;
  line-height: 1;
}
.scene-chip--example {
  background: var(--aide-accent-subtle);
  border-color: transparent;
}
.scene-chip-arrow {
  color: var(--aide-text-muted);
  font-size: 12px;
}
</style>
