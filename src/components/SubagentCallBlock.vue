<script setup lang="ts">
import { computed, ref } from "vue";
import type { SubagentBlock } from "@/types/chat";
import SubagentTimeline from "./subagent/SubagentTimeline.vue";
import { subagentStatus, subagentStepCount } from "@/utils/subagent";

/**
 * 消息流里的子代理块：**折叠行就是全部**（方案 A）——一行摘要「Agent · 类型 ·
 * 描述 · 模型 · 状态步数 · 步数墨线」，点开才在原位展开完整时间线。
 *
 * 为什么默认一行：定稿消息里子代理会被折进过程胶囊（限高 440px 内滚），展开态
 * 动辄上千像素，既看不全也别想扫读；「有几个在跑 / 跑到哪了」交给输入框上方的
 * 子代理 dock（SubagentDock），消息流只留「这一轮派过谁、结果如何」。
 */
const props = defineProps<{ block: SubagentBlock }>();

const expanded = ref(false);

/** 状态三态：跑 / 完成 / 出错 —— 摘要胶囊、左条、文字色都据它取。 */
const status = computed(() => subagentStatus(props.block));

const stepCount = computed(() => subagentStepCount(props.block));

/** 摘要里的状态胶囊：「● 8 步」这种，扫一眼就知道跑到哪；还没迈步的子代理退化成
 *  措辞（0 步写出来只是噪音）。 */
const statusChip = computed(() => {
  const n = stepCount.value;
  if (status.value === "run") return n > 0 ? `● ${n} 步` : "● 运行中";
  if (status.value === "err") return n > 0 ? `✗ ${n} 步` : "✗ 出错";
  return n > 0 ? `✓ ${n} 步` : "✓ 完成";
});

/** 微型步数墨线：一竖条 = 一步，密度即「这个子代理干了多少活」。只运行中画 ——
 *  它是「正在动」的信号；完成后步数已成静态事实，数字足够。超上限截断，防长跑
 *  子代理把一行铺满。 */
const MAX_TICKS = 12;
const ticks = computed(() => (status.value === "run" ? Math.min(stepCount.value, MAX_TICKS) : 0));

const statusHint = computed(() => {
  if (status.value === "run") return "子代理执行中";
  if (status.value === "err") return "子代理出错";
  return "子代理已完成";
});
</script>

<template>
  <div class="sa" :class="`sa--${status}`">
    <div class="sa-content">
      <!-- 折叠行：角色 + 类型 pill + 描述 + 模型 + 状态步数 + 步数墨线 + 箭头。
           这一行就是子代理在消息流里的全部存在感；完整时间线在后面（点开才有）。 -->
      <button class="sa-head" :aria-expanded="expanded" @click="expanded = !expanded">
        <span class="sa-role">Agent</span>
        <span class="sa-type" v-tooltip="`子代理类型：${block.agentName}`">{{ block.agentName }}</span>
        <span class="sa-desc">{{ block.description }}</span>
        <span v-if="block.model" class="sa-model" v-tooltip="`子代理使用的模型：${block.model}`">{{ block.model }}</span>
        <span class="sa-chip" :class="`sa-chip--${status}`" v-tooltip="statusHint">{{ statusChip }}</span>
        <span v-if="ticks" class="sa-ticks" aria-hidden="true">
          <i v-for="n in ticks" :key="n"></i>
        </span>
        <svg
          class="sa-chev" :class="{ 'sa-chev--open': expanded }"
          width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"
        >
          <path d="M2 1.5l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <!-- 展开体：完整时间线（派发指令 → 工具步/思考/文本 → 最终产出），与子代理 dock
           的阅读区同一份实现（subagent/SubagentTimeline.vue）。 -->
      <SubagentTimeline v-if="expanded" :block="block" />
    </div>
  </div>
</template>

<style scoped>
/* 子代理：GALLERY .subagent — agentAccent 左边条 + 渐变背景。
   左边条是子代理在整个应用里的签名（dock 状态条同款），认条不认字。 */
.sa {
  position: relative;
  display: flex;
  align-items: stretch;
  margin: 4px 0;
  font-size: 11.5px;
  border: 1px solid var(--aide-border-subtle);
  border-left: 3px solid var(--aide-agent-accent);
  border-radius: var(--aide-radius-md);
  background: linear-gradient(90deg, color-mix(in srgb, var(--aide-agent-accent) 5%, transparent), var(--aide-bg-base) 40%);
  overflow: hidden;
  box-shadow: var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

/* 出错：左条转危险色 —— 折叠态一行也要能看出「这个子代理没跑成」 */
.sa--err {
  border-left-color: var(--aide-danger);
}

.sa-content {
  flex: 1;
  min-width: 0;
  padding: 2px 0;
}

/* 折叠行：复用 GALLERY .tc-head 卡片头行 */
.sa-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: background var(--aide-ease-t);
}
.sa-head:hover {
  background: var(--aide-surface-default);
}

.sa-role {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.sa-type {
  flex-shrink: 0;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--aide-agent-accent);
  background: color-mix(in srgb, var(--aide-agent-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-agent-accent) 25%, transparent);
  border-radius: 3px;
  padding: 1px 5px;
}
.sa-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
  transition: color var(--aide-ease-t);
}
.sa-head:hover .sa-desc {
  color: var(--aide-text-secondary);
}
.sa-model {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  border-radius: 4px;
  padding: 0 4px;
}

/* 状态胶囊：跑=agentAccent，完成=success，出错=danger */
.sa-chip {
  flex-shrink: 0;
  font-size: 10.5px;
  font-family: var(--aide-font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.sa-chip--run {
  color: var(--aide-agent-accent);
}
.sa-chip--done {
  color: var(--aide-success);
}
.sa-chip--err {
  color: var(--aide-danger);
}

/* 步数墨线：一竖条一步（运行中才有） */
.sa-ticks {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
}
.sa-ticks i {
  width: 3px;
  height: 9px;
  border-radius: 1px;
  background: var(--aide-agent-accent);
  opacity: 0.85;
}

.sa-chev {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform var(--aide-ease-t);
}
.sa-chev--open {
  transform: rotate(90deg);
}

.sa-head:focus-visible {
  outline: 1px solid var(--aide-agent-accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .sa-chev { transition: none; }
}
</style>
