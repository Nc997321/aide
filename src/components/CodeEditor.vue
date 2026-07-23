<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { Compartment } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { useSettings } from "../composables/useSettings";
import { useModal } from "../composables/useModal";
import { themes } from "../themes";
import type { ThemeTokens } from "../themes/tokens";
import { createHighlightStyle } from "../utils/cmHighlight";
import { loadLanguageExtension } from "../utils/cmLanguage";
import { ctrlHoverHighlight } from "../extensions/cmCtrlHover";
import { cmScrollMemory, type ScrollMemoryOptions } from "../extensions/cmScrollMemory";

const { settings } = useSettings();

const props = defineProps<{
  filePath: string;
  modelValue: string;
  /** 滚动位置记忆（会话级）；不传则不记 */
  scrollMemory?: ScrollMemoryOptions;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "goto-definition", payload: { word: string; filePath: string; line: number }): void;
}>();

const mountEl = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
let createId = 0;

// Track editor readiness for async createEditor completion
let readyPromise = Promise.resolve();
let resolveReady: (() => void) | null = null;

// ── Language detection ──
const ext = computed(() => {
  const parts = props.filePath.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
});

const themeCompartment = new Compartment();

// ── Editor lifecycle ──

async function createEditor() {
  if (!mountEl.value) return;

  const id = ++createId; // capture before async work

  // Create fresh readiness promise for this invocation
  readyPromise = new Promise<void>(r => { resolveReady = r; });

  // Destroy existing instance
  if (view) {
    view.destroy();
    view = null;
  }

  const langExt = await loadLanguageExtension(ext.value);

  // Abort if a newer call has started
  if (id !== createId) return;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const newValue = update.state.doc.toString();
      emit("update:modelValue", newValue);
    }
  });

  view = new EditorView({
    doc: props.modelValue,
    extensions: [
      basicSetup,
      langExt,
      keymap.of([
        ...searchKeymap,
        { key: "Mod-g", run: openGoToLine },
      ]),
      themeCompartment.of(syntaxHighlighting(createHighlightStyle(themes[settings.theme] || themes["warm-dark"]))),
      updateListener,
      ctrlHoverHighlight(),
      ...(props.scrollMemory ? [cmScrollMemory(props.scrollMemory)] : []),
      EditorView.domEventHandlers({
        click(event, view) {
          if (event.ctrlKey || event.metaKey) {
            const pos = view.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            if (pos !== null) {
              const wordAt = view.state.wordAt(pos);
              if (wordAt) {
                const word = view.state.doc.sliceString(
                  wordAt.from,
                  wordAt.to
                );
                if (word) {
                  event.preventDefault();
                  const line = view.state.doc.lineAt(pos).number;
                  emit("goto-definition", {
                    word,
                    filePath: props.filePath,
                    line,
                  });
                }
              }
            }
          }
        },
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "var(--cm-font-size)",
          fontFamily: "var(--cm-font-family)",
          backgroundColor: "var(--aide-bg-deep)",
          color: "var(--aide-text-primary)",
        },
        ".cm-scroller": {
          overflow: "auto",
          // base 主题在 .cm-scroller 上硬设 font-family: monospace，会盖掉 & 上的
          // var(--cm-font-family) 继承（.cm-content/.cm-gutters 是其子节点，继承的是
          // monospace 而非用户字体）。在此同名选择器覆盖——用户主题优先级高于 baseTheme，
          // 等特异性 + 后注入 → 胜出，子节点随之继承用户字体。
          fontFamily: "var(--cm-font-family)",
        },
        ".cm-gutters": {
          backgroundColor: "var(--aide-bg-deep)",
          color: "var(--aide-text-muted)",
          borderRight: "1px solid var(--aide-surface-hover)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "var(--aide-surface-default)",
        },
        ".cm-activeLine": {
          backgroundColor: "color-mix(in srgb, var(--aide-text-primary) 3%, transparent)",
        },
        ".cm-selectionBackground": {
          backgroundColor: "var(--aide-surface-hover) !important",
        },
        ".cm-cursor": {
          borderLeftColor: "var(--aide-text-primary)",
        },
        ".cm-searchMatch": {
          backgroundColor: "color-mix(in srgb, var(--aide-warning) 25%, transparent)",
        },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: "color-mix(in srgb, var(--aide-warning) 45%, transparent)",
        },
        ".cm-matchingBracket": {
          backgroundColor: "color-mix(in srgb, var(--aide-accent) 15%, transparent)",
          outline: "1px solid var(--aide-accent)",
        },
        ".cm-nonmatchingBracket": {
          backgroundColor: "color-mix(in srgb, var(--aide-danger) 15%, transparent)",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--aide-surface-default) !important",
          color: "var(--aide-text-primary) !important",
          border: "1px solid var(--aide-surface-hover) !important",
        },
        // ── 搜索面板 / goto-line 对话框（@codemirror/search，basicSetup 已含）──
        // 真实 DOM（读 @codemirror/search 源码确认）：面板是 .cm-panel.cm-search
        // （不是 .cm-panel-search）；按钮是 .cm-button；输入框是 .cm-textfield；
        // 复选框是裸 <input type=checkbox> 包在 <label> 里（没有 .cm-checkbox 类）；
        // 关闭按钮是 [name=close]（没有 .cm-button 类）；goto-line 对话框是
        // .cm-dialog + .cm-dialog-close。{ dark: true } 已让 CodeMirror 自带 &dark
        // 默认值生效，下面再用 --aide 精修到项目配色。
        ".cm-panels": {
          backgroundColor: "var(--aide-bg-deep) !important",
          color: "var(--aide-text-primary) !important",
        },
        ".cm-panels-top": {
          borderBottom: "1px solid var(--aide-border) !important",
        },
        ".cm-panels-bottom": {
          borderTop: "1px solid var(--aide-border) !important",
        },
        ".cm-dialog": {
          backgroundColor: "var(--aide-bg-deep) !important",
          color: "var(--aide-text-primary) !important",
        },
        ".cm-dialog-close": {
          color: "var(--aide-text-muted) !important",
        },
        ".cm-dialog-close:hover": {
          color: "var(--aide-text-primary) !important",
        },
        ".cm-panel": {
          backgroundColor: "var(--aide-bg-deep) !important",
          color: "var(--aide-text-primary) !important",
          border: "1px solid var(--aide-border) !important",
        },
        ".cm-panel.cm-search": {
          backgroundColor: "var(--aide-bg-raised) !important",
          boxShadow: "var(--aide-shadow-sm) !important",
          padding: "6px 8px !important",
        },
        ".cm-textfield": {
          backgroundColor: "var(--aide-bg-deep) !important",
          border: "1px solid var(--aide-border) !important",
          color: "var(--aide-text-primary) !important",
          borderRadius: "var(--aide-radius-sm) !important",
          padding: "2px 6px !important",
          fontSize: "12px !important",
          /* structural overlay, not theme-color */
          boxShadow: "inset 0 1px 2px rgba(0,0,0,.3) !important",
        },
        ".cm-textfield:focus": {
          borderColor: "var(--aide-accent) !important",
          boxShadow: "var(--aide-accent-ring) !important",
          outline: "none !important",
        },
        ".cm-button": {
          backgroundImage: "none !important",
          backgroundColor: "var(--aide-surface-default) !important",
          border: "1px solid var(--aide-border) !important",
          color: "var(--aide-text-secondary) !important",
          borderRadius: "var(--aide-radius-sm) !important",
          padding: "2px 8px !important",
          fontSize: "12px !important",
          boxShadow: "var(--aide-highlight-inset) !important",
        },
        ".cm-button:hover": {
          backgroundColor: "var(--aide-surface-hover) !important",
          color: "var(--aide-text-primary) !important",
        },
        ".cm-button:active": {
          backgroundColor: "var(--aide-surface-active) !important",
        },
        // 关闭按钮（无 .cm-button 类，靠 name 属性定位）
        ".cm-panel [name=close]": {
          color: "var(--aide-text-muted) !important",
          fontSize: "14px !important",
        },
        ".cm-panel [name=close]:hover": {
          color: "var(--aide-text-primary) !important",
        },
        // 复选框：<label><input type=checkbox> 文本</label>，label 里没有 .cm-checkbox
        ".cm-panel label": {
          color: "var(--aide-text-muted) !important",
          fontSize: "12px !important",
        },
        ".cm-panel input[type=checkbox]": {
          accentColor: "var(--aide-accent) !important",
        },
        // ── 自动补全（@codemirror/autocomplete，basicSetup 已含）──
        // 真实 DOM（读源码确认）：tooltip 是 .cm-tooltip.cm-tooltip-autocomplete；
        // 内部 <ul> 无 cm-completionList 类（仅有 cm-completionListIncompleteTop/
        // Bottom 表示未取完）；<li> 默认无类名（role=option，选中靠 aria-selected）；
        // 命中文字是 .cm-completionMatchedText（不是 cm-completion-matched）。
        ".cm-tooltip-autocomplete": {
          backgroundColor: "var(--aide-bg-deep) !important",
          border: "1px solid var(--aide-surface-hover) !important",
          boxShadow: "var(--aide-shadow-md) !important",
        },
        ".cm-tooltip-autocomplete ul": {
          padding: "2px !important",
          fontSize: "12.5px !important",
        },
        ".cm-tooltip-autocomplete li": {
          padding: "2px 8px !important",
          color: "var(--aide-text-secondary) !important",
        },
        ".cm-tooltip-autocomplete li:hover, .cm-tooltip-autocomplete li[aria-selected]": {
          backgroundColor: "var(--aide-surface-hover) !important",
          color: "var(--aide-text-primary) !important",
        },
        // 分组分隔条（<completion-section> 自定义元素），默认 silver 边
        ".cm-tooltip-autocomplete completion-section": {
          borderBottomColor: "var(--aide-border) !important",
          color: "var(--aide-text-muted) !important",
        },
        ".cm-completionLabel": {
          color: "var(--aide-text-primary) !important",
        },
        ".cm-completionIcon": {
          color: "var(--aide-text-muted) !important",
        },
        ".cm-completionDetail": {
          color: "var(--aide-text-muted) !important",
          fontStyle: "italic !important",
        },
        ".cm-completionMatchedText": {
          color: "var(--aide-accent) !important",
        },
        ".cm-completionInfo": {
          backgroundColor: "var(--aide-bg-raised) !important",
          border: "1px solid var(--aide-surface-hover) !important",
          color: "var(--aide-text-secondary) !important",
        },
        // ── 诊断 / lint（@codemirror/lint）──
        ".cm-diagnostic": {
          backgroundColor: "var(--aide-bg-deep) !important",
          color: "var(--aide-text-secondary) !important",
          borderLeft: "3px solid var(--aide-danger) !important",
          padding: "4px 8px !important",
          fontSize: "12px !important",
        },
        ".cm-diagnostic-warning": {
          borderLeftColor: "var(--aide-warning) !important",
        },
        ".cm-diagnostic-error": {
          borderLeftColor: "var(--aide-danger) !important",
        },
      }, { dark: true }),
    ],
    parent: mountEl.value,
  });

  // Signal that the editor is fully created (including async lang import)
  applyFontSettings();
  resolveReady?.();
}

function applyFontSettings() {
  if (!view) return;
  view.dom.style.setProperty("--cm-font-size", `${settings.fontSize}px`);
  view.dom.style.setProperty("--cm-font-family", settings.fontFamily);
}

// ── React to user font settings changes ──
watch(
  [() => settings.fontSize, () => settings.fontFamily],
  () => applyFontSettings()
);

// ── React to theme changes: rebuild HighlightStyle with resolved CSS var colors ──
watch(() => settings.theme, () => {
  if (view) {
    view.dispatch({
      effects: themeCompartment.reconfigure(
        syntaxHighlighting(createHighlightStyle(themes[settings.theme] || themes["warm-dark"]))
      )
    });
  }
});

function openGoToLine(target: EditorView): boolean {
  const { prompt: modalPrompt } = useModal();
  modalPrompt("跳转到行:", "行号").then((line) => {
    if (line !== null && line !== "") {
      const lineNum = parseInt(line, 10);
      if (!isNaN(lineNum) && lineNum > 0) {
        const pos = target.state.doc.line(lineNum);
        target.dispatch({
          selection: { anchor: pos.from, head: pos.from },
          scrollIntoView: true,
        });
        target.focus();
      }
    }
  });
  return true;
}

// ── External content update (when modelValue changes from parent) ──

watch(
  () => props.modelValue,
  (newVal) => {
    if (view && newVal !== view.state.doc.toString()) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: newVal,
        },
      });
    }
  }
);

// ── File extension change → recreate editor with new language ──

watch(
  () => props.filePath,
  () => {
    createEditor();
  }
);

// ── Expose scrollToLine ──

function scrollToLine(line: number, opts?: { cursor?: boolean }) {
  if (!view) return;
  const docLine = view.state.doc.line(Math.min(line, view.state.doc.lines));
  if (opts?.cursor !== false) {
    view.dispatch({
      selection: { anchor: docLine.from, head: docLine.from },
      effects: EditorView.scrollIntoView(docLine.from, { y: "start" }),
    });
    view.focus();
  } else {
    view.dispatch({
      effects: EditorView.scrollIntoView(docLine.from, { y: "start" }),
    });
  }
}

function waitReady(): Promise<void> {
  return readyPromise;
}

defineExpose({ scrollToLine, waitReady });

onMounted(() => {
  createEditor();
});

onUnmounted(() => {
  if (view) {
    view.destroy();
    view = null;
  }
});
</script>

<template>
  <div ref="mountEl" class="cm-editor-host"></div>
</template>

<style scoped>
.cm-editor-host {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
</style>
