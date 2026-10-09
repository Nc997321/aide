<script setup lang="ts">
/**
 * 文件类型图标：代码 / 文档类画成「实心色块 + 反色描边字形」徽标（与知识库同一笔法），
 * 其余走 24 格图形 path。文件树 / 变更列表 / 输入框引用芯片 / 知识库目录树共用，
 * 定义见 utils/fileIcons.ts。传 `name` 按文件名查，或直接传 `icon`。
 */
import { computed } from "vue";
import { getFileIcon, BADGE_TILE, type FileIconDef } from "@/utils/fileIcons";

const props = withDefaults(
  defineProps<{ name?: string; icon?: FileIconDef; size?: number }>(),
  { size: 15 },
);

const def = computed(() => props.icon ?? getFileIcon(props.name ?? ""));
</script>

<template>
  <svg
    v-if="def.badge"
    class="file-type-icon"
    :style="{ color: def.color }"
    :width="size" :height="size" viewBox="0 0 16 16" fill="none" aria-hidden="true"
  >
    <rect
      class="tone"
      :x="BADGE_TILE.x" :y="BADGE_TILE.y"
      :width="BADGE_TILE.size" :height="BADGE_TILE.size" :rx="BADGE_TILE.rx"
    />
    <path
      v-for="(s, i) in def.badge.strokes" :key="i"
      class="glyph"
      :d="s.d"
      :transform="s.dx || s.dy ? `translate(${s.dx} ${s.dy})` : undefined"
      :stroke-width="def.badge.width"
    />
  </svg>
  <svg
    v-else
    class="file-type-icon"
    :style="{ color: def.color }"
    :width="size" :height="size" viewBox="0 0 24 24" fill="none" aria-hidden="true"
  >
    <path :d="def.path" fill="currentColor" opacity="0.85" />
  </svg>
</template>

<style scoped>
.file-type-icon { flex-shrink: 0; }
.tone { fill: currentColor; }
.glyph {
  stroke: var(--aide-bg-deep);
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
