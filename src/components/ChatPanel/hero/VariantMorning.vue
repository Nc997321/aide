<script setup lang="ts">
import type { WorkspaceInfo } from "@/types";
import AppLogo from "../../AppLogo.vue";
import WorkspacePicker from "../../../ui/WorkspacePicker.vue";
import type { HeroViewProps } from "./types";

defineProps<HeroViewProps>();

const emit = defineEmits<{
  "select-workspace": [ws: WorkspaceInfo];
}>();
</script>

<template>
  <div class="va">
    <!-- eyebrow：日期 + 时钟，等宽宽字距，像台账上的时间戳 -->
    <div class="va-eyebrow">
      <AppLogo :size="20" />
      <span>{{ chime.dateLabel }}</span>
      <span class="va-eyebrow-dot">·</span>
      <span class="va-eyebrow-clock">{{ chime.clockLabel }}</span>
    </div>

    <p class="va-greeting">{{ chime.greeting }}。</p>
    <h1 class="va-headline">{{ copy.headline }}</h1>
    <p class="va-body">{{ copy.body }}</p>

    <div class="va-rule" />

    <!-- 环境脚注：归属 + 模型，交互保留在 WorkspacePicker -->
    <div class="va-meta">
      <span class="va-meta-label">新会话位于</span>
      <WorkspacePicker :path="workspacePath" @select="(ws) => emit('select-workspace', ws)" />
      <span class="va-meta-sep">·</span>
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

.va-eyebrow {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 18px;
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

.va-greeting {
  margin: 0;
  font-size: clamp(19px, 2.4vw, 25px);
  font-weight: 500;
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
