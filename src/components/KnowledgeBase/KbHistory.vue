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
          <span class="kb-hist-meta">
            {{ r.authorName ?? "未知作者" }} · {{ fmt(r.createdAt) }}
            <template v-if="r.changeNote"> · {{ r.changeNote }}</template>
          </span>
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
.kb-history {
  height: 100%;
  overflow: auto;
  padding: 16px 20px 32px;
}
.kb-hist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--aide-border);
}
.kb-hist-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kb-hist-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.kb-hist-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--aide-border);
}
.kb-hist-ver {
  flex-shrink: 0;
  min-width: 36px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-family: var(--aide-font-mono);
  text-align: center;
  background: var(--aide-bg-deep);
  color: var(--aide-text-muted);
}
.kb-hist-ver.cur {
  color: var(--aide-accent);
}
.kb-hist-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kb-hist-title {
  font-size: 12px;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-hist-meta {
  font-size: 10px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-hist-cur {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-accent);
}
.kb-link {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  color: var(--aide-accent);
  cursor: pointer;
}
.kb-link:disabled { opacity: 0.5; cursor: default; }
.kb-err {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--aide-error, #d0453b);
}
.kb-none {
  font-size: 12px;
  color: var(--aide-text-muted);
}
</style>
