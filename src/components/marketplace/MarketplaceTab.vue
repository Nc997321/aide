<script setup lang="ts">
import { onMounted } from "vue";
import { useMarketplace } from "../../composables/useMarketplace";
import MarketplacePluginCard from "./MarketplacePluginCard.vue";
import Icon from "../Icon.vue";
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
      <div class="empty-icon"><Icon name="package" :size="32" /></div>
      <div class="empty-text">暂无可用的插件</div>
      <div class="empty-hint">检查市场源或稍后重试</div>
      <button class="empty-retry" @click="handleRetry">重新加载</button>
    </div>

    <!-- Empty: search no results -->
    <div v-else-if="filteredPlugins.length === 0" class="empty">
      <div class="empty-icon"><Icon name="search" :size="32" /></div>
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

/* ── Search ── */

.search-bar {
  margin-bottom: 8px;
  flex-shrink: 0;
}

.search-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  padding: 8px 12px;
  font-size: 12px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.search-input::placeholder {
  color: var(--aide-text-muted);
}

.search-input:focus {
  border-color: var(--aide-accent);
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
  background: var(--aide-surface-hover);
  animation: pulse 1.5s ease-in-out infinite;
}

.skel-title { width: 60%; margin-bottom: 8px; }
.skel-desc { width: 80%; margin-bottom: 8px; height: 10px; }
.skel-tags { width: 40%; height: 10px; }

.skel-btn {
  width: 60px;
  height: 26px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-hover);
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

/* ── Scrollbar ── */

.plugin-list::-webkit-scrollbar {
  width: 4px;
}

.plugin-list::-webkit-scrollbar-track {
  background: transparent;
}

.plugin-list::-webkit-scrollbar-thumb {
  background: var(--aide-surface-hover);
  border-radius: 2px;
}
</style>
