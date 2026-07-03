<script setup lang="ts">
import { computed, watch, ref, nextTick } from "vue";
import { useFileViewer, isWindowDirty } from "../../composables/useFileViewer";
import type { FileWindowState, MarkdownMode } from "../../composables/useFileViewer";
import { useGotoDefinition } from "../../composables/useGotoDefinition";
import { useModal } from "../../composables/useModal";
import CodeEditor from "../CodeEditor.vue";
import { extToLang, highlightCode } from "../../utils/highlight";
import { marked } from "../../utils/markdown";

const props = defineProps<{
  win: FileWindowState;
}>();

const { closeWindow, save, openAndScrollTo, projectRoot, gotoOwnerId } = useFileViewer();
const goto = useGotoDefinition();
const modal = useModal();

const gotoPopoverRef = ref<HTMLElement | null>(null);
const codeEditorRef = ref<InstanceType<typeof CodeEditor> | null>(null);

const dirty = computed(() => isWindowDirty(props.win));
const isImage = computed(() => !!props.win.imageUrl);
const isDiff = computed(() => props.win.language === "diff");
/** 是否挂编辑器：非只读、非图片、非错误；markdown 全预览模式下也不挂 */
const editorActive = computed(
  () =>
    !props.win.readonly &&
    !props.win.error &&
    !isImage.value &&
    (!props.win.isMarkdown || props.win.mdMode !== "preview"),
);

const MD_MODES: Array<{ value: MarkdownMode; label: string }> = [
  { value: "preview", label: "预览" },
  { value: "split", label: "分屏" },
  { value: "edit", label: "编辑" },
];

const languageLabel = computed(() => {
  const ext = props.win.fileName.split(".").pop()?.toLowerCase() || "";
  return props.win.language || extToLang[ext] || ext || "text";
});

// 只读代码视图（大文件 / 虚拟内容）
const highlighted = computed(() => {
  if (!props.win.content) return "";
  const ext = props.win.fileName.split(".").pop()?.toLowerCase() || "";
  return highlightCode(props.win.content, ext);
});

const diffHighlighted = computed(() => {
  if (!props.win.content) return "";
  return props.win.content.split("\n").map((line) => {
    let cls = "aide-diff-ctx";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "aide-diff-add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "aide-diff-del";
    else if (line.startsWith("@@")) cls = "aide-diff-hunk";
    else if (line.startsWith("diff ") || line.startsWith("index ") ||
             line.startsWith("--- ") || line.startsWith("+++ ") ||
             line.startsWith("new file") || line.startsWith("deleted file"))
      cls = "aide-diff-meta";
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }).join("\n");
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Markdown 实时预览：渲染编辑器里的内容而不是磁盘基线，分屏时所见即所得
const renderedMarkdown = computed(() => {
  const source = props.win.editContent || props.win.content;
  if (!source) return "";
  try {
    return marked.parse(source) as string;
  } catch {
    return source;
  }
});

// ── 关闭：干净直接关；脏文件让用户选「保存并关闭 / 放弃修改 / 取消」──
async function requestClose() {
  if (dirty.value) {
    const res = await modal.choice(
      "关闭文件",
      `「${props.win.fileName}」有未保存的修改。`,
      { confirmLabel: "保存并关闭", altLabel: "放弃修改" },
    );
    if (res === "cancel") return;
    if (res === "confirm") {
      await save(props.win.id);
      if (isWindowDirty(props.win)) return; // 保存失败（error 已显示），别静默丢内容
    }
  }
  closeWindow(props.win.id);
}

// ── 标题栏拖拽：随意挪动窗口（自动平铺会在开/关/切主窗时重新接管）──
const dragging = ref(false);

function onHeaderPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button")) return; // 按钮不当拖拽把手
  const offsetX = e.clientX - props.win.x;
  const offsetY = e.clientY - props.win.y;
  dragging.value = true;
  const onMove = (ev: PointerEvent) => {
    // 至少留 80px 宽、整条标题栏高度在视口内，窗口永远拖得回来
    props.win.x = Math.min(Math.max(ev.clientX - offsetX, 80 - props.win.w), window.innerWidth - 80);
    props.win.y = Math.min(Math.max(ev.clientY - offsetY, 36), window.innerHeight - 48);
  };
  const onUp = () => {
    dragging.value = false;
    window.removeEventListener("pointermove", onMove);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

// ── 跳转到指定行（聊天文件链接 / 跳转定义落点）──
// markdown 默认全预览没有编辑器，行号挂起，等用户切到编辑/分屏时再消费。
watch(
  () => [props.win.scrollToLine, editorActive.value] as const,
  async ([line, active]) => {
    if (line == null || !active) return;
    await nextTick();
    await codeEditorRef.value?.waitReady();
    codeEditorRef.value?.scrollToLine(line);
    props.win.scrollToLine = null;
  },
  { immediate: true },
);

// ── goto-definition（useGotoDefinition 是单例，浮层只在触发窗口里渲染）──
const gotoActive = computed(() => goto.visible.value && gotoOwnerId.value === props.win.id);

async function onGotoDefinition(payload: { word: string; filePath: string; line: number }) {
  gotoOwnerId.value = props.win.id;
  const root = projectRoot.value;
  const sep = root.includes("\\") ? "\\" : "/";
  const relPath = payload.filePath.startsWith(root)
    ? payload.filePath.slice(root.length + sep.length).replace(/\\/g, "/")
    : "";
  const ext = payload.filePath.split(".").pop()?.toLowerCase() || "";
  await goto.search(payload.word, root, { sourceFile: relPath, sourceLine: payload.line, sourceExt: ext });
}

async function onSearchAllReferences() {
  await goto.searchAllReferences(goto.searchWord.value, projectRoot.value);
}

async function onGotoResultSelect(match: { file: string; line: number }) {
  goto.dismiss();
  const separator = projectRoot.value.includes("\\") ? "\\" : "/";
  const targetPath = projectRoot.value + separator + match.file.replace(/\//g, separator);
  await openAndScrollTo(targetPath, match.line);
}

function onGotoKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    goto.dismiss();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    goto.selectNext();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    goto.selectPrev();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = goto.getSelected();
    if (selected) onGotoResultSelect(selected);
  }
}

watch(gotoActive, (v) => {
  if (v) nextTick(() => gotoPopoverRef.value?.focus());
});

// ── 快捷键：Ctrl+S 保存，Esc 关窗 ──
function onKeydown(e: KeyboardEvent) {
  if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (dirty.value) void save(props.win.id);
  } else if (e.key === "Escape") {
    void requestClose();
  }
}
</script>

<template>
  <div class="fw-window" :class="{ 'fw-window--dragging': dragging }" tabindex="-1" @keydown="onKeydown">
    <div class="fw-header" @pointerdown="onHeaderPointerDown">
      <span v-if="dirty" class="fw-dirty" title="有未保存的修改">●</span>
      <span class="fw-title">{{ win.fileName }}</span>
      <span class="fw-lang">{{ languageLabel }}</span>
      <span v-if="win.readonly && !isImage" class="fw-readonly-badge">只读</span>
      <span class="fw-path" v-tooltip="win.filePath">{{ win.filePath }}</span>

      <!-- Markdown 三态：全预览 / 分屏 / 全编辑 -->
      <div v-if="win.isMarkdown && !win.readonly && !win.error" class="fw-md-modes">
        <button
          v-for="m in MD_MODES"
          :key="m.value"
          class="fw-md-mode-btn"
          :class="{ active: win.mdMode === m.value }"
          @click="win.mdMode = m.value"
        >
          {{ m.label }}
        </button>
      </div>

      <button
        v-if="dirty || win.saving"
        class="fw-btn primary"
        :disabled="win.saving"
        @click="save(win.id)"
      >
        {{ win.saving ? "保存中…" : "保存" }}
      </button>
      <button class="fw-close" @click="requestClose">&times;</button>
    </div>

    <div class="fw-body">
      <div v-if="win.error" class="fw-error">{{ win.error }}</div>

      <div v-else-if="isImage" class="fw-image-wrap">
        <img :src="win.imageUrl" class="fw-image" :alt="win.fileName" />
      </div>

      <!-- 只读：diff / 大文件 / 虚拟内容 -->
      <pre v-else-if="win.readonly && isDiff" class="fw-pre"><code class="viewer-code viewer-diff" v-html="diffHighlighted"></code></pre>
      <pre v-else-if="win.readonly" class="fw-pre"><code class="viewer-code" v-html="highlighted"></code></pre>

      <!-- Markdown 全预览 -->
      <div
        v-else-if="win.isMarkdown && win.mdMode === 'preview'"
        class="fw-scroll viewer-markdown"
        v-html="renderedMarkdown"
      ></div>

      <!-- Markdown 分屏：左编辑右实时预览 -->
      <div v-else-if="win.isMarkdown && win.mdMode === 'split'" class="fw-split">
        <div class="fw-split-pane fw-editor">
          <CodeEditor
            ref="codeEditorRef"
            v-model="win.editContent"
            :filePath="win.filePath"
            @goto-definition="onGotoDefinition"
          />
        </div>
        <div class="fw-split-pane fw-scroll viewer-markdown" v-html="renderedMarkdown"></div>
      </div>

      <!-- 默认：直接可编辑（含 Markdown 全编辑） -->
      <div v-else class="fw-editor">
        <CodeEditor
          ref="codeEditorRef"
          v-model="win.editContent"
          :filePath="win.filePath"
          @goto-definition="onGotoDefinition"
        />
      </div>

      <!-- 跳转结果浮层 -->
      <div v-if="gotoActive" ref="gotoPopoverRef" tabindex="-1" class="goto-popover" @keydown="onGotoKeydown">
        <div class="goto-popover-header">
          <span class="goto-popover-title">「{{ goto.searchWord.value }}」的定义</span>
          <button class="goto-popover-close" @click="goto.dismiss()">&times;</button>
        </div>
        <div class="goto-popover-body">
          <template v-if="goto.results.value.length === 0">
            <div class="goto-popover-empty">
              未找到定义 · <span class="goto-popover-hint" @click="onSearchAllReferences">搜索所有引用</span>
            </div>
          </template>
          <template v-else>
            <div
              v-for="(match, idx) in goto.results.value"
              :key="`${match.file}:${match.line}`"
              class="goto-popover-item"
              :class="{ active: idx === goto.selectedIndex.value }"
              @click="onGotoResultSelect(match)"
            >
              <span class="goto-item-path">{{ match.file }}:{{ match.line }}</span>
              <span class="goto-item-tag" :class="'tag-' + match.match_type">{{ match.match_type }}</span>
              <span class="goto-item-content">{{ match.content }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fw-window {
  width: 100%;
  height: 100%;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-lg);
  display: flex;
  flex-direction: column;
  box-shadow: var(--aide-shadow-lg);
  overflow: hidden;
  outline: none;
}

.fw-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aide-surface-hover);
  flex-shrink: 0;
  min-width: 0;
  cursor: move; /* 标题栏即拖拽把手 */
  user-select: none;
}

.fw-window--dragging {
  box-shadow: var(--aide-shadow-lg), 0 0 0 1px color-mix(in srgb, var(--aide-accent) 40%, transparent);
}

.fw-dirty {
  color: var(--aide-warning);
  font-size: 11px;
  flex-shrink: 0;
}

.fw-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  white-space: nowrap;
  flex-shrink: 0;
}

.fw-lang {
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
  flex-shrink: 0;
}

.fw-readonly-badge {
  font-size: 10px;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.fw-path {
  flex: 1;
  font-size: 11px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.fw-md-modes {
  display: flex;
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-sm);
  overflow: hidden;
  flex-shrink: 0;
}

.fw-md-mode-btn {
  background: var(--aide-bg-deep);
  border: none;
  color: var(--aide-text-secondary);
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s;
}

.fw-md-mode-btn + .fw-md-mode-btn {
  border-left: 1px solid var(--aide-surface-hover);
}

.fw-md-mode-btn:hover {
  color: var(--aide-text-primary);
}

.fw-md-mode-btn.active {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}

.fw-btn {
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-surface-hover);
  color: var(--aide-text-secondary);
  padding: 3px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.fw-btn.primary {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  border-color: var(--aide-accent);
}
.fw-btn.primary:hover {
  opacity: 0.9;
}
.fw-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.fw-close {
  background: none;
  border: none;
  color: var(--aide-text-secondary);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 4px;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.fw-close:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.fw-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.fw-error {
  padding: 24px;
  color: var(--aide-danger);
  font-size: 13px;
}

.fw-image-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: auto;
  background: var(--aide-bg-deep);
}

.fw-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  width: auto;
  height: auto;
}

.fw-pre {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
}

.fw-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.fw-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

.fw-split {
  flex: 1;
  min-height: 0;
  display: flex;
}

.fw-split-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.fw-split-pane + .fw-split-pane {
  border-left: 1px solid var(--aide-surface-hover);
}

/* ── Goto popover ── */

.goto-popover {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  max-height: 280px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-surface-hover);
  border-radius: 8px;
  box-shadow: var(--aide-shadow-md);
  z-index: 10;
  display: flex;
  flex-direction: column;
  animation: fw-slide-up 0.12s ease;
}

@keyframes fw-slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.goto-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aide-surface-hover);
  flex-shrink: 0;
}

.goto-popover-title {
  font-size: 12px;
  color: var(--aide-text-secondary);
}

.goto-popover-close {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 4px;
}
.goto-popover-close:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.goto-popover-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.goto-popover-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--aide-text-muted);
}

.goto-popover-hint {
  color: var(--aide-accent);
  cursor: pointer;
}

.goto-popover-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.12s ease-out;
}
.goto-popover-item:hover,
.goto-popover-item.active {
  background: var(--aide-surface-hover);
}

.goto-item-path {
  font-size: 11px;
  color: var(--aide-accent);
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}

.goto-item-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
  flex-shrink: 0;
  background: var(--aide-bg-deep);
  color: var(--aide-text-muted);
}
.goto-item-tag.tag-fn,
.goto-item-tag.tag-function,
.goto-item-tag.tag-def {
  background: color-mix(in srgb, var(--aide-success) 15%, transparent);
  color: var(--aide-success);
}
.goto-item-tag.tag-class {
  background: color-mix(in srgb, var(--aide-info) 15%, transparent);
  color: var(--aide-accent);
}
.goto-item-tag.tag-const {
  background: color-mix(in srgb, var(--aide-warning) 15%, transparent);
  color: var(--aide-warning);
}

.goto-item-content {
  font-size: 11px;
  color: var(--aide-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", monospace;
}
</style>

<!-- hljs / Markdown / diff 渲染样式（非 scoped——作用于 v-html 生成的动态 DOM） -->
<style>
.viewer-code {
  display: block;
  padding: 16px;
  margin: 0;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 13px;
  line-height: 1.6;
  color: var(--aide-text-primary);
  white-space: pre;
  tab-size: 4;
}

.viewer-code .hljs-keyword,
.viewer-code .hljs-selector-tag,
.viewer-code .hljs-type { color: #cba6f7; }        /* mauve */
.viewer-code .hljs-string,
.viewer-code .hljs-addition,
.viewer-code .hljs-regexp { color: #a6e3a1; }      /* green */
.viewer-code .hljs-number,
.viewer-code .hljs-literal,
.viewer-code .hljs-variable,
.viewer-code .hljs-template-variable,
.viewer-code .hljs-tag .hljs-attr { color: #fab387; } /* peach */
.viewer-code .hljs-comment,
.viewer-code .hljs-quote { color: #6c7086; font-style: italic; }
.viewer-code .hljs-title,
.viewer-code .hljs-title.class_,
.viewer-code .hljs-title.class_.inherited__,
.viewer-code .hljs-title.function_ { color: #89b4fa; } /* blue */
.viewer-code .hljs-meta,
.viewer-code .hljs-meta .hljs-keyword,
.viewer-code .hljs-section { color: #89b4fa; }
.viewer-code .hljs-attr,
.viewer-code .hljs-attribute,
.viewer-code .hljs-property { color: #89dceb; }    /* sky */
.viewer-code .hljs-built_in,
.viewer-code .hljs-symbol,
.viewer-code .hljs-params { color: #f9e2af; }      /* yellow */
.viewer-code .hljs-tag,
.viewer-code .hljs-selector-class,
.viewer-code .hljs-selector-id { color: #f38ba8; } /* red */
.viewer-code .hljs-emphasis { font-style: italic; }
.viewer-code .hljs-strong { font-weight: bold; }
.viewer-code .hljs-link { color: #89b4fa; text-decoration: underline; }
.viewer-code .hljs-deletion { color: #f38ba8; }

/* ── Markdown rendered content ── */
.viewer-markdown {
  padding: 24px 32px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--aide-text-primary);
}

.viewer-markdown h1 { font-size: 1.6em; font-weight: 600; margin: 1.2em 0 0.6em; border-bottom: 1px solid var(--aide-surface-hover); padding-bottom: 0.3em; }
.viewer-markdown h1:first-child { margin-top: 0; }
.viewer-markdown h2 { font-size: 1.35em; font-weight: 600; margin: 1.1em 0 0.5em; border-bottom: 1px solid var(--aide-surface-hover); padding-bottom: 0.25em; }
.viewer-markdown h2:first-child { margin-top: 0; }
.viewer-markdown h3 { font-size: 1.15em; font-weight: 600; margin: 1em 0 0.4em; }
.viewer-markdown h3:first-child { margin-top: 0; }
.viewer-markdown h4 { font-size: 1em; font-weight: 600; margin: 0.9em 0 0.3em; }
.viewer-markdown h4:first-child { margin-top: 0; }

.viewer-markdown p { margin: 0.6em 0; }
.viewer-markdown a { color: var(--aide-accent); text-decoration: none; }
.viewer-markdown a:hover { text-decoration: underline; }

.viewer-markdown ul, .viewer-markdown ol { padding-left: 1.5em; margin: 0.5em 0; }
.viewer-markdown li { margin: 0.2em 0; }
.viewer-markdown li > input[type="checkbox"] { margin-right: 6px; }

.viewer-markdown blockquote {
  margin: 0.6em 0;
  padding: 4px 14px;
  border-left: 3px solid var(--aide-accent);
  color: var(--aide-text-secondary);
  background: var(--aide-bg-deep);
  border-radius: 0 4px 4px 0;
}

.viewer-markdown code {
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 0.9em;
  background: var(--aide-bg-deep);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--aide-warning);
}

.viewer-markdown pre {
  margin: 0.8em 0;
  border-radius: 8px;
  overflow: hidden;
}
.viewer-markdown pre code {
  display: block;
  padding: 14px 18px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border-radius: 8px;
  overflow-x: auto;
}

.viewer-markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
}
.viewer-markdown th, .viewer-markdown td {
  border: 1px solid var(--aide-surface-hover);
  padding: 8px 12px;
  text-align: left;
}
.viewer-markdown th {
  background: var(--aide-bg-deep);
  font-weight: 600;
}
.viewer-markdown tr:nth-child(even) td {
  background: var(--aide-border-subtle);
}

.viewer-markdown hr {
  border: none;
  border-top: 1px solid var(--aide-surface-hover);
  margin: 1em 0;
}

.viewer-markdown img {
  max-width: 100%;
  border-radius: 6px;
}

/* marked uses these classes for hljs code in markdown */
.viewer-markdown pre code.hljs .hljs-keyword,
.viewer-markdown pre code.hljs .hljs-selector-tag,
.viewer-markdown pre code.hljs .hljs-type { color: #cba6f7; }
.viewer-markdown pre code.hljs .hljs-string,
.viewer-markdown pre code.hljs .hljs-addition,
.viewer-markdown pre code.hljs .hljs-regexp { color: #a6e3a1; }
.viewer-markdown pre code.hljs .hljs-number,
.viewer-markdown pre code.hljs .hljs-literal,
.viewer-markdown pre code.hljs .hljs-variable,
.viewer-markdown pre code.hljs .hljs-template-variable,
.viewer-markdown pre code.hljs .hljs-tag .hljs-attr { color: #fab387; }
.viewer-markdown pre code.hljs .hljs-comment,
.viewer-markdown pre code.hljs .hljs-quote { color: #6c7086; font-style: italic; }
.viewer-markdown pre code.hljs .hljs-title,
.viewer-markdown pre code.hljs .hljs-title.class_,
.viewer-markdown pre code.hljs .hljs-title.class_.inherited__,
.viewer-markdown pre code.hljs .hljs-title.function_ { color: #89b4fa; }
.viewer-markdown pre code.hljs .hljs-meta,
.viewer-markdown pre code.hljs .hljs-meta .hljs-keyword,
.viewer-markdown pre code.hljs .hljs-section { color: #89b4fa; }
.viewer-markdown pre code.hljs .hljs-attr,
.viewer-markdown pre code.hljs .hljs-attribute,
.viewer-markdown pre code.hljs .hljs-property { color: #89dceb; }
.viewer-markdown pre code.hljs .hljs-built_in,
.viewer-markdown pre code.hljs .hljs-symbol,
.viewer-markdown pre code.hljs .hljs-params { color: #f9e2af; }
.viewer-markdown pre code.hljs .hljs-tag,
.viewer-markdown pre code.hljs .hljs-selector-class,
.viewer-markdown pre code.hljs .hljs-selector-id { color: #f38ba8; }
.viewer-markdown pre code.hljs .hljs-emphasis { font-style: italic; }
.viewer-markdown pre code.hljs .hljs-strong { font-weight: bold; }
.viewer-markdown pre code.hljs .hljs-link { color: #89b4fa; text-decoration: underline; }
.viewer-markdown pre code.hljs .hljs-deletion { color: #f38ba8; }

/* ── Diff viewer（着色规则见 src/styles/global.css 的 aide-diff-*）── */
.viewer-diff {
  display: block;
  padding: 12px 16px;
  margin: 0;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aide-text-primary);
  white-space: pre;
  tab-size: 4;
}
</style>
