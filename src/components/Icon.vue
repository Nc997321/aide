<script setup lang="ts">
/**
 * 铜线图标渲染层（面板图标系统 · 方案甲「墨线」）。
 *
 * 从 utils/icons.ts 取字形路径，包成 <svg>。数据层（GLYPHS）只存路径、不依赖 Vue；
 * 本组件只负责渲染——分层不混杂。
 *
 * 着色走 currentColor：stroke / .f 填充都用 currentColor，图标随宿主的 `color` 着色——
 * 身份/状态图标（导航、分类、任务、徽章）由调用方给 color:var(--aide-accent) 显式标铜；
 * 内联控件（关闭/重置/警告/返回）则继承所在容器的语义色（muted/warning/danger…），
 * 不强加铜色。.k 子元素固定填底色，用于在铜块上刻反色细节（如已完成勾）。
 *
 * 渲染方式：把完整 <svg> 字符串经 v-html 注入 inline-flex 宿主 span，让 HTML 解析器
 * 在 SVG 命名空间外正确处理 <svg> 开始标签（WebView2 已验证）。
 */
import { computed } from "vue";
import { GLYPHS } from "@/utils/icons";

const props = withDefaults(
  defineProps<{
    /** 字形名，对应 GLYPHS 的 key（如 "general" / "task-run" / "bracket"） */
    name: string;
    /** px，正方形 */
    size?: number;
    /** 描边宽度，默认 1.3；方括号等需要更重的用 1.6 */
    strokeWidth?: number;
    /** 进行中态：呼吸动画（任务执行中铜点 task-run 用） */
    pulse?: boolean;
  }>(),
  { size: 16, strokeWidth: 1.3, pulse: false },
);

const html = computed(() => {
  const g = GLYPHS[props.name];
  if (!g) return "";
  const cls = `aide-icon${props.pulse ? " aide-icon--pulse" : ""}`;
  return `<svg class="${cls}" width="${props.size}" height="${props.size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${props.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${g}</svg>`;
});
</script>

<template>
  <span class="aide-icon-host" v-html="html" />
</template>

<style scoped>
.aide-icon-host {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  /* 内联场景（按钮内、徽章内、正文行内）与文字基线对齐；flex 场景里此声明无副作用 */
  vertical-align: middle;
}
.aide-icon-host :deep(.aide-icon) { display: block; }
.aide-icon-host :deep(.f) { fill: currentColor; stroke: none; }
/* .k = 在铜填充块上刻反色细节（如已完成勾）：深色描边线条，不填充 */
.aide-icon-host :deep(.k) { fill: none; stroke: var(--aide-bg-deep); }
.aide-icon-host :deep(.aide-icon--pulse) {
  animation: aide-icon-pulse 1.2s ease-in-out infinite;
}
@keyframes aide-icon-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@media (prefers-reduced-motion: reduce) {
  .aide-icon-host :deep(.aide-icon--pulse) { animation: none; }
}
</style>