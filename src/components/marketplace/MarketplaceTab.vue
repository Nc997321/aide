<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useMarketplace } from "../../composables/useMarketplace";
import MarketplacePluginCard from "./MarketplacePluginCard.vue";
import Icon from "../Icon.vue";

const emit = defineEmits<{
  "go-settings": [];
}>();

const {
  sources,
  plugins,
  filteredPlugins,
  allEntries,
  hiddenCount,
  installedPlugins,
  loading,
  error,
  errorActions,
  searchQuery,
  fetchSources,
  fetchPlugins,
  refreshInstalled,
  setSourceEnabled,
  refreshSource,
  getInstalled,
} = useMarketplace();

const activeCategory = ref("all");
const showHidden = ref(false);
const sourcesRef = ref<HTMLElement | null>(null);
const highlightSources = ref(false);

onMounted(async () => {
  await fetchSources();
  await Promise.all([fetchPlugins(), refreshInstalled()]);
});

function handleAction(kind: string) {
  switch (kind) {
    case "retry":
      fetchPlugins();
      break;
    case "go-proxy-settings":
      emit("go-settings");
      break;
    case "go-marketplace-settings":
      sourcesRef.value?.scrollIntoView({ behavior: "smooth", block: "start" });
      highlightSources.value = true;
      setTimeout(() => { highlightSources.value = false; }, 1000);
      break;
  }
}

function sourceLabel(id: string): string {
  switch (id) {
    case "claude-plugins-official":
      return "Anthropic 官方";
    case "claude-community":
      return "社区";
    default:
      return id;
  }
}

function countOf(sourceId: string): number {
  return plugins.value.filter((p) => p.sourceId === sourceId).length;
}

const categoryLabelMap: Record<string, string> = {
  "cat-external": "外部集成",
  "cat-code": "代码智能",
  "cat-dev": "开发工作流",
  "cat-security": "安全",
  "cat-style": "输出样式",
  "cat-agent": "Agent",
  "cat-mcp": "MCP",
  "cat-hook": "Hook",
  "cat-skill": "Skill",
  "cat-tool": "工具",
  "cat-utility": "实用工具",
  "cat-integration": "集成",
  "cat-workflow": "工作流",
};

function categoryLabel(key: string): string {
  return categoryLabelMap[key] || key;
}

// 展示集中已安装的数量：与「已安装」视图实际显示条数一致。
// 基于 allEntries（目录条目 + 合成本地条目），local 市场/禁用源的已装项也算。
const installedVisibleCount = computed(() =>
  allEntries.value.filter((p) => getInstalled(p.marketName, p.name)).length,
);

const categories = computed(() => {
  const map = new Map<string, number>();
  for (const p of allEntries.value) {
    if (p.category) {
      map.set(p.category, (map.get(p.category) || 0) + 1);
    }
  }
  const entries = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: categoryLabel(key), count }));
  const all = [
    { key: "all", label: "全部", count: allEntries.value.length },
    ...entries,
  ];
  // 0 安装时不占位（面板空间有限）；「已安装」作为伪分类置于最前，单选互斥。
  if (installedVisibleCount.value > 0) {
    all.unshift({ key: "installed", label: "已安装", count: installedVisibleCount.value });
  }
  return all;
});

const visiblePlugins = computed(() => {
  const cat = activeCategory.value;
  if (cat === "installed") {
    return filteredPlugins.value.filter((p) => getInstalled(p.marketName, p.name));
  }
  let result = filteredPlugins.value;
  if (cat !== "all") {
    result = result.filter((p) => p.category === cat);
  }
  return result;
});

const enabledCount = computed(() => {
  let count = 0;
  for (const [, plugin] of installedPlugins.value) {
    if (plugin.enabled) count++;
  }
  return count;
});
</script>

<template>
  <div class="marketplace-tab">
    <!-- Error banner -->
    <div v-if="error" class="error-banner">
      <div class="error-body">
        <span class="error-text">{{ error }}</span>
        <div class="error-actions">
          <button
            v-for="action in errorActions"
            :key="action.kind"
            class="error-btn"
            :class="{ 'error-btn-primary': action.kind !== 'retry' }"
            @click="handleAction(action.kind)"
          >{{ action.label }}</button>
        </div>
      </div>
    </div>

    <div class="main-head">
      <div class="row">
        <div>
          <h1>插件市场</h1>
        </div>
        <div class="search">
          <span class="ic">⌕</span>
          <input v-model="searchQuery" placeholder="搜索插件名或描述…" />
        </div>
      </div>
    </div>

    <div ref="sourcesRef" class="sources" :class="{ highlight: highlightSources }">
      <span class="lbl">源</span>
      <div
        v-for="s in sources"
        :key="s.id"
        class="chip"
        :class="{ on: s.enabled }"
        @click="setSourceEnabled(s.id, !s.enabled)"
      >
        <span class="dot"></span>
        <span class="nm">{{ sourceLabel(s.id) }}</span>
        <span class="cnt">{{ countOf(s.id) }}</span>
        <span class="refr" v-tooltip="'刷新此源'" @click.stop="refreshSource(s.id)">⟳</span>
        <span class="switch" v-tooltip="'开/关'" @click.stop="setSourceEnabled(s.id, !s.enabled)"></span>
      </div>
    </div>

    <div class="list">
      <div class="filter-row">
        <span
          v-for="c in categories"
          :key="c.key"
          class="ftag"
          :class="{ active: activeCategory === c.key }"
          @click="activeCategory = c.key"
        >
          {{ c.label }}<span class="n">{{ c.count }}</span>
        </span>
      </div>

      <div v-if="hiddenCount > 0" class="hidden-row" @click="showHidden = !showHidden">
        已隐藏 {{ hiddenCount }} 个 Aide 不可用的插件
        <span class="caret">{{ showHidden ? "▾" : "▸" }}</span>
      </div>

      <div v-if="showHidden && hiddenCount > 0" class="hidden-detail">
        组件清单在安装后由 SDK 自动发现
      </div>

      <!-- Loading: skeleton cards -->
      <div v-if="loading" class="plugin-list">
        <div v-for="i in 4" :key="i" class="skeleton-card">
          <div class="skel-body">
            <div class="skel-line skel-title"></div>
            <div class="skel-line skel-desc"></div>
            <div class="skel-line skel-tags"></div>
          </div>
          <div class="skel-btn"></div>
        </div>
      </div>

      <!-- Empty: installed view, none installed -->
      <div v-else-if="activeCategory === 'installed' && visiblePlugins.length === 0 && searchQuery.trim() === ''" class="empty">
        <div class="empty-icon"><Icon name="package" :size="32" /></div>
        <div class="empty-text">还没有安装任何插件</div>
        <div class="empty-hint">在上方选「全部」浏览市场，点「安装」即可</div>
      </div>

      <!-- Empty: no plugins loaded -->
      <div v-else-if="visiblePlugins.length === 0 && searchQuery.trim() === ''" class="empty">
        <div class="empty-icon"><Icon name="package" :size="32" /></div>
        <div class="empty-text">暂无可用的插件</div>
        <div class="empty-hint">检查市场源或稍后重试</div>
        <button class="empty-retry" @click="fetchPlugins">重新加载</button>
      </div>

      <!-- Empty: search no results -->
      <div v-else-if="visiblePlugins.length === 0" class="empty">
        <div class="empty-icon"><Icon name="search" :size="32" /></div>
        <div class="empty-text">没有匹配的插件</div>
        <div class="empty-hint">尝试调整搜索关键词</div>
      </div>

      <!-- Plugin list -->
      <div v-else class="plugin-list">
        <MarketplacePluginCard
          v-for="p in visiblePlugins"
          :key="p.name"
          :entry="p"
        />
      </div>
    </div>

    <div class="foot">
      <span class="pill">{{ installedPlugins.size }} 已安装</span><span class="sep">·</span>
      <span class="pill">{{ enabledCount }} 已启用</span><span class="sep">·</span>
      <span>启用变更在下一次消息往返生效</span>
    </div>
  </div>
</template>

<style scoped>
.marketplace-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ── Error ── */

.error-banner {
  padding: 10px 12px;
  margin-bottom: 8px;
  border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-danger) 30%, transparent);
}

.error-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.error-text {
  font-size: 12px;
  color: var(--aide-danger);
  white-space: pre-line;
  line-height: 1.5;
}

.error-actions {
  display: flex;
  gap: 8px;
}

.error-btn {
  background: none;
  border: 1px solid color-mix(in srgb, var(--aide-danger) 40%, transparent);
  color: var(--aide-danger);
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  white-space: nowrap;
  transition: all 0.12s;
}

.error-btn:hover {
  background: color-mix(in srgb, var(--aide-danger) 20%, transparent);
}

.error-btn-primary {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
}

.error-btn-primary:hover {
  background: color-mix(in srgb, var(--aide-info) 12%, transparent);
}

/* ── Main head ── */

.main-head {
  flex: 0 0 auto;
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--aide-border);
}

.main-head .row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.main-head h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

/* ── Search ── */

.search {
  position: relative;
  flex: 0 0 280px;
}

.search input {
  width: 100%;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  padding: 7px 10px 7px 30px;
  outline: none;
  box-sizing: border-box;
}

.search input:focus {
  border-color: color-mix(in srgb, var(--aide-accent) 45%, transparent);
  box-shadow: 0 0 0 3px var(--aide-accent-subtle);
}

.search input::placeholder {
  color: var(--aide-text-muted);
}

.search .ic {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--aide-text-muted);
  font-size: 13px;
  pointer-events: none;
}

/* ── Sources bar ── */

.sources {
  padding: 14px 22px;
  border-bottom: 1px solid var(--aide-border);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sources.highlight {
  border-color: color-mix(in srgb, var(--aide-accent) 45%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--aide-accent) 25%, transparent);
  transition: border-color .2s, box-shadow .2s;
}

.sources .lbl {
  color: var(--aide-text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-right: 2px;
}

.chip {
  display: flex;
  align-items: center;
  gap: 9px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: 20px;
  padding: 6px 8px 6px 12px;
  transition: border-color 0.15s, background 0.15s;
  cursor: pointer;
}

.chip.on {
  border-color: color-mix(in srgb, var(--aide-accent) 45%, transparent);
  background: var(--aide-accent-subtle);
}

.chip .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--aide-text-muted);
  flex: 0 0 auto;
}

.chip.on .dot {
  background: var(--aide-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aide-success) 18%, transparent);
}

.chip .nm {
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  font-weight: 500;
}

.chip.on .nm {
  color: var(--aide-text-primary);
}

.chip .cnt {
  font-family: inherit;
  font-size: 11px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 1px 7px;
  border-radius: 10px;
}

.chip.on .cnt {
  color: var(--aide-accent);
}

.chip .refr {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--aide-text-muted);
  cursor: pointer;
  border: 1px solid transparent;
  font-size: 14px;
}

.chip .refr:hover {
  color: var(--aide-accent);
  border-color: var(--aide-border);
}

.switch {
  width: 30px;
  height: 17px;
  border-radius: 10px;
  background: var(--aide-border);
  position: relative;
  cursor: pointer;
  flex: 0 0 auto;
  transition: background 0.15s;
}

.switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--aide-text-primary);
  transition: left 0.15s, background 0.15s;
}

.chip.on .switch {
  background: var(--aide-accent);
}

.chip.on .switch::after {
  left: 15px;
  background: var(--aide-text-on-accent);
}

/* ── Plugin list ── */

.list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 22px 22px;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0 6px;
  flex-wrap: wrap;
}

.ftag {
  font-size: 11.5px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: 14px;
  padding: 3px 11px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.ftag.active {
  color: var(--aide-accent);
  border-color: color-mix(in srgb, var(--aide-accent) 45%, transparent);
  background: var(--aide-accent-subtle);
}

.ftag .n {
  font-family: inherit;
  color: var(--aide-text-muted);
  margin-left: 5px;
}

.hidden-row {
  font-size: 11.5px;
  color: var(--aide-text-muted);
  cursor: pointer;
  padding: 6px 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.hidden-row .caret {
  font-size: 14px;
}

.hidden-detail {
  font-size: 11px;
  color: var(--aide-text-muted);
  padding: 4px 0 8px;
}

/* ── Skeleton ── */

.skeleton-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
}

.skel-body {
  flex: 1;
}

.skel-line {
  height: 12px;
  border-radius: 4px;
  background: var(--aide-surface-hover);
  animation: pulse 1.5s ease-in-out infinite;
}

.skel-title {
  width: 60%;
  margin-bottom: 8px;
}

.skel-desc {
  width: 80%;
  margin-bottom: 8px;
  height: 10px;
}

.skel-tags {
  width: 40%;
  height: 10px;
}

.skel-btn {
  width: 60px;
  height: 26px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-hover);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 0.7;
  }
}

/* ── Empty ── */

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--aide-text-muted);
}

.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--aide-accent);
  margin-bottom: 10px;
}

.empty-text {
  font-size: 13px;
  margin-bottom: 4px;
}

.empty-hint {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-bottom: 12px;
}

.empty-retry {
  background: var(--aide-accent);
  border: none;
  color: var(--aide-text-on-accent);
  padding: 6px 16px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
}

.empty-retry:hover {
  filter: brightness(1.1);
}

/* ── Footer ── */

.foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--aide-border);
  padding: 8px 22px;
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--aide-bg-deep);
  font-size: 11px;
  color: var(--aide-text-muted);
}

.foot .pill {
  font-family: inherit;
  color: var(--aide-text-secondary);
}

.foot .sep {
  color: var(--aide-border);
}

/* ── Scrollbar ── */

.list::-webkit-scrollbar {
  width: 4px;
}

.list::-webkit-scrollbar-track {
  background: transparent;
}

.list::-webkit-scrollbar-thumb {
  background: var(--aide-surface-hover);
  border-radius: 2px;
}
</style>
