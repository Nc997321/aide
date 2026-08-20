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
import { createDiffTheme } from "./diffThemes";

/**
 * 编辑器级 diff 查看器（@codemirror/merge）。纯查看：
 * 并排（MergeView，默认）/ 单栏（unifiedMergeView）可切，两侧只读。
 * 特例（行尾-only / 二进制 / 超大）不挂 merge 视图，只显示提示。
 */
const props = withDefaults(
  defineProps<{
    pair: DiffPair;
    filePath: string;
    /** 初始并排/单栏；默认 split 保持文件查看器现状，对话内变更卡传 unified */
    initialMode?: "split" | "unified";
    /** 工具栏状态徽章（新增/修改/删除）；对话内变更卡与工具名重复，传 false */
    showBadge?: boolean;
  }>(),
  { initialMode: "split", showBadge: true },
);

const { settings } = useSettings();

const mode = ref<"split" | "unified">(props.initialMode);
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

/** 文件路径拆目录（弱化）+ 基名（主色）：工具栏信息层级的主角是文件名 */
const pathParts = computed(() => {
  const normalized = props.filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx < 0
    ? { dir: "", name: normalized }
    : { dir: normalized.slice(0, idx + 1), name: normalized.slice(idx + 1) };
});

const themeCompartment = new Compartment();

function currentTokens() {
  return themes[settings.theme] || themes["warm-dark"];
}

// merge 配色主题在 ./diffThemes.ts（克制系三层结构 + 类名/级联考据注释）；
// 颜色全是 var(--aide-*) 引用，主题切换自动生效，无需 compartment。

function readOnlyExts(langExt: Extension): Extension[] {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    langExt,
    themeCompartment.of(syntaxHighlighting(createHighlightStyle(currentTokens()))),
    createDiffTheme(),
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
  mountEl.value.style.setProperty("--cm-font-family", settings.editorFontFamily);
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
  [() => settings.fontSize, () => settings.editorFontFamily],
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
      <span v-if="showBadge" class="dv-badge" :class="`dv-badge--${pair.status}`">{{ statusLabel }}</span>
      <span class="dv-path" v-tooltip="filePath" :style="{ fontFamily: settings.editorFontFamily }">
        <span class="dv-path-dir">{{ pathParts.dir }}</span><span class="dv-path-name">{{ pathParts.name }}</span>
      </span>
      <span class="dv-labels">{{ pair.oldLabel }} → {{ pair.newLabel }}</span>
      <div class="dv-spacer"></div>
      <template v-if="!showNotice">
        <button class="dv-btn" v-tooltip="'上一处变更'" @click="gotoChunk(false)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 8L6 4.5L9.5 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="dv-btn" v-tooltip="'下一处变更'" @click="gotoChunk(true)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 4L6 7.5L9.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="dv-btn dv-btn-text" @click="toggleMode">{{ mode === "split" ? "单栏" : "并排" }}</button>
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
/* 工具栏做成扁平条（仅底部发线）：外层 FileWindow/变更卡已有自己的
   边框+圆角 chrome，这里再套一层浮起卡片就是双重 chrome */
.dv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--aide-border-subtle);
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
/* 文件路径：等宽字体，目录弱化、基名主色——工具栏的第一信息 */
.dv-path {
  display: inline-flex;
  align-items: baseline;
  min-width: 0;
  font-size: 12px;
  white-space: nowrap;
}
.dv-path-dir {
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.dv-path-name {
  color: var(--aide-text-primary);
  flex-shrink: 0;
}
/* 旧→新标签降级为次级元数据，截断保护（让位于文件名） */
.dv-labels {
  font-size: 11px;
  color: var(--aide-text-muted);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.dv-spacer {
  flex: 1;
}
/* ghost 按钮不带 inset 高光（透明底上的顶部亮线读起来像杂散边框） */
.dv-btn {
  min-width: 26px;
  height: 26px;
  padding: 0 5px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--aide-ease-t);
}
.dv-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
/* 文字按钮（单栏/并排）横向留白，别挤在 26px 最小宽里 */
.dv-btn-text {
  padding: 0 8px;
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
     容器撑不出滚动空间。unified 单栏不走这里：diffThemes 的 .cm-scroller
     overflow:auto + 编辑器 height:100% 自滚。 -->
<style>
.dv-mount .cm-mergeView {
  height: 100%;
  overflow: auto;
}
</style>
