<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref, nextTick } from "vue";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { buildXtermTheme } from "../utils/xterm";
import { themes } from "../themes";
import { useSettings } from "../composables/useSettings";

const props = defineProps<{ content: string; isError: boolean }>();
const containerRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;

const { settings } = useSettings();

onMounted(() => {
  if (!containerRef.value) return;
  terminal = new Terminal({
    rows: 10,
    cols: 80,
    theme: buildXtermTheme(themes[settings.theme] || themes["warm-dark"]),
    scrollback: 1000,
    disableStdin: true,
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Consolas', monospace",
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
  if (terminal) terminal.options.theme = buildXtermTheme(themes[settings.theme] || themes["warm-dark"]);
});
</script>

<template>
  <div ref="containerRef" class="bash-output" />
</template>

<style>
/* 非 scoped：xterm 动态 DOM 需要全局样式 */
.bash-output { height: 160px; width: 100%; border-radius: 3px; }
.bash-output .xterm { height: 100% !important; }
.bash-output .xterm-viewport { overflow-y: auto !important; }
</style>
