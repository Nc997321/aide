<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import {
  MergeView,
  unifiedMergeView,
  goToNextChunk,
  goToPreviousChunk,
} from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import type { DiffPair } from "../../types";
import { loadLanguageExtension } from "../../utils/cmLanguage";
import { createHighlightStyle } from "../../utils/cmHighlight";
import { useSettings } from "../../composables/useSettings";
import { themes } from "../../themes";

/**
 * 编辑器级 diff 查看器（@codemirror/merge）。纯查看：
 * 并排（MergeView，默认）/ 单栏（unifiedMergeView）可切，两侧只读。
 * 特例（行尾-only / 二进制 / 超大）不挂 merge 视图，只显示提示。
 */
const props = defineProps<{
  pair: DiffPair;
  filePath: string;
}>();

const { settings } = useSettings();

const mode = ref<"split" | "unified">("split");
const mountEl = ref<HTMLElement | null>(null);

let mergeView: MergeView | null = null;
let unifiedView: EditorView | null = null;
let createId = 0;

/** 对齐 useFileViewer 的 MAX_EDITABLE_SIZE：防 diff 计算卡窗 */
const MAX_DIFF_SIZE = 1_000_000;

const tooBig = computed(
  () =>
    props.pair.tooBig ||
    props.pair.oldText.length > MAX_DIFF_SIZE ||
    props.pair.newText.length > MAX_DIFF_SIZE,
);
const showNotice = computed(
  () => props.pair.eolOnly || props.pair.isBinary || tooBig.value,
);
const noticeText = computed(() => {
  if (props.pair.eolOnly) return `内容与 ${props.pair.oldLabel} 无差异（仅行尾不同）`;
  if (props.pair.isBinary) return "二进制文件无法对比";
  return "文件过大（超过 1MB），无法渲染对比视图";
});

const STATUS_LABELS: Record<string, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
};
const statusLabel = computed(() => STATUS_LABELS[props.pair.status] || props.pair.status);

const ext = computed(() => {
  const parts = props.filePath.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
});

const themeCompartment = new Compartment();

function currentTokens() {
  return themes[settings.theme] || themes["warm-dark"];
}

// ── merge 主题（只写编辑器内部选择器，& = 编辑器根）──
// 类名读 node_modules/@codemirror/merge/dist/index.js 源码确认：
//   变更行 .cm-changedLine；行内变更段 .cm-changedText；
//   unified：新增行 .cm-insertedLine(<ins>)、删除行 .cm-deletedLine(<del>)、
//   删除块 widget .cm-deletedChunk、行内变更行 .cm-inlineChangedLine；
//   折叠条 .cm-collapsedLines；gutter 标记 .cm-changedLineGutter / .cm-deletedLineGutter；
//   编辑器根 a 侧带 .cm-merge-a、b 侧带 .cm-merge-b（源码 baseTheme 用
//   "&.cm-merge-a .cm-changedLine" 同款选择器，根元素带侧类名可确认）。
// 外层容器 .cm-mergeView 是编辑器根的祖先，这里够不到，由下方非 scoped 样式负责。
// { dark: true } 必传：让包自带 &dark 默认值生效，再由 --aide-* 精修。
const mergeTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--aide-bg-deep)",
      color: "var(--aide-text-primary)",
      fontSize: "var(--cm-font-size)",
      fontFamily: "var(--cm-font-family)",
      height: "100%",
    },
    // base 主题在 .cm-scroller 硬设 monospace 会盖掉 & 的 var(--cm-font-family) 继承；
    // 同名选择器覆盖（用户主题优先级高于 baseTheme），.cm-content/.cm-gutters 跟着继承。
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--cm-font-family)" },
    ".cm-gutters": {
      backgroundColor: "var(--aide-bg-deep)",
      color: "var(--aide-text-muted)",
      borderRight: "1px solid var(--aide-surface-hover)",
    },
    // 旧侧（a / 删除）= danger，新侧（b / 新增）= success
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
      backgroundColor: "color-mix(in srgb, var(--aide-danger) 8%, transparent)",
    },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
      backgroundColor: "color-mix(in srgb, var(--aide-success) 7%, transparent)",
    },
    ".cm-changedText": {
      backgroundColor: "color-mix(in srgb, var(--aide-warning) 22%, transparent)",
    },
    ".cm-insertedLine, .cm-deletedLine, .cm-deletedLine del": {
      textDecoration: "none",
    },
    "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": {
      backgroundColor: "var(--aide-danger)",
    },
    "&.cm-merge-b .cm-changedLineGutter": {
      backgroundColor: "var(--aide-success)",
    },
    ".cm-collapsedLines": {
      color: "var(--aide-text-muted)",
      background: "var(--aide-bg-base)",
    },
  },
  { dark: true },
);

function readOnlyExts(langExt: Extension): Extension[] {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    langExt,
    themeCompartment.of(syntaxHighlighting(createHighlightStyle(currentTokens()))),
    mergeTheme,
  ];
}

async function createView() {
  const id = ++createId;
  destroyView();
  if (showNotice.value || !mountEl.value) return;

  const langExt = await loadLanguageExtension(ext.value);
  if (id !== createId) return; // 等待期间已被重建/销毁

  if (mode.value === "split") {
    mergeView = new MergeView({
      a: { doc: props.pair.oldText, extensions: readOnlyExts(langExt) },
      b: { doc: props.pair.newText, extensions: readOnlyExts(langExt) },
      parent: mountEl.value,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
  } else {
    unifiedView = new EditorView({
      doc: props.pair.newText,
      extensions: [
        ...readOnlyExts(langExt),
        unifiedMergeView({
          original: props.pair.oldText,
          highlightChanges: true,
          gutter: true,
          // 默认 true 会显示 accept/reject 按钮——纯查看必须关
          mergeControls: false,
          collapseUnchanged: { margin: 3, minSize: 4 },
        }),
      ],
      parent: mountEl.value,
    });
  }
  applyFontSettings();
}

function destroyView() {
  mergeView?.destroy();
  mergeView = null;
  unifiedView?.destroy();
  unifiedView = null;
}

function applyFontSettings() {
  if (!mountEl.value) return;
  mountEl.value.style.setProperty("--cm-font-size", `${settings.fontSize}px`);
  mountEl.value.style.setProperty("--cm-font-family", settings.fontFamily);
}

/** hunk 跳转：split 模式作用于 b（新）侧编辑器；StateCommand 直接吃 EditorView */
function gotoChunk(next: boolean) {
  const view = mode.value === "split" ? mergeView?.b : unifiedView;
  if (!view) return;
  (next ? goToNextChunk : goToPreviousChunk)(view);
  view.focus();
}

function toggleMode() {
  mode.value = mode.value === "split" ? "unified" : "split";
  void createView();
}

// 主题切换：只重配语法高亮 compartment，不重建视图（同 CodeEditor 模式）
watch(
  () => settings.theme,
  () => {
    const effect = themeCompartment.reconfigure(
      syntaxHighlighting(createHighlightStyle(currentTokens())),
    );
    mergeView?.a.dispatch({ effects: effect });
    mergeView?.b.dispatch({ effects: effect });
    unifiedView?.dispatch({ effects: effect });
  },
);

// 字体设置变化 → 重新下发到挂载容器（跟随 CodeEditor 的同款 watch）
watch(
  [() => settings.fontSize, () => settings.fontFamily],
  () => applyFontSettings(),
);

// 同路径重开 → pair 被就地替换 → 重建视图（flush: post 确保 mountEl 已随 v-if 切换）
watch(
  () => props.pair,
  () => void createView(),
  { flush: "post" },
);

onMounted(() => void createView());
onBeforeUnmount(() => {
  createId++;
  destroyView();
});
</script>

<template>
  <div class="dv-root">
    <div class="dv-toolbar">
      <span class="dv-badge" :class="`dv-badge--${pair.status}`">{{ statusLabel }}</span>
      <span class="dv-labels" v-tooltip="filePath">{{ pair.oldLabel }} → {{ pair.newLabel }}</span>
      <div class="dv-spacer"></div>
      <template v-if="!showNotice">
        <button class="dv-btn" v-tooltip="'上一处变更'" @click="gotoChunk(false)">↑</button>
        <button class="dv-btn" v-tooltip="'下一处变更'" @click="gotoChunk(true)">↓</button>
        <button class="dv-btn" @click="toggleMode">{{ mode === "split" ? "单栏" : "并排" }}</button>
      </template>
    </div>
    <div v-if="showNotice" class="dv-notice">{{ noticeText }}</div>
    <div v-else ref="mountEl" class="dv-mount"></div>
  </div>
</template>

<style scoped>
.dv-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--aide-bg-deep);
}
.dv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-highlight-inset);
  flex-shrink: 0;
}
.dv-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2.5px 9px;
  font-size: 10.5px;
  font-weight: 600;
  border-radius: var(--aide-radius-sm);
  letter-spacing: 0.02em;
  border: 1px solid transparent;
}
.dv-badge--added {
  color: var(--aide-success);
  background: color-mix(in srgb, var(--aide-success) 12%, transparent);
  border-color: color-mix(in srgb, var(--aide-success) 28%, transparent);
}
.dv-badge--modified {
  color: var(--aide-info);
  background: color-mix(in srgb, var(--aide-info) 12%, transparent);
  border-color: color-mix(in srgb, var(--aide-info) 28%, transparent);
}
.dv-badge--deleted {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
  border-color: color-mix(in srgb, var(--aide-danger) 28%, transparent);
}
.dv-labels {
  font-size: 12px;
  color: var(--aide-text-muted);
}
.dv-spacer {
  flex: 1;
}
.dv-btn {
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--aide-highlight-inset);
  transition: all var(--aide-ease-t);
}
.dv-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.dv-notice {
  padding: 24px;
  text-align: center;
  color: var(--aide-text-muted);
  font-size: 13px;
}
.dv-mount {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>

<!-- merge 容器（.cm-mergeView）是编辑器根的祖先，CM 主题块和 scoped 样式都够不到，
     必须非 scoped（同 xterm 动态 DOM 的既有约定）。滚动模型（dist:1109/1188 实锤）：
     库 baseTheme 对 MergeView 内编辑器强制 height:auto !important + overflowY:visible
     !important——两侧撑全高、永不自滚；唯一滚动容器是外层 .cm-mergeView（height +
     overflow:auto），一个滚动条带动两侧（行对齐靠库内建 spacer，无需同步代码）。
     .cm-mergeViewEditors/.cm-mergeViewEditor 两层禁止钉 100% 高，否则内容被裁、
     容器撑不出滚动空间。unified 单栏不走这里：mergeTheme 的 .cm-scroller
     overflow:auto + 编辑器 height:100% 自滚。 -->
<style>
.dv-mount .cm-mergeView {
  height: 100%;
  overflow: auto;
}
</style>
