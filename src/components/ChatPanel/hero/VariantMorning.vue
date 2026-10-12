<script setup lang="ts">
import type { WorkspaceInfo } from "@/types";
import WorkspacePicker from "../../../ui/WorkspacePicker.vue";
import { CHAT_MODES, type ChatMode } from "../modes";
import type { HeroViewProps } from "./types";

defineProps<HeroViewProps>();

const emit = defineEmits<{
  "select-workspace": [ws: WorkspaceInfo];
  "select-mode": [mode: ChatMode];
  "open-session": [sessionId: string];
}>();
</script>

<template>
  <div class="va">
    <!-- 模式切换：日常 / 工程（默认日常）。选中的判定来自归属，不由本组件持有 -->
    <div class="va-modes" role="tablist" aria-label="新建对话模式">
      <button
        v-for="m in CHAT_MODES"
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

    <!-- 分隔线下那一行：工程给环境脚注（归属 + 模型，交互保留在 WorkspacePicker）；
         日常**没有工作区这个概念**，给「接着上次」——最近一场日常对话，点一下回去。
         日常不放模型名：同一个名字就在正下方输入盒的模型下拉里。一场都没聊过就整段不渲染 -->
    <template v-if="mode === 'project'">
      <div class="va-rule" />
      <div class="va-meta">
        <span class="va-meta-label">新会话位于</span>
        <WorkspacePicker :path="workspacePath" @select="(ws) => emit('select-workspace', ws)" />
        <span class="va-meta-sep">·</span>
        <span class="va-meta-model">{{ modelName }}</span>
      </div>
    </template>
    <template v-else-if="resume">
      <div class="va-rule" />
      <button
        type="button"
        class="va-resume"
        v-tooltip="'回到这场对话'"
        @click="emit('open-session', resume.sessionId)"
      >
        <span class="va-resume-label">接着上次</span>
        <span class="va-resume-title">{{ resume.title }}</span>
        <span class="va-resume-ago">{{ resume.ago }}</span>
        <span class="va-resume-arrow" aria-hidden="true">→</span>
      </button>
    </template>
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

/* 「接着上次」：平时是一行安静的脚注，hover 才显出它是个入口（标题提亮、箭头滑出） */
.va-resume {
  appearance: none;
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  max-width: min(520px, 90%);
  padding: 4px 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  font-family: inherit;
  font-size: 13.5px;
  color: var(--aide-text-secondary);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.va-resume:hover,
.va-resume:focus-visible {
  background: var(--aide-surface-hover);
}
.va-resume-label {
  flex-shrink: 0;
  color: var(--aide-text-muted);
}
.va-resume-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--aide-ease-t);
}
.va-resume:hover .va-resume-title,
.va-resume:focus-visible .va-resume-title {
  color: var(--aide-text-primary);
}
.va-resume-ago {
  flex-shrink: 0;
  font-family: var(--aide-font-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--aide-text-muted);
}
.va-resume-arrow {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--aide-accent);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.va-resume:hover .va-resume-arrow,
.va-resume:focus-visible .va-resume-arrow {
  opacity: 1;
  transform: translateX(0);
}
</style>
