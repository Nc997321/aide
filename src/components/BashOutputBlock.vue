<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref, nextTick } from "vue";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { buildXtermTheme } from "../utils/xterm";
import { MONO_FONT_STACK } from "../utils/fonts";
import { windowsPtyConfig } from "../utils/platform";
import { useSettings } from "../composables/useSettings";

const props = defineProps<{ content: string; isError: boolean }>();
const containerRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;

const { settings } = useSettings();

onMounted(() => {
  if (!containerRef.value) return;
  const wpCfg = windowsPtyConfig();
  terminal = new Terminal({
    rows: 10,
    cols: 80,
    theme: buildXtermTheme(),
    scrollback: 1000,
    disableStdin: true,
    fontSize: 12,
    fontFamily: settings.terminalFontFamily || MONO_FONT_STACK,
    ...(wpCfg ? { windowsPty: wpCfg } : {}),
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(containerRef.value);
  fitAddon.fit();
  terminal.write(props.content.replace(/\n/g, "\r\n"));
  written = props.content; // 首写基线对齐，后续 watch 只判增量
});

onBeforeUnmount(() => {
  terminal?.dispose();
});

/** 已写入 xterm 的内容基线（增量判定的 SSOT；onMounted 的首次写入后与 props.content 对齐）。 */
let written = "";

// 输出变更：流式 stdout 是追加型——前缀未变时只把增量写入 xterm（成本 O(delta)），
// 不再 clear + 全量重写。逐条全量重写会让 xterm 对累计 buffer 整段重折行重渲染，
// 成本 O(累计) × delta 率 = 大输出命令（构建/安装日志）流式期主线程连续长任务
// （freeze-1788224842632 系列：160px 定高盒子外层尺寸不变，RO/滚动环零事件）。
// 前缀不匹配（revert/截断导致内容变短或整体替换）才退回 clear + 全量重写。
watch(() => props.content, (val) => {
  if (!terminal) return;
  if (val.startsWith(written)) {
    // 字符级替换（\n → \r\n）逐字符上下文无关、无切点边界效应，与整段替换等价
    terminal.write(val.slice(written.length).replace(/\n/g, "\r\n"));
    written = val;
    return;
  }
  terminal.clear();
  terminal.write(val.replace(/\n/g, "\r\n"));
  written = val;
});

watch(() => settings.theme, async () => {
  await nextTick();
  if (terminal) terminal.options.theme = buildXtermTheme();
});
</script>

<template>
  <div ref="containerRef" :class="['bash-output', { 'is-error': isError }]" />
</template>

<style>
/* 非 scoped：xterm 动态 DOM 需要全局样式 */
.bash-output {
  height: 160px;
  width: 100%;
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border-subtle);
  overflow: hidden;
  box-shadow: var(--aide-shadow-inset);
  display: flex;
  flex-wrap: wrap;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.bash-output .xterm {
  width: 100% !important;
  height: 100% !important;
}

.bash-output .xterm-viewport {
  overflow-y: auto !important;
}

/* ANSI 色 token 化（GALLERY） */
.ansi-g { color: var(--aide-success); }
.ansi-r { color: var(--aide-danger); }
.ansi-y { color: var(--aide-warning); }
.ansi-dim { color: var(--aide-text-muted); }
.ansi-c { color: var(--aide-info); }
</style>
