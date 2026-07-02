<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref } from "vue";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

const props = defineProps<{ content: string; isError: boolean }>();
const containerRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue("--aide-bg-deep").trim() || "#1a1a22",
    foreground: style.getPropertyValue("--aide-text-primary").trim() || "#d8d4cf",
    cursor: style.getPropertyValue("--aide-accent").trim() || "#d4a574",
    selectionBackground: style.getPropertyValue("--aide-surface-active").trim() || "#44445a",
  };
}

onMounted(() => {
  if (!containerRef.value) return;
  terminal = new Terminal({
    rows: 10,
    cols: 80,
    theme: getThemeColors(),
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
