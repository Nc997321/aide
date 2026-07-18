<script setup lang="ts">
/**
 * 品牌标 AppLogo：四条 3D 弯曲缎带。
 * animated=false：静态 SVG（标题栏/关于页）。animated=true：「流光」——
 * conic-gradient 在带形 mask 下流转（思考状态行），纯 CSS 合成线程动画。
 * 商标源文件到位后替换缎带 path 与 --app-logo-mask 即可，动画不变。
 */
withDefaults(
  defineProps<{
    size?: number;
    animated?: boolean;
    /** 工具执行中加速流转（预留） */
    fast?: boolean;
  }>(),
  { size: 18, animated: false, fast: false },
);
</script>

<template>
  <span
    v-if="animated"
    class="app-logo-flow"
    :class="{ 'app-logo-flow--fast': fast }"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  />
  <svg v-else class="app-logo" :width="size" :height="size" viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <linearGradient id="app-logo-g1" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#f472b6"/><stop offset="1" stop-color="#d946ef"/></linearGradient>
      <linearGradient id="app-logo-g2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#06b6d4"/></linearGradient>
      <linearGradient id="app-logo-g3" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>
      <linearGradient id="app-logo-g4" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#93c5fd"/><stop offset="1" stop-color="#4f46e5"/></linearGradient>
    </defs>
    <g fill="none" stroke-linecap="round" stroke-width="13.5">
      <path d="M21 42.2A30 30 0 0 1 42.2 21" stroke="url(#app-logo-g1)"/>
      <path d="M57.8 21A30 30 0 0 1 79 42.2" stroke="url(#app-logo-g2)"/>
      <path d="M79 57.8A30 30 0 0 1 57.8 79" stroke="url(#app-logo-g3)"/>
      <path d="M42.2 79A30 30 0 0 1 21 57.8" stroke="url(#app-logo-g4)"/>
    </g>
    <g fill="none" stroke="rgba(255,255,255,.32)" stroke-linecap="round" stroke-width="4">
      <path d="M24.9 43.3A26 26 0 0 1 43.3 24.9"/>
      <path d="M56.7 24.9A26 26 0 0 1 75.1 43.3"/>
      <path d="M75.1 56.7A26 26 0 0 1 56.7 75.1"/>
      <path d="M43.3 75.1A26 26 0 0 1 24.9 56.7"/>
    </g>
  </svg>
</template>

<style>
/* 流光动画是全局 mask + @property 单例，放非 scoped（多实例共用一份） */
@property --app-logo-angle { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
:root {
  --app-logo-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cg fill='none' stroke='white' stroke-width='14' stroke-linecap='round'%3E%3Cpath d='M21 42.2A30 30 0 0 1 42.2 21'/%3E%3Cpath d='M57.8 21A30 30 0 0 1 79 42.2'/%3E%3Cpath d='M79 57.8A30 30 0 0 1 57.8 79'/%3E%3Cpath d='M42.2 79A30 30 0 0 1 21 57.8'/%3E%3C/g%3E%3C/svg%3E");
}
.app-logo-flow {
  display: inline-block;
  flex-shrink: 0;
  background: conic-gradient(from var(--app-logo-angle), #f472b6, #22d3ee, #c084fc, #60a5fa, #f472b6);
  -webkit-mask: var(--app-logo-mask) center / contain no-repeat;
  mask: var(--app-logo-mask) center / contain no-repeat;
  animation: app-logo-flow 2.6s linear infinite;
}
.app-logo-flow--fast { animation-duration: 1.1s; }
@keyframes app-logo-flow { to { --app-logo-angle: 360deg; } }
@media (prefers-reduced-motion: reduce) {
  .app-logo-flow { animation: none; }
}
</style>
