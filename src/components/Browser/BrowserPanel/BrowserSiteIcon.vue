<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "../../Icon.vue";

const props = defineProps<{ url: string; cached?: string; cacheState: "pending" | "ready" }>();
const failed = ref<string[]>([]);
const loaded = ref("");
const standard = computed(() => standardIcon(props.url));
const source = computed(() => {
  if (props.cached && !failed.value.includes(props.cached)) return props.cached;
  if (props.cacheState === "pending") return null;
  return standard.value && !failed.value.includes(standard.value) ? standard.value : null;
});

/** 只向网站自身取标准图标：不带页面路径、查询参数、凭据或第三方聚合服务。 */
function standardIcon(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return new URL("/favicon.ico", url.origin).href;
  } catch {
    return null; // 本地文件或无效地址没有可安全推导的站点图标。
  }
}
function imageFailed(event: Event): void {
  const url = event.currentTarget instanceof HTMLImageElement ? event.currentTarget.getAttribute("src") : null;
  if (url && !failed.value.includes(url)) failed.value.push(url);
}
function imageLoaded(event: Event): void {
  const url = event.currentTarget instanceof HTMLImageElement ? event.currentTarget.getAttribute("src") : null;
  if (url) loaded.value = url;
}
watch(() => props.url, () => { failed.value = []; loaded.value = ""; });
</script>

<template>
  <span class="browser-site-icon">
    <Icon v-if="!source || loaded !== source" name="globe" :size="19" />
    <img v-if="source" :key="source" :src="source" :class="{ 'is-loaded': loaded === source }" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @load="imageLoaded" @error="imageFailed">
  </span>
</template>

<style scoped>
.browser-site-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; }
.browser-site-icon img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; }
.browser-site-icon img.is-loaded { opacity: 1; }
</style>
