<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { chimeForDate, pickHeroCopy } from "./heroCopy";
import type { ChatMode } from "../modes";
import type { WorkspaceInfo } from "@/types";
import VariantMorning from "./VariantMorning.vue";
import type { HeroViewProps } from "./types";
import type { Session } from "@/types";
import { loadLastDailySession } from "./lastSession";
import { useSessionNames } from "@/composables/useSessionNames";
import { timeAgo } from "@/utils/time";

const props = defineProps<{
  mode: ChatMode;
  workspacePath: string;
  modelName: string;
}>();

const emit = defineEmits<{
  "select-workspace": [ws: WorkspaceInfo];
  "select-mode": [mode: ChatMode];
  /** 「接着上次」被点：打开那场会话（打开语义由布局层裁决） */
  "open-session": [sessionId: string];
}>();

const viewProps = computed<HeroViewProps>(() => ({
  chime: chime.value,
  copy: copy.value,
  mode: props.mode,
  workspacePath: props.workspacePath,
  modelName: props.modelName || "默认模型",
  resume: resume.value,
}));

// ── 时间问候：挂载即算，每 60s 刷新时钟/日期，跨时段问候自动翻新
//    （chimeForDate 是确定性纯函数，喂新时间即得新时段；F2：卸载清理）──
const now = ref(new Date());
const chime = computed(() => chimeForDate(now.value));

const chimeTimer = window.setInterval(() => {
  now.value = new Date();
}, 60_000);
onUnmounted(() => window.clearInterval(chimeTimer));

// ── 接着上次：进入日常欢迎页时取最近一场日常对话；改过名的以改后的为准，
//    「多久前」跟着上面的时钟一起走 ──
const sessionNames = useSessionNames();
const lastSession = ref<Session | null>(null);
watch(
  () => props.mode,
  async (mode) => {
    lastSession.value = null;
    if (mode !== "daily") return;
    const found = await loadLastDailySession();
    if (props.mode === "daily") lastSession.value = found;
  },
  { immediate: true },
);
const resume = computed(() => {
  const s = lastSession.value;
  if (!s) return null;
  void now.value; // 依赖时钟：每分钟重算「多久前」
  return { sessionId: s.id, title: sessionNames.names[s.id] || s.name, ago: timeAgo(s.timestamp) };
});

// ── 行动文案：每次进入欢迎页（挂载）轮换一条；切模式重掷 —— 否则切过去还顶着
//    上一个模式的文案语义（池子是按模式分的）──────────────────────────
const seed = ref(Math.floor(Math.random() * 10_000));
const copy = computed(() => pickHeroCopy(props.mode, seed.value));
watch(
  () => props.mode,
  () => {
    seed.value = Math.floor(Math.random() * 10_000);
  },
);
</script>

<template>
  <VariantMorning
    v-bind="viewProps"
    @select-workspace="(ws: WorkspaceInfo) => emit('select-workspace', ws)"
    @select-mode="(m: ChatMode) => emit('select-mode', m)"
    @open-session="(sid: string) => emit('open-session', sid)"
  />
</template>
