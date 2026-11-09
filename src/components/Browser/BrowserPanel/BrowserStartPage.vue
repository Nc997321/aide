<script setup lang="ts">
import { computed, ref } from "vue";
import { useBrowserHistory, type BrowserRecent, type CreationMode } from "../../../composables/browser/useBrowserHistory";
import BrowserRecentList from "./BrowserRecentList.vue";
import Icon from "../../Icon.vue";

const emit = defineEmits<{ create: [mode: CreationMode]; media: []; history: []; open: [entry: BrowserRecent] }>();
const history = useBrowserHistory();
const filter = ref<"all" | BrowserRecent["kind"]>("all");
const filters = [
  { id: "all", label: "全部" }, { id: "web", label: "网页" },
  { id: "creation", label: "创作" }, { id: "media", label: "媒体" },
] as const;
const visible = computed(() => history.records.value
  .filter((entry) => filter.value === "all" || entry.kind === filter.value).slice(0, 12));
</script>

<template>
  <div class="browser-start-page">
    <section class="browser-start-section" aria-labelledby="browser-tools-heading">
      <h2 id="browser-tools-heading">创作与预览</h2>
      <div class="browser-start-tools">
        <button type="button" class="browser-start-tool" @click="emit('create', 'create')"><Icon name="film" :size="21" /><span><strong>制作短视频</strong><small>从想法、分镜到成片</small></span></button>
        <button type="button" class="browser-start-tool" @click="emit('create', 'edit')"><Icon name="cut" :size="21" /><span><strong>剪辑已有视频</strong><small>剪片段、加字幕、调整节奏</small></span></button>
        <button type="button" class="browser-start-tool" @click="emit('media')"><Icon name="play" :size="21" /><span><strong>打开媒体</strong><small>看视频、选片段、提修改</small></span></button>
      </div>
    </section>
    <section class="browser-start-section" aria-labelledby="browser-recents-heading">
      <div class="browser-start-heading"><h2 id="browser-recents-heading">最近使用</h2><button type="button" class="browser-start-history" @click="emit('history')">查看历史记录</button></div>
      <div class="browser-start-filters" aria-label="最近使用类型"><button v-for="item in filters" :key="item.id" type="button" :aria-pressed="filter === item.id" @click="filter = item.id">{{ item.label }}</button></div>
      <BrowserRecentList :records="visible" empty-text="访问过的网页、创作会话和打开的媒体会出现在这里。可以先输入网址，或从上方开始创作。" @open="emit('open', $event)" />
    </section>
    <p v-if="history.error.value" class="browser-start-error" role="status">{{ history.error.value }}</p>
  </div>
</template>

<style scoped>
.browser-start-page { display: flex; flex-direction: column; gap: calc(var(--aide-space-unit) * 8); width: 100%; max-width: 870px; margin-inline: auto; padding: calc(var(--aide-space-unit) * 10) calc(var(--aide-space-unit) * 8); }
.browser-start-section { display: flex; flex-direction: column; gap: calc(var(--aide-space-unit) * 3); min-width: 0; }
.browser-start-section h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--aide-text-primary); }
.browser-start-tools { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: calc(var(--aide-space-unit) * 3); }
.browser-start-tool { display: flex; align-items: flex-start; gap: calc(var(--aide-space-unit) * 3); min-width: 0; padding: calc(var(--aide-space-unit) * 4) calc(var(--aide-space-unit) * 3); background: var(--aide-bg-raised); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-md); color: var(--aide-text-secondary); text-align: left; cursor: pointer; }
.browser-start-tool:hover { background: var(--aide-surface-hover); }
.browser-start-tool > span { display: flex; flex-direction: column; gap: var(--aide-space-unit); min-width: 0; overflow-wrap: anywhere; }
.browser-start-tool strong { color: var(--aide-text-primary); font-size: 13px; font-weight: 600; }
.browser-start-tool small { font-size: 12px; line-height: 1.6; }
.browser-start-heading { display: flex; justify-content: space-between; align-items: center; gap: calc(var(--aide-space-unit) * 3); }
.browser-start-history { padding: var(--aide-space-unit); border: 0; border-radius: var(--aide-radius-sm); background: transparent; color: var(--aide-text-secondary); font-size: 12px; cursor: pointer; }
.browser-start-history:hover { background: var(--aide-surface-hover); }
.browser-start-filters { display: flex; flex-wrap: wrap; gap: var(--aide-space-unit); }
.browser-start-filters button { padding: var(--aide-space-unit) calc(var(--aide-space-unit) * 3); border: 0; border-radius: var(--aide-radius-sm); background: transparent; color: var(--aide-text-secondary); font-size: 12px; cursor: pointer; }
.browser-start-filters button:hover { background: var(--aide-surface-hover); }
.browser-start-filters button[aria-pressed="true"] { background: var(--aide-surface-active); color: var(--aide-text-primary); }
.browser-start-error { margin: 0; color: var(--aide-warning); font-size: 12px; overflow-wrap: anywhere; }
.browser-start-page button:focus-visible { outline: 2px solid var(--aide-text-secondary); outline-offset: 2px; }
@container browser-surface (max-width: 640px) {
  .browser-start-page { padding: calc(var(--aide-space-unit) * 6) calc(var(--aide-space-unit) * 4); gap: calc(var(--aide-space-unit) * 6); }
  .browser-start-tools { grid-template-columns: minmax(0, 1fr); }
  .browser-start-tool { padding: calc(var(--aide-space-unit) * 3); }
  .browser-start-tool > span { gap: 0; }
}
</style>
