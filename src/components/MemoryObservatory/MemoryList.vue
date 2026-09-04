<script setup lang="ts">
/**
 * 记忆 tab：索引余量 stat 行 + 健康告警 chips + 记忆清单（预览 / 行内删除确认）
 * + 全局指令 CLAUDE.md 卡片。
 */
import { computed, ref } from "vue";
import type { MemoryEvent, MemoryScanResult, MemoryTopic } from "@aide/sdk/api";
import { CLAUDE_MD_ALIAS } from "@aide/sdk/api";
import { statusOf, STATUS_META, indexUsage, usageByMemory, sessionsOfMemory, fmtDay, fmtSize } from "./observatory";

const props = defineProps<{
  scan: MemoryScanResult;
  previews: Map<string, string>;
  confirming: string | null;
  deleting: boolean;
  events?: MemoryEvent[];
}>();
const emit = defineEmits<{
  preview: [name: string];
  confirm: [name: string | null];
  delete: [name: string];
}>();

const usage = computed(() => indexUsage(props.scan));
const alertCount = computed(() => props.scan.orphans.length + props.scan.deadlinks.length);

const filter = ref<"orphan" | "deadlink" | null>(null);
const openRow = ref<string | null>(null);

interface Row {
  key: string;
  title: string;
  desc: string;
  size: number | null;
  modifiedMs: number | null;
  status: "indexed" | "edge" | "orphan" | "deadlink";
  /** 删除/预览用的文件名；死链 = 索引里的目标名。 */
  file: string;
  deletable: boolean;
}

const rows = computed<Row[]>(() => {
  const list: Row[] = props.scan.topics.map((t: MemoryTopic) => ({
    key: t.name,
    title: titleOf(t),
    desc: descOf(t),
    size: t.size,
    modifiedMs: t.modifiedMs,
    status: statusOf(t),
    file: t.name,
    deletable: true,
  }));
  for (const dl of props.scan.deadlinks) {
    const e = props.scan.index?.entries.find((x) => x.file === dl);
    list.push({
      key: `dead:${dl}`,
      title: e?.title ?? dl,
      desc: "索引引用的文件已不存在",
      size: null,
      modifiedMs: null,
      status: "deadlink",
      file: dl,
      deletable: true, // 走「仅摘索引行」路径
    });
  }
  if (filter.value === "orphan") return list.filter((r) => r.status === "orphan");
  if (filter.value === "deadlink") return list.filter((r) => r.status === "deadlink");
  return list;
});

function titleOf(t: MemoryTopic): string {
  return props.scan.index?.entries.find((e) => e.file === t.name)?.title ?? t.name.replace(/\.md$/, "");
}
function descOf(t: MemoryTopic): string {
  return props.scan.index?.entries.find((e) => e.file === t.name)?.desc ?? "";
}

function badgeClass(s: Row["status"]): string {
  return { indexed: "b-ok", edge: "b-edge", orphan: "b-orphan", deadlink: "b-dead" }[s];
}
function badgeLabel(s: Row["status"]): string {
  return s === "deadlink" ? "死链" : STATUS_META[s].label;
}

function toggleRow(r: Row) {
  if (r.status === "deadlink") return; // 无文件可预览
  openRow.value = openRow.value === r.key ? null : r.key;
  if (openRow.value === r.key) emit("preview", r.file);
}

const claudeMdOpen = ref(false);
function toggleClaudeMd() {
  claudeMdOpen.value = !claudeMdOpen.value;
  if (claudeMdOpen.value) emit("preview", CLAUDE_MD_ALIAS);
}

// ── 使用统计（事件台账）：预览块头部展示「使用 N 次 · K 个会话 · 最近 MM-DD」──
const usageStats = computed(() => usageByMemory(props.events ?? []));
function usageLine(file: string): string | null {
  const u = usageStats.value.get(file);
  if (!u) return null;
  const sessions = sessionsOfMemory(props.events ?? [], file).size;
  return `使用 ${u.reads} 次 · ${sessions} 个会话 · 最近 ${fmtDay(u.lastTs)}`;
}
</script>

<template>
  <div>
    <!-- stat 行 -->
    <div class="stats">
      <div class="stat">
        <div class="v">{{ scan.index?.lines ?? 0 }}<small> / {{ scan.limits.maxLines }} 行</small></div>
        <div class="l">索引余量 · MEMORY.md</div>
        <div class="bar"><i :style="{ width: `${Math.round(usage.linePct * 100)}%` }" /></div>
      </div>
      <div class="stat">
        <div class="v">{{ fmtSize(scan.index?.bytes ?? 0) }}<small> / {{ fmtSize(scan.limits.maxBytes) }}</small></div>
        <div class="l">索引体积</div>
        <div class="bar"><i :style="{ width: `${Math.round(usage.bytePct * 100)}%` }" /></div>
      </div>
      <div class="stat">
        <div class="v">{{ scan.topics.length }}</div>
        <div class="l">记忆条目</div>
      </div>
      <div class="stat" :class="{ warn: alertCount > 0 }">
        <div class="v">{{ alertCount }}</div>
        <div class="l">健康告警</div>
      </div>
    </div>

    <!-- 告警筛选 -->
    <div v-if="alertCount > 0" class="chips">
      <span
        class="chip"
        :class="{ on: filter === 'orphan' }"
        @click="filter = filter === 'orphan' ? null : 'orphan'"
      >
        <i class="dot warn" />孤儿 · 索引未引用 <b>{{ scan.orphans.length }}</b>
      </span>
      <span
        class="chip"
        :class="{ on: filter === 'deadlink' }"
        @click="filter = filter === 'deadlink' ? null : 'deadlink'"
      >
        <i class="dot danger" />死链 · 文件不存在 <b>{{ scan.deadlinks.length }}</b>
      </span>
    </div>

    <!-- 清单 -->
    <div class="list-head"><span>记忆</span><span>大小</span><span>修改</span><span>状态</span><span /></div>
    <div v-for="r in rows" :key="r.key" class="row">
      <div class="row-main" @click="toggleRow(r)">
        <div class="row-title">
          <span class="t">{{ r.title }}</span>
          <span v-if="r.desc" class="d">{{ r.desc }}</span>
        </div>
        <span class="size">{{ r.size == null ? "—" : fmtSize(r.size) }}</span>
        <span class="date">{{ fmtDay(r.modifiedMs) }}</span>
        <span class="badge" :class="badgeClass(r.status)">{{ badgeLabel(r.status) }}</span>
        <button
          v-if="r.deletable"
          class="del"
          :title="r.status === 'deadlink' ? '从索引移除该条目' : '删除记忆'"
          @click.stop="emit('confirm', r.file)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
        <span v-else />
      </div>

      <div v-if="openRow === r.key" class="row-preview">
        <div v-if="usageLine(r.file)" class="preview-meta">{{ usageLine(r.file) }}</div>
        {{ previews.get(r.file) ?? "读取中…" }}
      </div>

      <div v-if="confirming === r.file" class="row-confirm">
        <span class="q">
          {{ r.status === "deadlink" ? `从索引移除「${r.title}」？` : `删除「${r.title}」？` }}
          <small>
            {{ r.status === "deadlink"
              ? "文件已不存在，仅移除 MEMORY.md 里的索引行。"
              : "topic 文件将被删除；若被 MEMORY.md 引用，索引行一并移除（防死链）。此操作不可撤销。" }}
          </small>
        </span>
        <button class="btn danger" :disabled="deleting" @click="emit('delete', r.file)">
          {{ r.status === "deadlink" ? "移除" : "删除" }}
        </button>
        <button class="btn" :disabled="deleting" @click="emit('confirm', null)">取消</button>
      </div>
    </div>
    <div v-if="rows.length === 0" class="empty">无匹配条目</div>

    <!-- 全局指令 -->
    <template v-if="scan.claudeMd">
      <div class="section-label">全局指令 · 每会话全量加载</div>
      <div class="row">
        <div class="row-main" @click="toggleClaudeMd">
          <div class="row-title">
            <span class="t">CLAUDE.md</span>
            <span class="d">{{ scan.claudeMd.path }}</span>
          </div>
          <span class="size">{{ fmtSize(scan.claudeMd.bytes) }}</span>
          <span class="date">{{ fmtDay(scan.claudeMd.modifiedMs) }}</span>
          <span class="badge b-global">常驻</span>
          <span />
        </div>
        <div v-if="claudeMdOpen" class="row-preview">{{ previews.get(CLAUDE_MD_ALIAS) ?? "读取中…" }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stats { display: flex; gap: 44px; margin-bottom: 20px; }
.stat .v {
  font-size: 24px;
  font-weight: 600;
  color: var(--aide-text-primary);
  font-variant-numeric: tabular-nums;
}
.stat .v small { font-size: 12px; color: var(--aide-text-muted); font-weight: 400; }
.stat .l { font-size: 11px; color: var(--aide-text-secondary); margin-top: 2px; }
.stat.warn .v { color: var(--aide-warning); }
.stat .bar { width: 110px; height: 3px; background: var(--aide-surface-active); border-radius: 2px; margin-top: 7px; overflow: hidden; }
.stat .bar i { display: block; height: 100%; background: var(--aide-accent); border-radius: 2px; }

.chips { display: flex; gap: 8px; margin-bottom: 16px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 11px;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
}
.chip:hover { color: var(--aide-text-primary); }
.chip.on { border-color: var(--aide-warning); color: var(--aide-warning); }
.chip b { font-variant-numeric: tabular-nums; }
.chip .dot { width: 6px; height: 6px; border-radius: 50%; }
.dot.warn { background: var(--aide-warning); }
.dot.danger { background: var(--aide-danger); }

.list-head {
  display: grid;
  grid-template-columns: 1fr 56px 64px 68px 26px;
  gap: 10px;
  padding: 0 10px 6px;
  font-size: 11px;
  color: var(--aide-text-muted);
  border-bottom: 1px solid var(--aide-border-subtle);
}
.row { border-bottom: 1px solid var(--aide-border-subtle); }
.row-main {
  display: grid;
  grid-template-columns: 1fr 56px 64px 68px 26px;
  gap: 10px;
  align-items: center;
  padding: 9px 10px;
  cursor: pointer;
  border-radius: var(--aide-radius-sm);
}
.row-main:hover { background: var(--aide-surface-hover); }
.row-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.row-title .t {
  font-weight: 500;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}
.row-title .d {
  color: var(--aide-text-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 2;
}
.size, .date {
  color: var(--aide-text-secondary);
  font-size: 11.5px;
  font-family: ui-monospace, Consolas, monospace;
}
.badge { justify-self: start; padding: 0 7px; border-radius: 999px; font-size: 11px; border: 1px solid transparent; }
.b-ok { color: var(--aide-text-secondary); border-color: var(--aide-border); }
.b-edge { color: var(--aide-info); border-color: var(--aide-info); }
.b-orphan { color: var(--aide-warning); border-color: var(--aide-warning); }
.b-dead { color: var(--aide-danger); border-color: var(--aide-danger); }
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
.preview-meta {
  color: var(--aide-text-muted);
  font-size: 11px;
  margin-bottom: 8px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--aide-border-subtle);
  white-space: normal;
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
