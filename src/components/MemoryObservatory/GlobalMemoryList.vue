<script setup lang="ts">
/**
 * 全局记忆清单（P2 跨项目只读聚合）：全局健康 stat + 搜索 + 按项目分组的记忆行。
 * 预览走 readFile(projectKey, name)（单项目命令对任意 key 都成立），删除复用
 * 单项目删除命令；确认流行内展开。预览缓存在本组件本地（跨项目同名文件要区分 key）。
 */
import { computed, reactive, ref } from "vue";
import { memoryObservatoryApi, CLAUDE_MD_ALIAS } from "@aide/sdk/api";
import type { ClaudeMdInfo, MemoryTopic, ProjectScanResult } from "@aide/sdk/api";
import { statusOf, STATUS_META, fmtDay, fmtSize } from "./observatory";

const props = defineProps<{
  projects: ProjectScanResult[];
  /** workspaceKey → 显示名（来自工作区列表，未登记的回落为 key 本身）。 */
  projectNames: Record<string, string>;
  claudeMd: ClaudeMdInfo | null;
  deleting: boolean;
}>();
const emit = defineEmits<{ delete: [key: string, name: string] }>();

const query = ref("");

const totals = computed(() => {
  let topics = 0;
  let orphans = 0;
  let deadlinks = 0;
  for (const p of props.projects) {
    topics += p.scan.topics.length;
    orphans += p.scan.orphans.length;
    deadlinks += p.scan.deadlinks.length;
  }
  return { projects: props.projects.length, topics, orphans, deadlinks };
});

interface Row {
  key: string; // `${projectKey}/${name}`
  projectKey: string;
  name: string;
  title: string;
  desc: string;
  size: number;
  modifiedMs: number | null;
  status: "indexed" | "edge" | "orphan";
}

function rowOf(projectKey: string, scan: ProjectScanResult["scan"], t: MemoryTopic): Row {
  const e = scan.index?.entries.find((x) => x.file === t.name);
  return {
    key: `${projectKey}/${t.name}`,
    projectKey,
    name: t.name,
    title: e?.title ?? t.name.replace(/\.md$/, ""),
    desc: e?.desc ?? "",
    size: t.size,
    modifiedMs: t.modifiedMs,
    status: statusOf(t),
  };
}

interface Group {
  key: string;
  name: string;
  rows: Row[];
  orphans: number;
  deadlinks: number;
}

const groups = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase();
  const out: Group[] = [];
  for (const p of props.projects) {
    let rows = p.scan.topics.map((t) => rowOf(p.key, p.scan, t));
    if (q) {
      rows = rows.filter((r) =>
        [r.title, r.desc, r.name, projectName(p.key)].some((s) => s.toLowerCase().includes(q)),
      );
    }
    if (rows.length === 0 && q) continue; // 搜索时隐藏无命中项目
    out.push({
      key: p.key,
      name: projectName(p.key),
      rows,
      orphans: p.scan.orphans.length,
      deadlinks: p.scan.deadlinks.length,
    });
  }
  return out;
});

function projectName(key: string): string {
  return props.projectNames[key] ?? key;
}

// ── 预览（本地缓存，跨项目同名用复合 key 区分）──
const previews = reactive(new Map<string, string>());
const openRow = ref<string | null>(null);

async function toggleRow(r: Row) {
  openRow.value = openRow.value === r.key ? null : r.key;
  if (openRow.value === r.key && !previews.has(r.key)) {
    previews.set(r.key, await memoryObservatoryApi.readFile(r.projectKey, r.name));
  }
}

const claudeMdOpen = ref(false);
async function toggleClaudeMd() {
  claudeMdOpen.value = !claudeMdOpen.value;
  if (claudeMdOpen.value && !previews.has(CLAUDE_MD_ALIAS)) {
    // CLAUDE_MD_ALIAS 后端特判，projectKey 任意
    previews.set(CLAUDE_MD_ALIAS, await memoryObservatoryApi.readFile(props.projects[0]?.key ?? "", CLAUDE_MD_ALIAS));
  }
}

// ── 行内删除确认 ──
const confirming = ref<string | null>(null);

function badgeClass(s: Row["status"]): string {
  return { indexed: "b-ok", edge: "b-edge", orphan: "b-orphan" }[s];
}
</script>

<template>
  <div>
    <!-- 全局健康 stat -->
    <div class="stats">
      <div class="stat">
        <div class="v">{{ totals.projects }}</div>
        <div class="l">项目</div>
      </div>
      <div class="stat">
        <div class="v">{{ totals.topics }}</div>
        <div class="l">记忆总数</div>
      </div>
      <div class="stat" :class="{ warn: totals.orphans > 0 }">
        <div class="v">{{ totals.orphans }}</div>
        <div class="l">孤儿 · 索引未引用</div>
      </div>
      <div class="stat" :class="{ warn: totals.deadlinks > 0 }">
        <div class="v">{{ totals.deadlinks }}</div>
        <div class="l">死链 · 文件不存在</div>
      </div>
    </div>

    <!-- 搜索 -->
    <div class="search">
      <input v-model="query" type="search" placeholder="搜索记忆 / 描述 / 项目…" spellcheck="false" />
    </div>

    <!-- 按项目分组 -->
    <div v-for="g in groups" :key="g.key" class="group">
      <div class="group-head">
        <span class="gname">{{ g.name }}</span>
        <span class="gmeta">{{ g.rows.length }} 条</span>
        <span v-if="g.orphans" class="gmeta warn">{{ g.orphans }} 孤儿</span>
        <span v-if="g.deadlinks" class="gmeta danger">{{ g.deadlinks }} 死链</span>
      </div>
      <div v-for="r in g.rows" :key="r.key" class="row">
        <div class="row-main" @click="toggleRow(r)">
          <div class="row-title">
            <span class="t">{{ r.title }}</span>
            <span v-if="r.desc" class="d">{{ r.desc }}</span>
          </div>
          <span class="size">{{ fmtSize(r.size) }}</span>
          <span class="date">{{ fmtDay(r.modifiedMs) }}</span>
          <span class="badge" :class="badgeClass(r.status)">{{ STATUS_META[r.status].label }}</span>
          <button class="del" title="删除记忆" @click.stop="confirming = r.key">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
        <div v-if="openRow === r.key" class="row-preview">{{ previews.get(r.key) ?? "读取中…" }}</div>
        <div v-if="confirming === r.key" class="row-confirm">
          <span class="q">
            删除「{{ r.title }}」？
            <small>{{ g.name }} 的 topic 文件将被删除；若被其 MEMORY.md 引用，索引行一并移除。此操作不可撤销。</small>
          </span>
          <button class="btn danger" :disabled="deleting" @click="emit('delete', r.projectKey, r.name); confirming = null">删除</button>
          <button class="btn" :disabled="deleting" @click="confirming = null">取消</button>
        </div>
      </div>
    </div>
    <div v-if="groups.length === 0" class="empty">{{ query ? "无匹配条目" : "所有项目都还没有记忆" }}</div>

    <!-- 全局指令（全用户一份） -->
    <template v-if="claudeMd">
      <div class="section-label">全局指令 · 每会话全量加载</div>
      <div class="row">
        <div class="row-main" @click="toggleClaudeMd">
          <div class="row-title">
            <span class="t">CLAUDE.md</span>
            <span class="d">{{ claudeMd.path }}</span>
          </div>
          <span class="size">{{ fmtSize(claudeMd.bytes) }}</span>
          <span class="date">{{ fmtDay(claudeMd.modifiedMs) }}</span>
          <span class="badge b-global">常驻</span>
          <span />
        </div>
        <div v-if="claudeMdOpen" class="row-preview">{{ previews.get(CLAUDE_MD_ALIAS) ?? "读取中…" }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stats { display: flex; gap: 44px; margin-bottom: 18px; }
.stat .v { font-size: 24px; font-weight: 600; color: var(--aide-text-primary); font-variant-numeric: tabular-nums; }
.stat .l { font-size: 11px; color: var(--aide-text-secondary); margin-top: 2px; }
.stat.warn .v { color: var(--aide-warning); }

.search { margin-bottom: 16px; }
.search input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 12px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
  font-size: 12.5px;
  outline: none;
}
.search input:focus { border-color: var(--aide-accent); }
.search input::placeholder { color: var(--aide-text-muted); }

.group { margin-bottom: 18px; }
.group-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 0 10px 6px;
  border-bottom: 1px solid var(--aide-border-subtle);
}
.gname { font-size: 12.5px; font-weight: 600; color: var(--aide-text-primary); }
.gmeta { font-size: 11px; color: var(--aide-text-muted); font-variant-numeric: tabular-nums; }
.gmeta.warn { color: var(--aide-warning); }
.gmeta.danger { color: var(--aide-danger); }

.row { border-bottom: 1px solid var(--aide-border-subtle); }
.row-main {
  display: grid;
  grid-template-columns: 1fr 56px 64px 68px 26px;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  cursor: pointer;
  border-radius: var(--aide-radius-sm);
}
.row-main:hover { background: var(--aide-surface-hover); }
.row-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.row-title .t { font-weight: 500; color: var(--aide-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; }
.row-title .d { color: var(--aide-text-muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 2; }
.size, .date { color: var(--aide-text-secondary); font-size: 11.5px; font-family: ui-monospace, Consolas, monospace; }
.badge { justify-self: start; padding: 0 7px; border-radius: 999px; font-size: 11px; border: 1px solid transparent; }
.b-ok { color: var(--aide-text-secondary); border-color: var(--aide-border); }
.b-edge { color: var(--aide-info); border-color: var(--aide-info); }
.b-orphan { color: var(--aide-warning); border-color: var(--aide-warning); }
.b-global { color: var(--aide-accent); border-color: var(--aide-accent); }
.del {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  opacity: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.row-main:hover .del { opacity: 1; }
.del:hover { color: var(--aide-danger); background: var(--aide-surface-active); }

.row-preview {
  margin: 0 10px 10px;
  padding: 12px 14px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  color: var(--aide-text-secondary);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow-y: auto;
}
.row-confirm {
  margin: 0 10px 10px;
  padding: 10px 14px;
  border: 1px solid var(--aide-danger);
  border-radius: var(--aide-radius-md);
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}
.row-confirm .q { flex: 1; color: var(--aide-text-primary); }
.row-confirm .q small { color: var(--aide-text-muted); display: block; margin-top: 1px; }
.btn {
  padding: 4px 13px;
  border-radius: var(--aide-radius-sm);
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--aide-border);
  background: transparent;
  color: var(--aide-text-primary);
}
.btn:hover { background: var(--aide-surface-hover); }
.btn.danger { background: var(--aide-danger); border-color: var(--aide-danger); color: var(--aide-text-on-accent); }
.btn:disabled { opacity: 0.5; cursor: default; }

.empty { padding: 28px 0; text-align: center; color: var(--aide-text-muted); font-size: 12px; }
.section-label { font-size: 11px; color: var(--aide-text-muted); letter-spacing: 0.05em; margin: 22px 0 8px; }
</style>
