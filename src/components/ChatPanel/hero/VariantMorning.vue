<script setup lang="ts">
import type { WorkspaceInfo } from "@/types";
import WorkspacePicker from "../../../ui/WorkspacePicker.vue";
import { HERO_MODES, type HeroMode } from "./modes";
import type { HeroViewProps } from "./types";

defineProps<HeroViewProps>();

const emit = defineEmits<{
  "select-workspace": [ws: WorkspaceInfo];
  "select-mode": [mode: HeroMode];
}>();
</script>

<template>
  <div class="va">
    <!-- 模式切换：日常 / 工程（默认日常）。选中的判定来自归属，不由本组件持有 -->
    <div class="va-modes" role="tablist" aria-label="新建对话模式">
      <button
        v-for="m in HERO_MODES"
        :key="m.id"
        class="va-mode-btn"
        :class="{ 'is-active': m.id === mode }"
        role="tab"
        :aria-selected="m.id === mode"
        @click="emit('select-mode', m.id)"
      >
        {{ m.label }}
      </button>
    </div>

    <!-- 问候行：日期 + 时钟在「下午好」前作前缀（带等宽字距、像时间戳），图标已移除 -->
    <div class="va-greeting">
      <span class="va-eyebrow">
        <span>{{ chime.dateLabel }}</span>
        <span class="va-eyebrow-dot">·</span>
        <span class="va-eyebrow-clock">{{ chime.clockLabel }}</span>
      </span>
      <span class="va-greeting-text">{{ chime.greeting }}。</span>
    </div>

    <h1 class="va-headline">{{ copy.headline }}</h1>
    <p class="va-body">{{ copy.body }}</p>

    <div class="va-rule" />

    <!-- 环境脚注：工程给「归属 + 模型」，交互保留在 WorkspacePicker；
         日常**没有工作区这个概念**，只留模型名（档位在输入盒工具栏那颗药丸上） -->
    <div class="va-meta">
      <template v-if="mode === 'project'">
        <span class="va-meta-label">新会话位于</span>
        <WorkspacePicker :path="workspacePath" @select="(ws) => emit('select-workspace', ws)" />
        <span class="va-meta-sep">·</span>
      </template>
      <span class="va-meta-model">{{ modelName }}</span>
    </div>
  </div>
</template>

<style scoped>
.va {
  /* 外层定位：hero 区内垂直居中（chat-panel--hero 的 justify-content:center），
     与输入盒保持 20px 间距（对齐旧 hero-head 的 margin-bottom） */
  align-self: center;
  margin-bottom: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  user-select: none;
}

/* 模式分段控件（日常 / 工程）：与下方问候行的间距 = 父 .va 的 gap 10px + 这里的
   margin-bottom 20px。选中态用 accent 渐变，与输入盒发送键同一套视觉语言。 */
.va-modes {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  margin-bottom: 20px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border-subtle);
  border-radius: 999px;
}
.va-mode-btn {
  appearance: none;
  border: 0;
  cursor: pointer;
  padding: 7px 22px;
  border-radius: 999px;
  font-family: inherit;
  font-size: 13.5px;
  color: var(--aide-text-secondary);
  background: transparent;
  transition: color var(--aide-ease-t), background var(--aide-ease-t);
}
.va-mode-btn:hover {
  color: var(--aide-text-primary);
}
.va-mode-btn.is-active {
  color: var(--aide-text-on-accent);
  background: var(--aide-accent-gradient);
  box-shadow: var(--aide-accent-glow);
}

.va-greeting {
  /* 行内横排：日期时间前缀 + 问候文本；inline-flex 让宽度按内容决定，水平居中由父 .va 的 align-items:center 处理 */
  display: inline-flex;
  align-items: baseline;
  gap: 14px;
  margin: 0;
  font-size: clamp(19px, 2.4vw, 25px);
  font-weight: 500;
  color: var(--aide-text-secondary);
}

.va-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-family: var(--aide-font-mono);
  font-size: 12.5px;
  letter-spacing: 0.08em;
  color: var(--aide-text-muted);
}
.va-eyebrow-dot {
  color: var(--aide-border);
}
.va-eyebrow-clock {
  color: var(--aide-text-secondary);
}

.va-headline {
  margin: 0;
  font-size: clamp(28px, 4.6vw, 44px);
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.22;
  text-align: center;
  color: var(--aide-text-primary);
}

.va-body {
  margin: 4px 0 0;
  max-width: 540px;
  font-size: 15px;
  line-height: 1.7;
  text-align: center;
  color: var(--aide-text-secondary);
}

.va-rule {
  width: min(320px, 62%);
  height: 1px;
  margin: 16px 0 12px;
  background: var(--aide-border-subtle);
}

.va-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  color: var(--aide-text-secondary);
}
.va-meta-label {
  color: var(--aide-text-muted);
}
.va-meta-sep {
  color: var(--aide-text-muted);
}
.va-meta-model {
  color: var(--aide-accent);
}
</style>
