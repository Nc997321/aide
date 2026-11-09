<script setup lang="ts">
import { ref, watch } from "vue";
import { useBrowserHistory, type BrowserRecent } from "../../../composables/browser/useBrowserHistory";
import { recentKey } from "../../../composables/browser/useBrowserHistory/model";
import Icon from "../../Icon.vue";
import BrowserSiteIcon from "./BrowserSiteIcon.vue";
import { useBrowserBookmarks } from "../../../composables/browser/useBrowserBookmarks";

const props = defineProps<{ records: readonly BrowserRecent[]; emptyText: string }>();
const emit = defineEmits<{ open: [entry: BrowserRecent] }>();
const history = useBrowserHistory();
const removed = ref<BrowserRecent | null>(null);
const icons = { web: "globe", creation: "film", media: "play" };
const { favicons, loadFavicons } = useBrowserBookmarks();
const iconCacheState = ref<"pending" | "ready">("pending");

watch(() => props.records.flatMap((entry) => entry.kind === "web" ? [entry.url] : []), (urls, _previous, onCleanup) => {
  let stale = false;
  onCleanup(() => { stale = true; });
  iconCacheState.value = "pending";
  void loadFavicons(urls)
    .catch((cause) => console.warn("最近网页图标缓存读取失败，尝试站点图标", cause))
    .finally(() => { if (!stale) iconCacheState.value = "ready"; });
}, { immediate: true });

function description(entry: BrowserRecent): string {
  if (entry.kind === "web") return entry.url;
  if (entry.kind === "media") return `媒体预览 · ${entry.path}`;
  return entry.mode === "edit" ? "剪辑会话 · 继续讨论与修改" : "制作会话 · 分镜、预览与修改意见";
}
function timeOf(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  today.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString() ? "昨天" : date.toLocaleDateString();
}
function remove(entry: BrowserRecent): void {
  removed.value = history.remove(recentKey(entry)) ?? null;
}
function undo(): void {
  if (removed.value) history.restore(removed.value);
  removed.value = null;
}
</script>

<template>
  <div class="browser-recents">
    <div v-for="entry in props.records" :key="recentKey(entry)" class="browser-recent-row">
      <button class="browser-recent-open" type="button" @click="emit('open', entry)">
        <span class="browser-recent-icon" :class="{ creation: entry.kind === 'creation' }">
          <BrowserSiteIcon v-if="entry.kind === 'web'" :url="entry.url" :cached="favicons[entry.url]" :cache-state="iconCacheState" />
          <Icon v-else :name="entry.kind === 'creation' && entry.mode === 'edit' ? 'cut' : icons[entry.kind]" :size="19" />
        </span>
        <span class="browser-recent-copy"><span class="browser-recent-title">{{ entry.title }}</span><span class="browser-recent-subtitle">{{ description(entry) }}</span></span>
        <time :datetime="new Date(entry.visitedAt).toISOString()" :title="new Date(entry.visitedAt).toLocaleString()">{{ timeOf(entry.visitedAt) }}</time>
      </button>
      <button class="browser-recent-remove" type="button" :aria-label="`从最近使用移除：${entry.title}`" title="从最近使用移除" @click="remove(entry)"><Icon name="close" :size="13" /></button>
    </div>
    <div v-if="!props.records.length" class="browser-recents-empty"><Icon name="history" :size="24" /><strong>暂无记录</strong><p>{{ props.emptyText }}</p></div>
    <div v-if="removed" class="browser-recents-undo" role="status"><span>已移除记录，不会删除文件或会话。</span><button type="button" @click="undo">撤销移除</button><button type="button" aria-label="关闭提示" @click="removed = null"><Icon name="close" :size="12" /></button></div>
  </div>
</template>

<style scoped>
.browser-recents { display: flex; flex-direction: column; min-width: 0; }
.browser-recent-row { display: flex; align-items: center; gap: var(--aide-space-unit); border-bottom: 1px solid var(--aide-border); }
.browser-recent-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: calc(var(--aide-space-unit) * 3); padding: calc(var(--aide-space-unit) * 3) var(--aide-space-unit); border: 0; border-radius: var(--aide-radius-sm); background: transparent; color: var(--aide-text-primary); text-align: left; cursor: pointer; font-size: 13px; }
.browser-recent-open:hover { background: var(--aide-surface-hover); }
.browser-recent-icon { display: grid; place-items: center; flex: 0 0 auto; width: 36px; height: 40px; border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); background: var(--aide-surface-default); color: var(--aide-text-secondary); }
.browser-recent-icon.creation { background: var(--aide-accent-subtle); color: var(--aide-text-primary); }
.browser-recent-copy { display: flex; flex-direction: column; gap: calc(var(--aide-space-unit) / 2); min-width: 0; flex: 1; overflow-wrap: anywhere; }
.browser-recent-title { font-weight: 500; }
.browser-recent-subtitle { color: var(--aide-text-secondary); font-size: 12px; }
.browser-recent-open time { flex-shrink: 0; color: var(--aide-text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.browser-recent-remove { display: grid; place-items: center; flex-shrink: 0; padding: var(--aide-space-unit); border: 0; border-radius: var(--aide-radius-sm); background: transparent; color: var(--aide-text-muted); cursor: pointer; }
.browser-recent-remove:hover { color: var(--aide-text-primary); background: var(--aide-surface-hover); }
.browser-recents-empty { display: flex; flex-direction: column; align-items: flex-start; gap: calc(var(--aide-space-unit) * 2); padding: calc(var(--aide-space-unit) * 6) var(--aide-space-unit); color: var(--aide-text-secondary); font-size: 13px; }
.browser-recents-empty p { margin: 0; line-height: 1.7; }
.browser-recents-undo { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--aide-space-unit) * 2); padding-top: calc(var(--aide-space-unit) * 3); color: var(--aide-text-secondary); font-size: 12px; }
.browser-recents-undo button { border: 0; background: var(--aide-surface-default); border-radius: var(--aide-radius-sm); padding: var(--aide-space-unit); color: var(--aide-text-primary); cursor: pointer; }
.browser-recents button:focus-visible { outline: 2px solid var(--aide-text-secondary); outline-offset: 2px; }
</style>
