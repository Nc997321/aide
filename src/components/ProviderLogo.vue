<script setup lang="ts">
/**
 * 供应商"头像"渲染：预置 kind 有品牌商标时渲染彩色小商标，否则回退
 * IconOrChar（Custom 的字形 / 存量字母、emoji 数据）。
 *
 * 分层：品牌商标是 UI 层关注点，按 kind 静态映射（utils/providerLogos.ts），
 * 不依赖后端 catalog 的 icon 字段——catalog 字母仍是回退与 Custom 的数据源。
 * 合规：商标仅用于指代接入该厂商官方端点（指示性合理使用），不改图形。
 */
import { computed } from "vue";
import IconOrChar from "./IconOrChar.vue";
import { providerLogo } from "@/utils/providerLogos";

const props = withDefaults(
  defineProps<{
    /** 供应商 kind：有品牌商标的预置 kind 或任意值（custom 等） */
    kind: string;
    /** 回退值：catalog icon 字段（字母/emoji）或字形 key */
    text?: string;
    /** 渲染尺寸 px */
    size?: number;
  }>(),
  { text: undefined, size: 16 },
);

const logo = computed(() => providerLogo(props.kind));
</script>

<template>
  <svg
    v-if="logo"
    class="aide-provider-logo"
    :class="{ 'aide-provider-logo--mono': logo.mono }"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    role="img"
    aria-hidden="true"
  >
    <path :d="logo.path" :fill="logo.mono ? 'currentColor' : logo.color" />
  </svg>
  <IconOrChar v-else :text="text" :size="size" />
</template>

<style scoped>
.aide-provider-logo {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
}

/* 纯黑品牌 mark（Ollama / Kimi）：随主题前景色，浅色黑、深色白 */
.aide-provider-logo--mono {
  color: var(--aide-text-primary);
}
</style>
