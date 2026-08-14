<script setup lang="ts">
/**
 * GitTags —— 版本分组标签视图
 *
 * 按主版本号分组（v1 / v2 / v3 …），非版本标签归「其他」。
 * 签名件：大号 mono 版本号组头 + 发丝线 + 计数。
 * annotated 标签实心点 ●（accent），lightweight 空心点 ○（muted）。
 * 数据来自 useGit.tags（git_tags），由 GitPanel 切到标签 tab 时触发 loadTags；
 * 此组件不自动加载（v-show 常驻挂载，避免启动即拉），刷新按钮显式 loadTags。
 * 全 var(--aide-*)。
 */
import { computed } from "vue";
import { useGit } from "../../composables/useGit";
import type { TagEntry } from "../../types";

interface TagGroup {
  key: string;
  label: string;
  major: number; // 版本组用，其他组为 -1
  tags: TagEntry[];
}

const { tags, tagsLoading, loadTags } = useGit();

const VERSION_RE = /^v?(\d+)(\.|$)/;

function majorOf(name: string): number | null {
  const m = name.match(VERSION_RE);
  return m ? parseInt(m[1], 10) : null;
}

const groups = computed<TagGroup[]>(() => {
  const map = new Map<string, TagGroup>();
  for (const t of tags.value) {
    const major = majorOf(t.name);
    const key = major === null ? "__other__" : `v${major}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: major === null ? "其他" : t.name.startsWith("v") ? `v${major}` : `${major}`,
        major: major ?? -1,
        tags: [],
      });
    }
    map.get(key)!.tags.push(t);
  }
  return [...map.values()].sort((a, b) => {
    if (a.major === -1) return 1; // 其他永远最后
    if (b.major === -1) return -1;
    return b.major - a.major; // 主版本降序
  });
});

const totalCount = computed(() => tags.value.length);
const isEmpty = computed(() => tags.value.length === 0);

function refresh() {
  void loadTags();
}
</script>

<template>
  <div class="git-tags">
    <div class="tags-toolbar">
      <span class="tags-title">标签 <span class="tags-count">{{ totalCount }}</span></span>
      <button class="tags-refresh" v-tooltip="'刷新标签'" @click="refresh">↻</button>
    </div>

    <div v-if="tagsLoading && isEmpty" class="section-empty">加载中…</div>
    <div v-else-if="isEmpty" class="section-empty">暂无标签</div>

    <div v-for="g in groups" :key="g.key" class="tag-group">
      <div class="tag-group-header">
        <span class="tag-group-version" :class="{ other: g.major === -1 }">{{ g.label }}</span>
        <span class="tag-group-line"></span>
        <span class="tag-group-count">{{ g.tags.length }}</span>
      </div>
      <div v-for="t in g.tags" :key="t.name" class="tag-row">
        <span class="tag-dot" :class="{ annotated: t.isAnnotated, lightweight: !t.isAnnotated }">{{
          t.isAnnotated ? "●" : "○"
        }}</span>
        <div class="tag-info">
          <span class="tag-name-row">
            <span class="tag-name">{{ t.name }}</span>
            <span class="tag-target" v-tooltip="'指向提交'">{{ t.target }}</span>
          </span>
          <span v-if="t.message" class="tag-message">{{ t.message }}</span>
        </div>
        <span class="tag-date">{{ t.date }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-tags {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column;
}

.tags-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px;
  border-bottom: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}
.tags-title {
  font-size: 11px; color: var(--aide-text-secondary);
  text-transform: uppercase; letter-spacing: 0.4px;
  display: inline-flex; align-items: center; gap: 6px;
}
.tags-count {
  font-family: var(--aide-font-mono); font-size: 10px;
  background: var(--aide-surface-default); color: var(--aide-text-muted);
  padding: 1px 6px; border-radius: 8px;
  text-transform: none; letter-spacing: 0;
}
.tags-refresh {
  background: none; border: none; color: var(--aide-text-muted);
  cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px;
  font-family: inherit; transition: all 0.12s;
}
.tags-refresh:hover {
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 12%, transparent);
}

/* ── 签名件：版本号组头 ── */
.tag-group { flex-shrink: 0; }
.tag-group-header {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px 6px;
}
.tag-group-version {
  font-family: var(--aide-font-mono);
  font-size: 14px; font-weight: 600;
  color: var(--aide-accent);
  letter-spacing: 0.5px;
  flex-shrink: 0;
}
.tag-group-version.other {
  font-family: inherit;
  font-size: 11px; font-weight: 500;
  color: var(--aide-text-muted);
  text-transform: uppercase; letter-spacing: 0.4px;
}
.tag-group-line {
  flex: 1; height: 1px; background: var(--aide-surface-hover);
}
.tag-group-count {
  font-family: var(--aide-font-mono); font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  padding: 1px 6px; border-radius: 8px;
  flex-shrink: 0;
}

/* ── 标签行 ── */
.tag-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 5px 12px;
  transition: background 0.15s ease;
}
.tag-row:hover { background: var(--aide-surface-default); }
.tag-dot {
  font-size: 10px; margin-top: 3px; flex-shrink: 0;
  line-height: 1;
}
.tag-dot.annotated { color: var(--aide-accent); }
.tag-dot.lightweight { color: var(--aide-text-muted); }

.tag-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.tag-name-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tag-name {
  font-family: var(--aide-font-mono); font-size: 12px;
  color: var(--aide-text-primary); font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tag-target {
  font-family: var(--aide-font-mono); font-size: 9px;
  color: var(--aide-text-muted); opacity: 0.7;
  flex-shrink: 0;
}
.tag-message {
  font-size: 10px; color: var(--aide-text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tag-date {
  font-size: 10px; color: var(--aide-text-muted);
  flex-shrink: 0; white-space: nowrap;
}

.section-empty { padding: 24px 16px; font-size: 11px; color: var(--aide-text-muted); text-align: center; }

.git-tags::-webkit-scrollbar { width: 4px; }
.git-tags::-webkit-scrollbar-track { background: transparent; }
.git-tags::-webkit-scrollbar-thumb { background: var(--aide-surface-hover); border-radius: 2px; }
</style>