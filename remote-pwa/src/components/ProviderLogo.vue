<script setup lang="ts">
/**
 * 供应商图标（远程版）：品牌商标走 SDK providerLogos（与桌面同库、同 kind
 * 映射——智谱/DeepSeek/Kimi/Qwen/Ollama/Anthropic 等）；无商标回退 icon
 * 字符（字母/emoji ≤2 字符直接显示，字形 key 等长值 → ⬡）。桌面回退走
 * IconOrChar 铜线图标，PWA 没有那套资产，用字符近似。
 *
 * mono 商标（Ollama/Kimi 官方纯黑 mark）fill=currentColor：跟随所在文字色
 * （顶栏 pill 灰、抽屉徽标主题色），浅底深字、深底浅字自适应。
 */
import { computed } from "vue";
import { providerLogo } from "@aide/sdk/utils/providerLogos";

const props = withDefaults(
  defineProps<{
    /** 供应商 kind：有品牌商标的预置 kind 或任意值（custom 等） */
    kind: string;
    /** 回退值：catalog icon 字段（字母/emoji）或字形 key */
    icon?: string;
    /** 渲染尺寸 px */
    size?: number;
  }>(),
  { icon: undefined, size: 16 },
);

const logo = computed(() => providerLogo(props.kind));
const glyph = computed(() => (props.icon && props.icon.length <= 2 ? props.icon : "⬡"));
</script>

<template>
  <svg
    v-if="logo"
    class="pl-svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    role="img"
    aria-hidden="true"
  >
    <path :d="logo.path" :fill="logo.mono ? 'currentColor' : logo.color" />
  </svg>
  <span v-else class="pl-glyph" :style="{ fontSize: Math.round(size * 0.88) + 'px' }">{{ glyph }}</span>
</template>

<style scoped>
.pl-svg {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
}
.pl-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  white-space: nowrap;
}
</style>
