<script setup lang="ts">
/**
 * 「正在思考」的标记：Aide 图标里那条 A 字光带（去掉了图标的蓝紫底板），
 * 光带自己的颜色沿着 A 慢慢流转，再叠一道白光沿 A 跑，外圈辉光一明一暗。
 * 设计稿：https://claude.ai/artifact/QJVU3ER2pRju16hqY6uH64（D2 彩光流转）。
 *
 * 做法：两张图——光带本身（彩色、透明底）和光带的形状遮罩。转动的圆锥渐变用遮罩抠出来，
 * 所以光只落在光带上：色谱层用 `mix-blend-mode: color` 只换色相、保留光带原本的明暗，
 * 白光层直接叠上去。配色走主题槽位（--aide-logo-*）。
 * 尺寸 = 父层给的 size（px），里面一律按比例，系统开了「减少动态效果」就停在静态光带。
 */
import { computed } from "vue";
import ribbonUrl from "/aide-ribbon.png";
import ribbonMaskUrl from "/aide-ribbon-mask.png";

const props = withDefaults(defineProps<{ size?: number }>(), { size: 16 });

const rootStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  "--tm-mask": `url("${ribbonMaskUrl}")`,
}));
</script>

<template>
  <span class="tm" :style="rootStyle" aria-hidden="true">
    <img class="tm-ribbon" :src="ribbonUrl" alt="" draggable="false" />
    <span class="tm-flow tm-flow--hue"><i /></span>
    <span class="tm-flow tm-flow--streak"><i /></span>
  </span>
</template>

<style scoped>
.tm {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  animation: tm-glow 1.8s ease-in-out infinite;
}
.tm-ribbon {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  user-select: none;
}
.tm-flow {
  position: absolute;
  inset: 0;
  overflow: hidden;
  -webkit-mask: var(--tm-mask) center / 100% 100% no-repeat;
  mask: var(--tm-mask) center / 100% 100% no-repeat;
}
.tm-flow i {
  position: absolute;
  inset: -50%;
  animation: tm-spin 1.8s linear infinite;
}
.tm-flow--hue {
  mix-blend-mode: color;
  opacity: 0.9;
}
.tm-flow--hue i {
  background: var(--aide-logo-spectrum);
  animation-duration: 3.2s;
}
.tm-flow--streak i {
  background: var(--aide-logo-streak);
}

@keyframes tm-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes tm-glow {
  0%,
  100% {
    filter: drop-shadow(0 0 1px var(--aide-logo-glow-warm));
  }
  50% {
    filter: drop-shadow(0 0 2.5px var(--aide-logo-glow-cool));
  }
}

@media (prefers-reduced-motion: reduce) {
  .tm,
  .tm-flow i {
    animation: none;
  }
}
</style>
