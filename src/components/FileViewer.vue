<script setup lang="ts">
import { computed, watch, ref, nextTick } from "vue";
import { useFileViewer } from "../composables/useFileViewer";
import { Marked } from "marked";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("plaintext", plaintext);

const marked = new Marked({
  gfm: true,
  breaks: false,
});

// Override code renderer to use highlight.js
const originalRenderer = marked.options;
marked.setOptions({
  ...originalRenderer,
});

// Patch marked's code tokenizer to use hljs
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      if (lang && hljs.getLanguage(lang)) {
        const result = hljs.highlight(text, { language: lang });
        return `<pre><code class="hljs language-${lang}">${result.value}</code></pre>`;
      }
      // Auto-detect
      const result = hljs.highlightAuto(text);
      return `<pre><code class="hljs">${result.value}</code></pre>`;
    },
  },
});

const extToLang: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  rs: "rust",
  json: "json", jsonc: "json",
  xml: "xml", html: "html", htm: "html", vue: "html", svelte: "html",
  css: "css", scss: "css", less: "css",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "bash",
  py: "python", pyw: "python",
  md: "markdown", mdx: "markdown",
  yaml: "yaml", yml: "yaml",
  sql: "sql",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  gitignore: "plaintext", env: "plaintext",
};

const { visible, filePath, content, error, editing, editContent, saving, close, startEdit, save, cancelEdit } = useFileViewer();

const codeRef = ref<HTMLElement | null>(null);

const fileName = computed(() => {
  return filePath.value.split(/[/\\]/).pop() || filePath.value;
});

const isMarkdown = computed(() => {
  const ext = fileName.value.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "mdx";
});

const highlighted = computed(() => {
  if (!content.value) return "";
  const ext = fileName.value.split(".").pop()?.toLowerCase() || "";
  const lang = extToLang[ext] || "plaintext";
  try {
    const result = hljs.highlight(content.value, { language: lang });
    return result.value;
  } catch {
    // Fallback: auto-detect
    const result = hljs.highlightAuto(content.value);
    return result.value;
  }
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
          <button v-if="!error" class="viewer-btn" :class="{ primary: editing }" @click="editing ? save() : startEdit()">
            {{ editing ? '保存' : '编辑' }}
          </button>
          <span v-if="editing" class="viewer-hint">Esc 取消 · Ctrl+S 保存</span>
          <button class="viewer-close" @click="close">&times;</button>
        </div>
        <div class="viewer-body">
          <div v-if="error" class="viewer-error">{{ error }}</div>
          <div v-else-if="editing" class="viewer-editor">
            <textarea v-model="editContent" class="viewer-textarea" spellcheck="false"></textarea>
          </div>
          <div v-else-if="isMarkdown" ref="codeRef" class="viewer-markdown" v-html="renderedMarkdown"></div>
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
  background: rgba(0, 0, 0, 0.5);
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
  background: var(--surface);
  border: 1px solid var(--surface-hover);
  border-radius: 10px;
  width: min(90vw, 900px);
  height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
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
  border-bottom: 1px solid var(--surface-hover);
  flex-shrink: 0;
}

.viewer-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.viewer-lang {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 4px;
  text-transform: uppercase;
}

.viewer-path {
  flex: 1;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.viewer-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 4px;
  transition: all 0.1s;
}
.viewer-close:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.viewer-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--surface-hover);
  color: var(--text-secondary);
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.1s;
}
.viewer-btn:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}
.viewer-btn.primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.viewer-btn.primary:hover {
  opacity: 0.9;
}

.viewer-hint {
  flex: 1;
  text-align: right;
  font-size: 11px;
  color: var(--text-muted);
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
  color: var(--accent-red);
  font-size: 13px;
}

.viewer-textarea {
  flex: 1;
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-primary);
  color: var(--text-primary);
  border: none;
  margin: 0;
  padding: 16px;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: none;
  outline: none;
}

.viewer-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.viewer-code {
  display: block;
  padding: 16px;
  margin: 0;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre;
  tab-size: 4;
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
  color: var(--text-primary);
}

.viewer-markdown h1 { font-size: 1.6em; font-weight: 600; margin: 1.2em 0 0.6em; border-bottom: 1px solid var(--surface-hover); padding-bottom: 0.3em; }
.viewer-markdown h1:first-child { margin-top: 0; }
.viewer-markdown h2 { font-size: 1.35em; font-weight: 600; margin: 1.1em 0 0.5em; border-bottom: 1px solid var(--surface-hover); padding-bottom: 0.25em; }
.viewer-markdown h2:first-child { margin-top: 0; }
.viewer-markdown h3 { font-size: 1.15em; font-weight: 600; margin: 1em 0 0.4em; }
.viewer-markdown h3:first-child { margin-top: 0; }
.viewer-markdown h4 { font-size: 1em; font-weight: 600; margin: 0.9em 0 0.3em; }
.viewer-markdown h4:first-child { margin-top: 0; }

.viewer-markdown p { margin: 0.6em 0; }
.viewer-markdown a { color: var(--accent); text-decoration: none; }
.viewer-markdown a:hover { text-decoration: underline; }

.viewer-markdown ul, .viewer-markdown ol { padding-left: 1.5em; margin: 0.5em 0; }
.viewer-markdown li { margin: 0.2em 0; }
.viewer-markdown li > input[type="checkbox"] { margin-right: 6px; }

.viewer-markdown blockquote {
  margin: 0.6em 0;
  padding: 4px 14px;
  border-left: 3px solid var(--accent);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 0 4px 4px 0;
}

.viewer-markdown code {
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 0.9em;
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  color: #fab387;
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
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border-radius: 8px;
  overflow-x: auto;
}

.viewer-markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
}
.viewer-markdown th, .viewer-markdown td {
  border: 1px solid var(--surface-hover);
  padding: 8px 12px;
  text-align: left;
}
.viewer-markdown th {
  background: var(--bg-tertiary);
  font-weight: 600;
}
.viewer-markdown tr:nth-child(even) td {
  background: rgba(255, 255, 255, 0.02);
}

.viewer-markdown hr {
  border: none;
  border-top: 1px solid var(--surface-hover);
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
</style>
