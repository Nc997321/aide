<script setup lang="ts">
import { onMounted } from "vue";
import { useMarketplace } from "../../composables/useMarketplace";
import MarketplacePluginCard from "./MarketplacePluginCard.vue";
import type { PluginEntry } from "../../types/marketplace";

const emit = defineEmits<{
  "go-settings": [];
}>();

const {
  loading,
  error,
  errorActions,
  searchQuery,
  filteredPlugins,
  isInstalled,
  isInstalling,
  fetchPlugins,
  refreshInstalled,
  installPlugin,
  uninstallPlugin,
} = useMarketplace();

onMounted(async () => {
  await Promise.all([fetchPlugins(), refreshInstalled()]);
});

function handleRetry() {
  fetchPlugins();
}

function handleAction(kind: string) {
  switch (kind) {
    case "retry":
      fetchPlugins();
      break;
    case "go-proxy-settings":
      emit("go-settings");
      break;
  }
}

function handleInstall(entry: PluginEntry) {
  installPlugin(entry);
}

function handleUninstall(name: string) {
  uninstallPlugin(name);
}
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

    <!-- Search bar -->
    <div class="search-bar">
      <input
        v-model="searchQuery"
        class="search-input"
        placeholder="搜索插件名称、描述或标签..."
      />
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

    <!-- Empty: no plugins loaded -->
    <div v-else-if="filteredPlugins.length === 0 && searchQuery.trim() === ''" class="empty">
      <div class="empty-icon">📦</div>
      <div class="empty-text">暂无可用的插件</div>
      <div class="empty-hint">检查市场源或稍后重试</div>
      <button class="empty-retry" @click="handleRetry">重新加载</button>
    </div>

    <!-- Empty: search no results -->
    <div v-else-if="filteredPlugins.length === 0" class="empty">
      <div class="empty-icon">🔍</div>
      <div class="empty-text">没有匹配的插件</div>
      <div class="empty-hint">尝试调整搜索关键词</div>
    </div>

    <!-- Plugin list -->
    <div v-else class="plugin-list">
      <MarketplacePluginCard
        v-for="entry in filteredPlugins"
        :key="entry.name"
        :plugin="entry"
        :is-installed="isInstalled(entry.name)"
        :is-installing="isInstalling(entry.name)"
        @install="handleInstall"
        @uninstall="handleUninstall"
      />
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
  border-radius: 6px;
  background: rgba(243, 139, 168, 0.12);
  border: 1px solid rgba(243, 139, 168, 0.3);
}

.error-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.error-text {
  font-size: 11.5px;
  color: #f38ba8;
  white-space: pre-line;
  line-height: 1.5;
}

.error-actions {
  display: flex;
  gap: 8px;
}

.error-btn {
  background: none;
  border: 1px solid rgba(243, 139, 168, 0.4);
  color: #f38ba8;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  white-space: nowrap;
  transition: all 0.12s;
}

.error-btn:hover {
  background: rgba(243, 139, 168, 0.2);
}

.error-btn-primary {
  border-color: var(--accent);
  color: var(--accent);
}

.error-btn-primary:hover {
  background: rgba(137, 180, 250, 0.12);
}

/* ── Search ── */

.search-bar {
  margin-bottom: 8px;
  flex-shrink: 0;
}

.search-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-primary);
  border: 1px solid var(--surface-hover);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-input:focus {
  border-color: var(--accent);
}

/* ── Plugin list ── */

.plugin-list {
  flex: 1;
  overflow-y: auto;
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
  background: var(--surface-hover);
  animation: pulse 1.5s ease-in-out infinite;
}

.skel-title { width: 60%; margin-bottom: 8px; }
.skel-desc { width: 80%; margin-bottom: 8px; height: 10px; }
.skel-tags { width: 40%; height: 10px; }

.skel-btn {
  width: 60px;
  height: 26px;
  border-radius: 5px;
  background: var(--surface-hover);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.7; }
}

/* ── Empty ── */

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 28px;
  margin-bottom: 10px;
}

.empty-text {
  font-size: 13px;
  margin-bottom: 4px;
}

.empty-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.empty-retry {
  background: var(--accent);
  border: none;
  color: #1e1e2e;
  padding: 6px 16px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
}

.empty-retry:hover {
  filter: brightness(1.1);
}

/* ── Scrollbar ── */

.plugin-list::-webkit-scrollbar {
  width: 4px;
}

.plugin-list::-webkit-scrollbar-track {
  background: transparent;
}

.plugin-list::-webkit-scrollbar-thumb {
  background: var(--surface-hover);
  border-radius: 2px;
}
</style>
