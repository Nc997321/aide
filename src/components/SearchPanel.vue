<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { api } from "../api";
import type { SearchMatch, SearchOptions, SearchResponse } from "../types";
import { useFileViewer } from "../composables/useFileViewer";

const props = defineProps<{
  workspacePath: string;
}>();

const query = ref("");
const useRegex = ref(false);
const caseSensitive = ref(false);
const wholeWord = ref(false);
const fileMask = ref("");
const searching = ref(false);
const error = ref("");
const result = ref<SearchResponse | null>(null);
const expanded = ref<Set<string>>(new Set());

let seq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const options = computed<SearchOptions>(() => ({
  useRegex: useRegex.value,
  caseSensitive: caseSensitive.value,
  wholeWord: wholeWord.value,
  fileMask: fileMask.value.trim() || null,
  limit: 500,
}));

watch([query, useRegex, caseSensitive, wholeWord, fileMask], () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 300);
});

async function runSearch() {
  const mySeq = ++seq;
  const q = query.value.trim();
  if (!q) {
    result.value = null;
    error.value = "";
    return;
  }
  searching.value = true;
  error.value = "";
  try {
    const res = await api.searchInFiles(q, props.workspacePath, options.value);
    if (mySeq !== seq) return; // 竞态：丢弃过期结果
    result.value = res;
    expanded.value = new Set(res.files.map((g) => g.file)); // 新结果默认全展开（IDEA 习惯）
  } catch (e) {
    if (mySeq !== seq) return;
    error.value = String(e);
    result.value = null;
  } finally {
    if (mySeq === seq) searching.value = false;
  }
}

/** 相对路径 + 工作区根 → 绝对路径（Windows 盘符路径用 / 拼接，Rust 侧可吃） */
function joinPath(base: string, rel: string): string {
  return base.replace(/\\/g, "/").replace(/\/+$/, "") + "/" + rel.replace(/\\/g, "/");
}

/** byte 偏移 → UTF-16 索引（Rust 返回 byte 偏移，JS 字符串是 UTF-16，CJK 需转换） */
function byteToUtf16(s: string, byteOffset: number): number {
  const enc = new TextEncoder();
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    if (bytes >= byteOffset) return i;
    bytes += enc.encode(s[i]).length;
  }
  return s.length;
}

function highlight(m: SearchMatch): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const start = byteToUtf16(m.lineText, m.matchStart);
  const end = byteToUtf16(m.lineText, m.matchEnd);
  return (
    esc(m.lineText.slice(0, start)) +
    "<mark>" + esc(m.lineText.slice(start, end)) + "</mark>" +
    esc(m.lineText.slice(end))
  );
}

function onMatchClick(m: SearchMatch) {
  const viewer = useFileViewer();
  viewer.openAndScrollTo(joinPath(props.workspacePath, m.file), m.line);
}

function toggleGroup(file: string) {
  const s = new Set(expanded.value);
  if (s.has(file)) s.delete(file);
  else s.add(file);
  expanded.value = s;
}
</script>

<template>
  <div class="search-panel">
    <div class="search-input-row">
      <input v-model="query" class="search-input" placeholder="搜索工作区…" spellcheck="false" />
      <button v-if="query" class="clear-btn" @click="query = ''">×</button>
    </div>
    <div class="option-row">
      <label class="opt"><input type="checkbox" v-model="useRegex" /> 正则</label>
      <label class="opt"><input type="checkbox" v-model="caseSensitive" /> Aa</label>
      <label class="opt"><input type="checkbox" v-model="wholeWord" /> 全词</label>
      <input v-model="fileMask" class="mask-input" placeholder="掩码 *.ts,*.vue" spellcheck="false" />
    </div>
    <div v-if="error" class="error-line">{{ error }}</div>
    <div v-if="searching" class="status-line">搜索中…</div>
    <div v-else-if="result && result.total === 0" class="status-line">无结果</div>
    <div v-else-if="result" class="result-list">
      <div v-for="g in result.files" :key="g.file" class="file-group">
        <div class="file-head" @click="toggleGroup(g.file)">
          <span class="chevron">{{ expanded.has(g.file) ? "▾" : "▸" }}</span>
          <span class="file-name">{{ g.file }}</span>
          <span class="file-count">{{ g.matches.length }}</span>
        </div>
        <div v-if="expanded.has(g.file)" class="match-list">
          <div v-for="(m, i) in g.matches" :key="i" class="match-row" @click="onMatchClick(m)">
            <span class="line-no">{{ m.line }}</span>
            <span class="line-text" v-html="highlight(m)"></span>
          </div>
        </div>
      </div>
      <div v-if="result.truncated" class="status-line">结果已截断（仅显示前 {{ result.total }} 处）</div>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  height: 100%;
  overflow: hidden;
  color: var(--aide-text);
  font-size: 13px;
}
.search-input-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.search-input,
.mask-input,
.replace-input {
  flex: 1;
  min-width: 0;
  background: var(--aide-surface);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius);
  color: var(--aide-text);
  padding: 4px 8px;
  font-size: 13px;
  outline: none;
}
.search-input:focus,
.mask-input:focus,
.replace-input:focus {
  border-color: var(--aide-accent);
}
.clear-btn {
  background: none;
  border: none;
  color: var(--aide-text-dim);
  cursor: pointer;
  font-size: 14px;
}
.option-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--aide-text-dim);
}
.opt {
  display: flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  user-select: none;
}
.mask-input {
  flex: 1;
  min-width: 90px;
  padding: 2px 6px;
  font-size: 12px;
}
.error-line {
  color: var(--aide-danger);
  font-size: 12px;
  word-break: break-all;
}
.status-line {
  color: var(--aide-text-dim);
  font-size: 12px;
  padding: 2px 0;
}
.result-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.file-group {
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius);
  overflow: hidden;
}
.file-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  background: var(--aide-surface);
  user-select: none;
}
.file-head:hover {
  background: var(--aide-surface-hover);
}
.chevron {
  font-size: 14px;
  color: var(--aide-text-dim);
}
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aide-font-mono);
  font-size: 12px;
}
.file-count {
  color: var(--aide-text-dim);
  font-size: 11px;
}
.match-list {
  border-top: 1px solid var(--aide-border);
}
.match-row {
  display: flex;
  gap: 8px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.match-row:hover {
  background: var(--aide-surface-hover);
}
.line-no {
  color: var(--aide-text-dim);
  font-size: 11px;
  min-width: 28px;
  text-align: right;
  user-select: none;
}
.line-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--aide-font-mono);
  font-size: 12px;
}
.line-text :deep(mark) {
  background: var(--aide-accent);
  color: var(--aide-bg);
  border-radius: 2px;
  padding: 0 1px;
}
</style>
