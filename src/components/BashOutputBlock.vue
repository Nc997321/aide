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
});

onBeforeUnmount(() => {
  terminal?.dispose();
});

watch(() => props.content, (val) => {
  terminal?.clear();
  terminal?.write(val.replace(/\n/g, "\r\n"));
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

/* 头部小标签行：GALLERY .bo-head */
.bash-output::before {
  content: '▸ bash';
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  padding: 6px 12px;
  font-size: 10.5px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-base);
  border-bottom: 1px solid var(--aide-border-subtle);
  letter-spacing: .06em;
  text-transform: uppercase;
  font-weight: 600;
}

.bash-output::after {
  content: 'exit 0';
  display: flex;
  align-items: center;
  padding: 6px 12px;
  font-size: 10.5px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-base);
  border-bottom: 1px solid var(--aide-border-subtle);
  letter-spacing: .06em;
  text-transform: uppercase;
  font-weight: 600;
}

.bash-output.is-error::after {
  content: 'exit 1';
}

.bash-output .xterm {
  width: 100% !important;
  height: calc(100% - 27px) !important;
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
