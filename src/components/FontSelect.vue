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

/** 候选等宽字体（探测本机已安装的，只显示装了的）。Inter Variable 是内置
 *  UI 字体（@fontsource 打包），界面字体想恢复 Inter 风格可选中它。 */
const CANDIDATES = [
  "JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas",
  "Menlo", "Monaco", "Source Code Pro", "IBM Plex Mono",
  "DejaVu Sans Mono", "Noto Sans Mono", "Sarasa Mono SC",
  "Sarasa Term SC", "Maple Mono", "Maple Mono SC NF", "Hack",
  "Ubuntu Mono", "Cascadia Mono", "Cousine", "Liberation Mono",
  "Inter Variable",
];

/** 选中字体时存储的栈：尾部垫 CJK 回退，否则西文 mono 无中文字形，
 *  Windows 中文落宋体（与 utils/fonts.ts MONO_FONT_STACK 同策略）。 */
const CJK_FALLBACK = "'PingFang SC', 'Microsoft YaHei', monospace";

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

async function isInstalled(name: string): Promise<boolean> {
  try {
    const faces = await document.fonts.load(`16px "${name}"`);
    return faces.length > 0;
  } catch {
    return false;
  }
}

/** 解析 font-family 栈 → 第一个本机已安装的字体名（跳过 generic 关键字） */
async function firstAvailable(stack: string): Promise<string | null> {
  const names = stack
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter((n) => n && !["monospace", "sans-serif", "serif"].includes(n));
  for (const n of names) {
    if (await isInstalled(n)) return n;
  }
  return null;
}

async function syncFromModel() {
  const current = await firstAvailable(props.modelValue);
  if (current) {
    // 当前字体不在候选列表（用户自定义过）→ 动态补进下拉框
    if (!installedFonts.value.includes(current)) {
      installedFonts.value = [...installedFonts.value, current];
    }
    selectedValue.value = current;
  } else {
    selectedValue.value = "__custom__";
    customValue.value = props.modelValue || "";
  }
}

onMounted(async () => {
  const installed: string[] = [];
  for (const name of CANDIDATES) {
    if (await isInstalled(name)) installed.push(name);
  }
  installedFonts.value = installed;
  await syncFromModel();
});

// 外部改值（如 load 完成）→ 重新解析选中项
watch(() => props.modelValue, syncFromModel);

// 用户在下拉框选择 → 落盘（选中字体时垫 CJK 回退；选"自定义…"等输入）
watch(selectedValue, (v) => {
  if (v === "__custom__") {
    customValue.value = props.modelValue || "";
    return;
  }
  emit("update:modelValue", `'${v}', ${CJK_FALLBACK}`);
});

function onCustomInput() {
  const v = customValue.value.trim();
  if (!v) return;
  // 单字体名（无逗号）→ 垫 CJK 回退；完整栈 → 原样
  const clean = v.replace(/^['"]|['"]$/g, "");
  emit("update:modelValue", v.includes(",") ? v : `'${clean}', ${CJK_FALLBACK}`);
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
