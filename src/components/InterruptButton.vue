<script setup lang="ts">
/**
 * InterruptButton —— 声波停止钮（零文字纯图标）。
 *
 * 三根声波柱跳动 = 「正在输出」；hover 时两侧柱收起、中柱 morph 成停止方块——
 * 形态转换即语义转换。语义由 aria-label + tooltip 承载。
 * 全配色 var(--aide-danger) + color-mix 派生，四主题自适应；reduced-motion 关跳动。
 * 设计原型（方案 F）：docs/superpowers/design-previews/2026-08-09-interrupt-button.html
 *
 * 布局（margin 等定位）归父级：class 透传到根 button；click 同样透传，
 * 父级直接 @click 监听即可。
 */
</script>

<template>
  <button type="button" class="interrupt-btn" v-tooltip="'中断'" aria-label="中断">
    <i class="w1" aria-hidden="true"></i><i class="w2" aria-hidden="true"></i><i class="w3" aria-hidden="true"></i>
  </button>
</template>

<style scoped>
.interrupt-btn {
  flex-shrink: 0;
  width: 21px;
  height: 21px;
  padding: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--aide-danger) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-danger) 28%, transparent);
  box-shadow: var(--aide-highlight-inset);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1.5px;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.interrupt-btn i {
  display: block;
  width: 2px;
  border-radius: 1px;
  background: var(--aide-danger);
  transition: all 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.interrupt-btn .w1 { height: 5px; animation: interrupt-wave 0.9s ease-in-out infinite; }
.interrupt-btn .w2 { height: 9px; animation: interrupt-wave 0.9s 0.15s ease-in-out infinite; }
.interrupt-btn .w3 { height: 6px; animation: interrupt-wave 0.9s 0.3s ease-in-out infinite; }

@keyframes interrupt-wave {
  0%, 100% { transform: scaleY(0.4); }
  50% { transform: scaleY(1); }
}

/* hover：两侧声柱收起、中柱 morph 成停止方块 */
.interrupt-btn:hover {
  gap: 0;
  background: color-mix(in srgb, var(--aide-danger) 15%, transparent);
  border-color: color-mix(in srgb, var(--aide-danger) 55%, transparent);
  box-shadow: var(--aide-highlight-inset),
    0 0 14px color-mix(in srgb, var(--aide-danger) 28%, transparent);
}

.interrupt-btn:hover i {
  animation: none;
}

.interrupt-btn:hover .w1,
.interrupt-btn:hover .w3 {
  width: 0;
  transform: scaleY(0);
  opacity: 0;
}

.interrupt-btn:hover .w2 {
  width: 6.5px;
  height: 6.5px;
  border-radius: 2px;
  transform: none;
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-danger) 50%, transparent);
}

.interrupt-btn:active {
  transform: scale(0.9);
}

.interrupt-btn:focus-visible {
  outline: none;
  box-shadow: var(--aide-highlight-inset),
    0 0 0 2.5px color-mix(in srgb, var(--aide-danger) 38%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .interrupt-btn i {
    animation: none;
  }
}
</style>
