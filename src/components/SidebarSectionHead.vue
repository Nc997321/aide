<script setup lang="ts">
/** 侧栏分区的大导航行（WorkBuddy 式）：
 *  chevron 旋转 + SVG 图标（icon slot）+ 13.5px 标签 + 可选呼吸点
 *  + 右槽位「计数 ⇄ ⋯」——常态显示计数，hover 淡出计数淡入 ⋯，
 *  点 ⋯ emit menu 事件（父级用 useContextMenu 弹分区菜单，与右键体系同一份）。
 *  会话/自动化分区共用，保证视觉与交互完全一致。 */
defineProps<{
  label: string;
  count?: number;
  /** 有活跃活动（运行中任务等）时亮呼吸点 */
  live?: boolean;
  liveTitle?: string;
  expanded: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  /** 点击右槽位 ⋯：携带 MouseEvent 供父级定位上下文菜单 */
  menu: [e: MouseEvent];
}>();
</script>

<template>
  <div class="sec-head" @click="emit('toggle')">
    <svg class="chevron" :class="{ expanded }" width="13" height="13" viewBox="0 0 12 12" fill="none">
      <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="sec-ico"><slot name="icon" /></span>
    <span class="sec-label">{{ label }}</span>
    <span v-if="live" class="live-dot" v-tooltip="liveTitle ?? ''" />
    <span class="sec-slot" @click.stop>
      <span v-if="count !== undefined" class="sec-count">{{ count }}</span>
      <button class="sec-dots" v-tooltip="'更多操作'" @click="emit('menu', $event)">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
      </button>
    </span>
  </div>
</template>

<style scoped>
.sec-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin: 6px 10px 2px;
  cursor: pointer;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--aide-text-secondary);
  border: 1px solid transparent;
  border-radius: var(--aide-radius-lg);
  transition: all var(--aide-ease-t);
  user-select: none;
}
.sec-head:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.2s ease;
}
.chevron.expanded {
  transform: rotate(90deg);
  color: var(--aide-accent);
}

.sec-ico {
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: color var(--aide-ease-t);
}
.sec-head:hover .sec-ico {
  color: var(--aide-text-secondary);
}
/* slot 里 SVG 的统一尺寸（使用方传 24 viewBox 的描边图标） */
.sec-ico :deep(svg) {
  width: 17px;
  height: 17px;
}

.sec-label {
  letter-spacing: 0.3px;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-info);
  animation: sec-pulse 1.2s infinite;
  flex-shrink: 0;
}
@keyframes sec-pulse {
  50% {
    opacity: 0.35;
  }
}

/* 右槽位：计数 ⇄ ⋯（同一位互换，hover 整行触发）。
   计数流内撑开槽位（3 位以上计数不溢出）；⋯ absolute 覆盖同一区域，
   hover 互换时槽位宽度不变、布局不抖。 */
.sec-slot {
  position: relative;
  flex-shrink: 0;
  margin-left: auto;
  display: flex;
  align-items: center;
  /* 无计数时（0 会话/0 任务）槽位没有流内内容会塌成 0×0，absolute 的 ⋯
     只剩半颗悬在行外、hover 底色与 tooltip 锚点全无；地板与 .sec-count 对齐 */
  min-width: 26px;
}
.sec-count {
  min-width: 26px;
  box-sizing: border-box;
  text-align: center;
  padding: 2px 8px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  border-radius: 9px;
  transition: opacity 0.12s;
}
.sec-dots {
  position: absolute;
  /* 垂直方向不能依赖槽位高度：无计数时槽位 0 高，inset:0 会把按钮压成
     0 高、网格轨道从槽位顶边起排，图标整体偏下半颗身位；
     横向铺满槽位 + 固定高度 + 中线变换，槽位有无内容都锁定行中线 */
  left: 0;
  right: 0;
  top: 50%;
  height: 22px;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
}
.sec-dots svg {
  width: 15px;
  height: 15px;
}
.sec-head:hover .sec-count {
  opacity: 0;
}
.sec-head:hover .sec-dots {
  opacity: 1;
}
.sec-dots:hover {
  background: var(--aide-surface-active);
  color: var(--aide-text-primary);
}
</style>
