<script setup lang="ts">
import { computed } from "vue";
import { useFileViewer, isWindowDirty } from "../composables/useFileViewer";
import FileWindow from "./fileviewer/FileWindow.vue";

/**
 * 文件窗口管理层（Windows 任务视图式）。单窗口渲染在 fileviewer/FileWindow.vue。
 *
 * 挂载在 App.vue 的 .panel-center 内（绝对定位），只覆盖聊天区——
 * 左侧会话栏和右侧文件树始终可见可点，可以连续从文件树开多个文件。
 *
 * 两种布局：
 * - 平铺全览（focusedId 为 null）：所有窗口按 ⌈√n⌉ 列的网格平均分格，
 *   窗口随数量增多而变小；单窗口时即默认弹窗大小居中。
 * - 聚焦：点某个平铺窗口 → 它恢复默认弹窗大小居中，其余缩成底部小条；
 *   点小条切换聚焦，「平铺全部」回到全览。
 */

const { windows, focusedId, focusWindow, unfocus } = useFileViewer();

const focusedWin = computed(() => windows.value.find((w) => w.id === focusedId.value) ?? null);
const stripWins = computed(() => windows.value.filter((w) => w.id !== focusedId.value));
const gridCols = computed(() => Math.ceil(Math.sqrt(windows.value.length)));

/** 平铺格里点到非交互空隙以外的窗口（多窗时）→ 聚焦它。capture 阶段拦截，
 *  避免这一下点击顺带落进编辑器改了光标位置。 */
function onGridCellMousedown(e: MouseEvent, id: string) {
  if (windows.value.length <= 1) return;
  e.preventDefault();
  e.stopPropagation();
  focusWindow(id);
}
</script>

<template>
  <div v-if="windows.length" class="fv-layer">
    <!-- 平铺全览 -->
    <div
      v-if="!focusedWin"
      class="fv-grid"
      :class="{ 'fv-grid--single': windows.length === 1 }"
      :style="{ '--fv-cols': gridCols }"
    >
      <div
        v-for="w in windows"
        :key="w.id"
        class="fv-cell"
        :class="{ 'fv-cell--thumb': windows.length > 1 }"
        @mousedown.capture="onGridCellMousedown($event, w.id)"
      >
        <FileWindow :win="w" />
      </div>
    </div>

    <!-- 聚焦模式 -->
    <template v-else>
      <div class="fv-focused">
        <FileWindow :win="focusedWin" />
      </div>
      <div v-if="stripWins.length" class="fv-strip">
        <div
          v-for="w in stripWins"
          :key="w.id"
          class="fv-strip-tile"
          v-tooltip="w.filePath"
          @click="focusWindow(w.id)"
        >
          <span v-if="isWindowDirty(w)" class="fv-strip-dirty">●</span>
          <span class="fv-strip-name">{{ w.fileName }}</span>
        </div>
        <div class="fv-strip-tile fv-strip-tile--restore" @click="unfocus()">⊞ 平铺全部</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fv-layer {
  position: absolute;
  inset: 0;
  z-index: 40;
  pointer-events: none;
}

/* ── 平铺全览 ── */

.fv-grid {
  display: grid;
  height: 100%;
  padding: 14px;
  gap: 12px;
  grid-template-columns: repeat(var(--fv-cols), minmax(0, 1fr));
  grid-auto-rows: minmax(0, 1fr);
}

.fv-grid--single {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.fv-grid--single .fv-cell {
  width: min(94%, 900px);
  height: 96%;
}

.fv-cell {
  pointer-events: auto;
  min-width: 0;
  min-height: 0;
  animation: fv-scale-in 0.15s ease;
}

/* 多窗平铺时是"缩略窗"：悬停浮起提示可点 */
.fv-cell--thumb {
  cursor: pointer;
  transition: transform 0.15s ease;
}

.fv-cell--thumb:hover {
  transform: scale(1.015);
}

@keyframes fv-scale-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}

/* ── 聚焦模式 ── */

.fv-focused {
  position: absolute;
  left: 50%;
  top: calc(50% - 26px);
  transform: translate(-50%, -50%);
  width: min(92%, 900px);
  height: calc(96% - 52px);
  pointer-events: auto;
  animation: fv-scale-in 0.15s ease;
}

.fv-strip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 8px;
  display: flex;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  overflow-x: auto;
  pointer-events: auto;
}

.fv-strip-tile {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 200px;
  padding: 6px 12px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  box-shadow: var(--aide-shadow-sm);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.12s;
}

.fv-strip-tile:hover {
  background: var(--aide-surface-hover);
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
}

.fv-strip-dirty {
  color: var(--aide-warning);
  font-size: 10px;
  flex-shrink: 0;
}

.fv-strip-name {
  font-size: 12px;
  color: var(--aide-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fv-strip-tile:hover .fv-strip-name {
  color: var(--aide-text-primary);
}

.fv-strip-tile--restore .fv-strip-name,
.fv-strip-tile--restore {
  color: var(--aide-text-muted);
  font-size: 12px;
}
</style>
