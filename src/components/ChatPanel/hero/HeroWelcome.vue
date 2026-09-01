<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { chimeForDate, pickHeroCopy } from "./heroCopy";
import type { WorkspaceInfo } from "@/types";
import VariantMorning from "./VariantMorning.vue";
import type { HeroViewProps } from "./types";

const props = defineProps<{
  workspacePath: string;
  modelName: string;
}>();

const emit = defineEmits<{
  "select-workspace": [ws: WorkspaceInfo];
}>();

const viewProps = computed<HeroViewProps>(() => ({
  chime: chime.value,
  copy,
  workspacePath: props.workspacePath,
  modelName: props.modelName || "默认模型",
}));

// ── 时间问候：挂载即算，每 60s 刷新时钟/日期，跨时段问候自动翻新
//    （chimeForDate 是确定性纯函数，喂新时间即得新时段；F2：卸载清理）──
const now = ref(new Date());
const chime = computed(() => chimeForDate(now.value));

const chimeTimer = window.setInterval(() => {
  now.value = new Date();
}, 60_000);
onUnmounted(() => window.clearInterval(chimeTimer));

// ── 行动文案：每次进入欢迎页（挂载）轮换一条 ──────────────────────────
const copy = pickHeroCopy(Math.floor(Math.random() * 10_000));
</script>

<template>
  <VariantMorning
    v-bind="viewProps"
    @select-workspace="(ws: WorkspaceInfo) => emit('select-workspace', ws)"
  />
</template>
