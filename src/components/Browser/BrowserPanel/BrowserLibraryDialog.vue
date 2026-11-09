<script setup lang="ts">
import { computed, ref } from "vue";
import AInput from "../../../ui/AInput.vue";
import { useBrowserBookmarks } from "../../../composables/browser/useBrowserBookmarks";
import { useBrowserHistory, type BrowserRecent } from "../../../composables/browser/useBrowserHistory";
import BrowserDialog from "./BrowserDialog.vue";
import BrowserRecentList from "./BrowserRecentList.vue";
import Icon from "../../Icon.vue";

const props = defineProps<{ kind: "bookmarks" | "history" }>();
const emit = defineEmits<{ close: []; open: [url: string]; recent: [entry: BrowserRecent] }>();
const query = ref("");
const error = ref("");
const { bookmarks, favicons, remove } = useBrowserBookmarks();
const history = useBrowserHistory();
const needle = computed(() => query.value.trim().toLocaleLowerCase());
const favorites = computed(() => bookmarks.value.filter((entry) =>
  `${entry.title} ${entry.url} ${entry.folders.join("/")}`.toLocaleLowerCase().includes(needle.value)));
const visits = computed(() => history.records.value.filter((entry) => entry.kind === "web"
  && `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(needle.value)));

function setBookmarkBar(event: Event): void {
  if (event.target instanceof HTMLInputElement) history.setBookmarkBar(event.target.checked);
}
async function removeFavorite(id: string): Promise<void> {
  try { await remove(id); }
  catch (cause) { error.value = String(cause); }
}
</script>

<template>
  <BrowserDialog :title="props.kind === 'bookmarks' ? '收藏夹' : '网页历史记录'" @close="emit('close')">
    <label v-if="props.kind === 'bookmarks'" class="browser-bookmark-setting"><input type="checkbox" :checked="history.showBookmarkBar.value" @change="setBookmarkBar">显示收藏栏</label>
    <AInput v-model="query" type="search" :aria-label="props.kind === 'bookmarks' ? '搜索收藏夹' : '搜索网页历史'" :placeholder="props.kind === 'bookmarks' ? '搜索收藏夹' : '搜索网页历史'" />
    <template v-if="props.kind === 'bookmarks'">
      <div class="browser-favorites">
        <div v-for="entry in favorites" :key="entry.id" class="browser-favorite-row">
          <button type="button" class="browser-favorite-open" :title="entry.url" @click="emit('open', entry.url)">
            <img v-if="favicons[entry.url]" :src="favicons[entry.url]" alt=""><Icon v-else name="globe" :size="16" />
            <span><strong>{{ entry.title }}</strong><small>{{ entry.folders.length ? `${entry.folders.join(' / ')} · ` : '' }}{{ entry.url }}</small></span>
          </button>
          <button type="button" class="browser-favorite-remove" :aria-label="`删除收藏：${entry.title}`" @click="removeFavorite(entry.id)"><Icon name="close" :size="13" /></button>
        </div>
        <p v-if="!favorites.length">{{ query.trim() ? '没有匹配的收藏。' : '还没有收藏。打开网页后点击地址栏旁的星标，或从三点菜单导入收藏。' }}</p>
      </div>
    </template>
    <BrowserRecentList v-else :records="visits" :empty-text="query.trim() ? '没有匹配的网页历史记录。' : '成功访问的网页会出现在这里。媒体通过源文件恢复，不记临时播放地址。'" @open="emit('recent', $event)" />
    <div v-if="error || history.error.value" class="browser-dialog__error" role="status">{{ error || history.error.value }}</div>
  </BrowserDialog>
</template>

<style scoped>
.browser-bookmark-setting { display: flex; align-items: center; gap: calc(var(--aide-space-unit) * 2); color: var(--aide-text-secondary); cursor: pointer; }
.browser-bookmark-setting input { margin: 0; accent-color: var(--aide-accent); }
.browser-favorites { display: flex; flex-direction: column; }
.browser-favorite-row { display: flex; align-items: center; gap: var(--aide-space-unit); border-bottom: 1px solid var(--aide-border); }
.browser-favorite-open { display: flex; align-items: center; gap: calc(var(--aide-space-unit) * 3); min-width: 0; flex: 1; padding: calc(var(--aide-space-unit) * 3) var(--aide-space-unit); border: 0; border-radius: var(--aide-radius-sm); background: transparent; color: var(--aide-text-secondary); text-align: left; cursor: pointer; }
.browser-favorite-open:hover { background: var(--aide-surface-hover); }
.browser-favorite-open img { width: 16px; height: 16px; object-fit: contain; flex-shrink: 0; }
.browser-favorite-open > span { display: flex; flex-direction: column; gap: var(--aide-space-unit); min-width: 0; overflow-wrap: anywhere; }
.browser-favorite-open strong { color: var(--aide-text-primary); font-size: 13px; font-weight: 500; }
.browser-favorite-open small { font-size: 12px; }
.browser-favorite-remove { padding: var(--aide-space-unit); border: 0; border-radius: var(--aide-radius-sm); background: transparent; color: var(--aide-text-muted); cursor: pointer; }
.browser-favorite-remove:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
</style>
