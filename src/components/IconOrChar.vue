<script setup lang="ts">
/**
 * 数据驱动图标的兼容渲染：值是 GLYPHS key 时渲染 <Icon>，否则原样输出字符串。
 *
 * 用于 icon 字段可被用户/外部插件填入任意值的场景——
 *   · provider 图标：用户旧数据是 emoji，新数据是字形 key（如 "provider"）
 *   · 搜索结果 icon：内置 provider 发 key，第三方插件可能仍发 emoji
 *   · 下拉项 icon：来源不定
 * 是 key 走铜线 <Icon>，不是 key 退回原字符串（emoji 按平台渲染），既纳入铜系统又不破坏存量。
 */
import { computed } from "vue";
import Icon from "./Icon.vue";
import { hasGlyph } from "@/utils/icons";

const props = withDefaults(
  defineProps<{
    /** icon 值：字形 key 或任意字符串（emoji/字符） */
    text: string | undefined;
    /** 渲染为 <Icon> 时的尺寸 px */
    size?: number;
  }>(),
  { size: 15 },
);

const isGlyph = computed(() => !!props.text && hasGlyph(props.text));
</script>

<template>
  <Icon v-if="isGlyph" :name="(text as string)" :size="size" />
  <span v-else class="aide-iconchar">{{ text }}</span>
</template>

<style scoped>
/* 原样输出时，字号/颜色由外层槽控制（emoji 不吃 color，吃 font-size） */
.aide-iconchar {
  line-height: 1;
  white-space: nowrap;
}
</style>