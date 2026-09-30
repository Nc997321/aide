<script setup lang="ts">
// 版本历史（revisions）与回滚（revert）。
//
// 数据自己拉（kb.revisions）而不走 useKnowledgeBase：版本列表是这块面板的
// 瞬时数据，打开才拉、关掉即弃，放进面板级 composable 只会污染全局状态。
// 回滚完成后 emit reverted，由父层刷新 activeDoc——文档正文永远只有一个来源。
//
// revert 的语义（与后端 domain/versioning.rs 一致）：基于旧版本内容**创建新版本**，
// 不物理删除中间历史——所以回滚本身也出现在这张列表里，永远可以再回滚回去。
import { onMounted, ref } from "vue";
import { kb, KbError } from "./kbClient";
import type { KbDocument } from "./kbClient";

const props = defineProps<{ doc: KbDocument }>();
const emit = defineEmits<{ reverted: [] }>();

interface RevisionRow {
  id: string;
  versionNo: number;
  title: string;
  authorName: string | null;
  changeNote: string | null;
  createdAt: string;
}

const rows = ref<RevisionRow[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const reverting = ref<number | null>(null);

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    rows.value = await kb.revisions(props.doc.id);
  } catch (e) {
    error.value = e instanceof KbError ? e.message : `加载版本历史失败：${String(e)}`;
  } finally {
    loading.value = false;
  }
}

async function revertTo(versionNo: number): Promise<void> {
  if (reverting.value !== null) return;
  // 不用 window.confirm：回滚不删历史，可再回滚回来，风险本身可控，
  // 提示文案把「创建新版本」这个语义讲清楚就够了
  reverting.value = versionNo;
  error.value = null;
  try {
    await kb.revert(props.doc.id, versionNo);
    emit("reverted");
  } catch (e) {
    error.value = e instanceof KbError ? e.message : `回滚失败：${String(e)}`;
    reverting.value = null;
  }
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
</script>

<template>
  <div class="kb-history">
    <header class="kb-hist-head">
      <h3>版本历史</h3>
      <button class="kb-link" @click="emit('reverted')">关闭</button>
    </header>
    <p v-if="error" class="kb-err">{{ error }}</p>
    <p v-if="loading" class="kb-none">加载中…</p>

    <ul v-else class="kb-hist-list">
      <li v-for="r in rows" :key="r.id" class="kb-hist-row">
        <span class="kb-hist-ver" :class="{ cur: r.versionNo === doc.versionNo }">
          v{{ r.versionNo }}
        </span>
        <div class="kb-hist-main">
          <span class="kb-hist-title">{{ r.title }}</span>
          <!-- 作者与时间靠间距分开，不用中点连（中点是"模板感"最典型的记号之一） -->
          <span class="kb-hist-meta">
            <span class="kb-hist-author">{{ r.authorName ?? "未知作者" }}</span>
            <time>{{ fmt(r.createdAt) }}</time>
          </span>
          <span v-if="r.changeNote" class="kb-hist-note">{{ r.changeNote }}</span>
        </div>
        <span v-if="r.versionNo === doc.versionNo" class="kb-hist-cur">当前</span>
        <button
          v-else
          class="kb-link"
          :disabled="reverting !== null"
          @click="revertTo(r.versionNo)"
        >
          {{ reverting === r.versionNo ? "回滚中…" : "回滚到此版" }}
        </button>
      </li>
    </ul>
    <p v-if="!loading && rows.length === 0" class="kb-none">还没有版本记录</p>
  </div>
</template>

<style scoped>
/* 版本列表与检索结果同一套：一条一条 + hairline，没有卡片、没有胶囊。 */

.kb-history {
  height: 100%;
  overflow: auto;
  padding: 40px 24px 88px;
}
.kb-history > * {
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
}
.kb-hist-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20px;
}
.kb-hist-head h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--aide-text-primary);
  letter-spacing: -0.005em;
}
.kb-hist-list {
  list-style: none;
  /* 只写上下：左右交给 `.kb-history > *` 的 auto 居中 */
  margin-top: 0;
  margin-bottom: 0;
  padding: 0;
}
.kb-hist-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--aide-border-subtle);
}
.kb-hist-row:last-child { border-bottom: none; }
/* 版本号是静默的等宽小字，不是胶囊 */
.kb-hist-ver {
  flex: none;
  width: 34px;
  padding-top: 1px;
  font-size: 12px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}
.kb-hist-ver.cur { color: var(--aide-accent); }
.kb-hist-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kb-hist-title {
  font-size: 14px;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-hist-meta {
  display: flex;
  gap: 12px;
  font-size: 11.5px;
  color: var(--aide-text-muted);
  overflow: hidden;
  white-space: nowrap;
}
.kb-hist-author { flex: none; }
.kb-hist-meta time { font-variant-numeric: tabular-nums; }
.kb-hist-note {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--aide-text-secondary);
}
.kb-hist-cur {
  flex: none;
  font-size: 11.5px;
  color: var(--aide-accent);
}
.kb-link {
  flex: none;
  border: none;
  background: none;
  padding: 2px 0;
  font: inherit;
  font-size: 11.5px;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: color var(--aide-ease-t);
}
.kb-link:hover:not(:disabled) { color: var(--aide-text-primary); }
.kb-link:disabled { opacity: 0.4; cursor: default; }
.kb-link:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); border-radius: 3px; }
.kb-err {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--aide-danger);
}
.kb-none {
  font-size: 13px;
  color: var(--aide-text-muted);
}
</style>
