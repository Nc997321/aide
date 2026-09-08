<template>
  <div class="font-select">
    <ThemedSelect v-model="selectedValue" :options="options" block />
    <input
      v-if="selectedValue === '__custom__'"
      v-model="customValue"
      class="custom-input"
      placeholder="输入字体名或 font-family 栈，如 Sarasa Mono SC"
      @input="onCustomInput"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import ThemedSelect from "./ThemedSelect.vue";
import {
  isFontInstalled,
  CJK_MONO_FALLBACK,
  type FontMeasurer,
} from "@aide/sdk/utils/fonts";

/** 候选等宽字体（探测本机已安装的，只显示装了的）。Inter Variable 是内置
 *  UI 字体（@fontsource 打包），界面字体想恢复 Inter 风格可选中它。
 *  Maple Mono v7 家族名（v6 的 "SC NF" 已废弃）：CN=中文版，NF=Nerd Font 图标。 */
const CANDIDATES = [
  "JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas",
  "Menlo", "Monaco", "Source Code Pro", "IBM Plex Mono",
  "DejaVu Sans Mono", "Noto Sans Mono", "Sarasa Mono SC",
  "Sarasa Term SC", "Maple Mono", "Maple Mono CN", "Maple Mono NF CN", "Hack",
  "Ubuntu Mono", "Cascadia Mono", "Cousine", "Liberation Mono",
  "Inter Variable",
];

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

const installedFonts = ref<string[]>([]);
/** ThemedSelect 选中值：字体名 或 "__custom__"（自定义…） */
const selectedValue = ref<string>("__custom__");
const customValue = ref("");

const options = computed(() => [
  ...installedFonts.value.map((f) => ({ value: f, label: f })),
  { value: "__custom__", label: "自定义…" },
]);

/** 本组件写入的栈的定形（canonical form）。选中态解析只认它：自定义栈的
 *  CJK 回退尾（YaHei 等）按设计就是本机已装字体，走栈探测分不出「选了
 *  候选」还是「随便一个栈」——walk 栈会总命中 YaHei，把打字回写成整栈。 */
function storedStack(name: string): string {
  return `'${name}', ${CJK_MONO_FALLBACK}`;
}

// canvas 只读排版度量、不渲染。jsdom / 无 canvas 环境 getContext 返回 null，
// 探测降级为「全部未装」——只少候选列表，自定义输入等其余功能不受影响。
// ctx 缓存收在组件实例作用域（undefined=未探测过），不做模块级单例。
let measureCtx: CanvasRenderingContext2D | null | undefined;
const measure: FontMeasurer = (fontSpec, text) => {
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return 0;
  measureCtx.font = fontSpec;
  return measureCtx.measureText(text).width;
};

/** 从持久化值解析选中项：候选的定形 → 该字体名；其余（默认栈 / 遗留配置 /
 *  自定义栈）→ null，落「自定义…」。 */
function resolveSelection(value: string): string | null {
  return installedFonts.value.find((n) => value === storedStack(n)) ?? null;
}

function syncFromModel() {
  const found = resolveSelection(props.modelValue);
  if (found) {
    selectedValue.value = found;
    return;
  }
  selectedValue.value = "__custom__";
  customValue.value = props.modelValue || "";
}

onMounted(() => {
  installedFonts.value = CANDIDATES.filter((n) => isFontInstalled(n, measure));
  syncFromModel();
});

// v-model 回环：本地 emit 的值回灌 prop 会再触发本 watcher。跳过自己刚发
// 出去的值，否则自定义输入打一个字符就被回写成整栈；外部改动照常同步。
let lastEmitted: string | null = null;
watch(() => props.modelValue, () => {
  if (lastEmitted !== null && props.modelValue === lastEmitted) {
    lastEmitted = null;
    return;
  }
  // 非匹配分支也清令牌：乱序/迟到的回灌不至于吞掉后续外部改动，收敛为幂等 re-sync
  lastEmitted = null;
  syncFromModel();
});

// 用户在下拉框选择 → 落盘（选中字体时垫 CJK 回退；选"自定义…"等输入）
watch(selectedValue, (v) => {
  if (v === "__custom__") {
    customValue.value = props.modelValue || "";
    return;
  }
  const stack = storedStack(v);
  if (stack === props.modelValue) return; // syncFromModel 的程序性回写（同值），不重发
  lastEmitted = stack;
  emit("update:modelValue", stack);
});

function onCustomInput() {
  const v = customValue.value.trim();
  if (!v) return;
  // 单字体名（无逗号）→ 垫 CJK 回退；完整栈 → 原样
  const clean = v.replace(/^['"]|['"]$/g, "");
  const out = v.includes(",") ? v : `'${clean}', ${CJK_MONO_FALLBACK}`;
  lastEmitted = out;
  emit("update:modelValue", out);
}
</script>

<style scoped>
.font-select {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 与 SettingsPanel .text-input 同款（scoped 不跨组件，自带一份） */
.custom-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}
.custom-input::placeholder {
  color: var(--aide-text-muted);
}
.custom-input:focus {
  border-color: var(--aide-accent);
}
</style>
