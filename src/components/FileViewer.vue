<script setup lang="ts">
import { computed, watch, ref, nextTick } from "vue";
import { useFileViewer } from "../composables/useFileViewer";
import { useGotoDefinition } from "../composables/useGotoDefinition";
import CodeEditor from "./CodeEditor.vue";
import { hljs, extToLang, highlightCode } from "../utils/highlight";
import { marked } from "../utils/markdown";

const { visible, filePath, content, language, error, editing, editContent, saving, close, startEdit, save, cancelEdit, projectRoot, openAndScrollTo } = useFileViewer();

const goto = useGotoDefinition();
const gotoPopoverRef = ref<HTMLElement | null>(null);
const codeEditorRef = ref<InstanceType<typeof CodeEditor> | null>(null);

// 处理跳转到定义
async function onGotoDefinition(payload: { word: string; filePath: string }) {
  await goto.search(payload.word, projectRoot.value);
}

// 搜索所有引用（从浮层空状态触发）
async function onSearchAllReferences() {
  await goto.searchAllReferences(goto.searchWord.value, projectRoot.value);
}

// 处理选中跳转结果
async function onGotoResultSelect(match: { file: string; line: number }) {
  goto.dismiss();
  // 构建绝对路径
  const separator = projectRoot.value.includes("\\") ? "\\" : "/";
  const targetPath = projectRoot.value + separator + match.file.replace(/\//g, separator);
  const result = await openAndScrollTo(targetPath, match.line);
  // Wait for CodeEditor's async createEditor() to finish before scrolling
  await codeEditorRef.value?.waitReady();
  codeEditorRef.value?.scrollToLine(result.line);
}

// 在浮层上用键盘导航
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
    if (selected) {
      onGotoResultSelect(selected);
    }
  }
}

const codeRef = ref<HTMLElement | null>(null);

const fileName = computed(() => {
  return filePath.value.split(/[/\\]/).pop() || filePath.value;
});

const isMarkdown = computed(() => {
  const ext = fileName.value.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "mdx";
});

const isDiff = computed(() => language.value === "diff");

const diffHighlighted = computed(() => {
  if (!content.value) return "";
  return content.value.split("\n").map((line) => {
    let cls = "diff-ctx";
    if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-del";
    else if (line.startsWith("@@")) cls = "diff-hunk";
    else if (line.startsWith("diff ") || line.startsWith("index ") ||
             line.startsWith("--- ") || line.startsWith("+++ ") ||
             line.startsWith("new file") || line.startsWith("deleted file"))
      cls = "diff-meta";
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }).join("\n");
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const highlighted = computed(() => {
  if (!content.value) return "";
  const ext = fileName.value.split(".").pop()?.toLowerCase() || "";
  return highlightCode(content.value, ext);
});

const renderedMarkdown = computed(() => {
  if (!content.value) return "";
  try {
    return marked.parse(content.value) as string;
  } catch {
    return content.value;
  }
});

watch(visible, async (v) => {
  if (v) {
    await nextTick();
    codeRef.value?.scrollTo(0, 0);
  }
});

watch(goto.visible, (v) => {
  if (v) {
    nextTick(() => gotoPopoverRef.value?.focus());
  }
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (editing.value) {
      cancelEdit();
    } else {
      close();
    }
  }
  if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (editing.value) {
      save();
    }
  }
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains("viewer-overlay")) {
    close();
  }
}

function getLanguageLabel(): string {
  const ext = fileName.value.split(".").pop()?.toLowerCase() || "";
  return extToLang[ext] || ext || "text";
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="viewer-overlay" @click="onOverlayClick" @keydown="onKeydown">
      <div class="viewer-dialog" @click.stop>
        <div class="viewer-header">
          <span class="viewer-title">{{ fileName }}</span>
          <span class="viewer-lang">{{ getLanguageLabel() }}</span>
          <span class="viewer-path" :title="filePath">{{ filePath }}</span>
          <button
            v-if="!error"
            class="viewer-btn"
            :class="{ primary: editing }"
            :disabled="content.length > 1_000_000"
            :title="content.length > 1_000_000 ? '文件过大，不支持编辑' : ''"
            @click="editing ? save() : startEdit()"
          >
            {{ editing ? '保存' : '编辑' }}
          </button>
          <span v-if="editing" class="viewer-hint">Esc 取消 · Ctrl+S 保存</span>
          <button class="viewer-close" @click="close">&times;</button>
        </div>
        <div class="viewer-body">
          <div v-if="error" class="viewer-error">{{ error }}</div>
          <div v-else-if="editing" class="viewer-editor">
            <CodeEditor
              ref="codeEditorRef"
              v-model="editContent"
              :filePath="filePath"
              @goto-definition="onGotoDefinition"
            />
            <!-- 跳转结果浮层 -->
            <div v-if="goto.visible.value" ref="gotoPopoverRef" tabindex="-1" class="goto-popover" @keydown="onGotoKeydown">
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
          <div v-else-if="isMarkdown" ref="codeRef" class="viewer-markdown" v-html="renderedMarkdown"></div>
          <pre v-else-if="isDiff"><code ref="codeRef" class="viewer-code viewer-diff" v-html="diffHighlighted"></code></pre>
          <pre v-else><code ref="codeRef" class="viewer-code" v-html="highlighted"></code></pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer-overlay {
  position: fixed;
  inset: 0;
  background: var(--aide-bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.12s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.viewer-dialog {
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-lg);
  width: min(90vw, 900px);
  height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--aide-shadow-lg);
  animation: scaleIn 0.15s ease;
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.viewer-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--aide-surface-hover);
  flex-shrink: 0;
}

.viewer-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
}

.viewer-lang {
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
}

.viewer-path {
  flex: 1;
  font-size: 11px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.viewer-close {
  background: none;
  border: none;
  color: var(--aide-text-secondary);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 4px;
  transition: all 0.15s ease;
}
.viewer-close:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.viewer-btn {
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-surface-hover);
  color: var(--aide-text-secondary);
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.viewer-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.viewer-btn.primary {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  border-color: var(--aide-accent);
}
.viewer-btn.primary:hover {
  opacity: 0.9;
}
.viewer-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.viewer-hint {
  flex: 1;
  text-align: right;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.viewer-body {
  flex: 1;
  overflow: auto;
  padding: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.viewer-error {
  padding: 24px;
  color: var(--aide-danger);
  font-size: 13px;
}

.viewer-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

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
  animation: slideUp 0.12s ease;
}

@keyframes slideUp {
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

<!-- Highlight.js theme overrides (unscoped — applied to generated markup) -->
<style>
/* We register hljs classes globally so the vue scoped attr doesn't break them */
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

/* ── Diff viewer ── */
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
.viewer-diff .diff-add { color: var(--aide-success); background: color-mix(in srgb, var(--aide-success) 4%, transparent); display: block; }
.viewer-diff .diff-del { color: var(--aide-danger); background: color-mix(in srgb, var(--aide-danger) 4%, transparent); display: block; }
.viewer-diff .diff-hunk { color: var(--aide-info); display: block; }
.viewer-diff .diff-meta { color: var(--aide-warning); display: block; }
.viewer-diff .diff-ctx { color: var(--aide-text-muted); display: block; }
</style>
