<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";

const props = defineProps<{
  filePath: string;
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "goto-definition", payload: { word: string; filePath: string }): void;
}>();

const mountEl = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;

// ── Language detection ──
const ext = computed(() => {
  const parts = props.filePath.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
});

async function loadLanguageExtension() {
  const e = ext.value;
  try {
    switch (e) {
      case "ts":
      case "tsx":
      case "js":
      case "jsx": {
        const { javascript } = await import("@codemirror/lang-javascript");
        return javascript({ typescript: e === "ts" || e === "tsx" });
      }
      case "rs": {
        const { rust } = await import("@codemirror/lang-rust");
        return rust();
      }
      case "java": {
        const { java } = await import("@codemirror/lang-java");
        return java();
      }
      case "py": {
        const { python } = await import("@codemirror/lang-python");
        return python();
      }
      case "json": {
        const { json } = await import("@codemirror/lang-json");
        return json();
      }
      case "md":
      case "mdx": {
        const { markdown } = await import("@codemirror/lang-markdown");
        return markdown();
      }
      case "html":
      case "htm": {
        const { html } = await import("@codemirror/lang-html");
        return html();
      }
      case "css":
      case "scss":
      case "less": {
        const { css } = await import("@codemirror/lang-css");
        return css();
      }
      case "vue": {
        const { vue } = await import("@codemirror/lang-vue");
        return vue();
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

// ── Editor lifecycle ──

async function createEditor() {
  if (!mountEl.value) return;

  // Destroy existing instance
  if (view) {
    view.destroy();
    view = null;
  }

  const langExt = await loadLanguageExtension();

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
      oneDark,
      updateListener,
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
                  emit("goto-definition", {
                    word,
                    filePath: props.filePath,
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
          fontSize: "13px",
          fontFamily:
            '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
        },
        ".cm-scroller": {
          overflow: "auto",
        },
        ".cm-gutters": {
          backgroundColor: "var(--bg-tertiary)",
          color: "var(--text-muted)",
          borderRight: "1px solid var(--surface-hover)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "var(--surface)",
        },
        ".cm-activeLine": {
          backgroundColor: "rgba(255, 255, 255, 0.03)",
        },
        ".cm-selectionBackground": {
          backgroundColor: "var(--surface-hover) !important",
        },
        ".cm-cursor": {
          borderLeftColor: "var(--text-primary)",
        },
        ".cm-searchMatch": {
          backgroundColor: "rgba(249, 226, 175, 0.3)",
        },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: "rgba(249, 226, 175, 0.5)",
        },
        ".cm-matchingBracket": {
          backgroundColor: "rgba(137, 180, 250, 0.15)",
          outline: "1px solid var(--accent)",
        },
        ".cm-nonmatchingBracket": {
          backgroundColor: "rgba(243, 139, 168, 0.15)",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--surface) !important",
          color: "var(--text-primary) !important",
          border: "1px solid var(--surface-hover) !important",
        },
      }),
    ],
    parent: mountEl.value,
  });
}

function openGoToLine(target: EditorView): boolean {
  const line = prompt("跳转到行:");
  if (line !== null && line !== "") {
    const lineNum = parseInt(line, 10);
    if (!isNaN(lineNum) && lineNum > 0) {
      const pos = target.state.doc.line(lineNum);
      target.dispatch({
        selection: { anchor: pos.from, head: pos.from },
        scrollIntoView: true,
      });
      return true;
    }
  }
  return false;
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

function scrollToLine(line: number) {
  if (!view) return;
  const docLine = view.state.doc.line(Math.min(line, view.state.doc.lines));
  view.dispatch({
    selection: { anchor: docLine.from, head: docLine.from },
    scrollIntoView: true,
  });
  view.focus();
}

defineExpose({ scrollToLine });

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
