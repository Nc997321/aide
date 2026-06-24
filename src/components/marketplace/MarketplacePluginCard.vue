<script setup lang="ts">
import type { PluginEntry } from "../../types/marketplace";
import { computed } from "vue";
import { open } from "@tauri-apps/plugin-shell";

const props = defineProps<{
  plugin: PluginEntry;
  isInstalled: boolean;
  isInstalling: boolean;
}>();

const emit = defineEmits<{
  install: [entry: PluginEntry];
  uninstall: [name: string];
}>();

const isInstallable = computed(() =>
  props.plugin.repo.startsWith("http://") || props.plugin.repo.startsWith("https://")
);

const buttonLabel = computed(() => {
  if (!isInstallable.value) return "内置";
  if (props.isInstalling && props.isInstalled) return "卸载中...";
  if (props.isInstalling) return "安装中...";
  if (props.isInstalled) return "已安装";
  return "安装";
});

const buttonClass = computed(() => {
  if (!isInstallable.value) return "btn-builtin";
  if (props.isInstalling) return "btn-disabled";
  if (props.isInstalled) return "btn-installed";
  return "btn-install";
});

function handleClick() {
  if (props.isInstalling || !isInstallable.value) return;
  if (props.isInstalled) {
    emit("uninstall", props.plugin.name);
  } else {
    emit("install", props.plugin);
  }
}
</script>

<template>
  <div class="plugin-card" :class="{ installed: isInstalled }">
    <div class="card-body">
      <div class="card-header">
        <span class="plugin-name">{{ plugin.name }}</span>
      </div>
      <div v-if="plugin.description" class="plugin-desc">{{ plugin.description }}</div>
      <div v-if="plugin.homepage" class="plugin-link">
        <button class="link-btn" @click.stop="open(plugin.homepage)">查看详情 ↗</button>
      </div>
    </div>
    <button
      :class="['install-btn', buttonClass]"
      :disabled="isInstalling"
      @click="handleClick"
    >
      {{ buttonLabel }}
    </button>
  </div>
</template>

<style scoped>
.plugin-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  transition: background 0.1s;
}

.plugin-card:hover {
  background: var(--aide-surface-default);
}

.plugin-card.installed {
  border-left: 2px solid var(--aide-success);
  padding-left: 10px;
}

.card-body {
  flex: 1;
  min-width: 0;
}

.card-header {
  margin-bottom: 4px;
}

.plugin-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-primary);
}

.plugin-desc {
  font-size: 11.5px;
  color: var(--aide-text-secondary);
  line-height: 1.45;
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.plugin-link {
  font-size: 11px;
}

.link-btn {
  background: none;
  border: none;
  color: var(--aide-accent);
  cursor: pointer;
  padding: 0;
  font-size: 11px;
  font-family: inherit;
}

.link-btn:hover {
  text-decoration: underline;
}

/* ── Install button ── */

.install-btn {
  flex-shrink: 0;
  padding: 5px 14px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.12s;
  white-space: nowrap;
}

.btn-install {
  background: var(--aide-accent);
  border: 1px solid var(--aide-accent);
  color: var(--aide-text-on-accent);
}

.btn-install:hover {
  filter: brightness(1.15);
}

.btn-installed {
  background: transparent;
  border: 1px solid var(--aide-success);
  color: var(--aide-success);
}

.btn-installed:hover {
  background: color-mix(in srgb, var(--aide-success) 10%, transparent);
  color: var(--aide-danger);
  border-color: var(--aide-danger);
}

.btn-disabled {
  background: transparent;
  border: 1px solid var(--aide-surface-hover);
  color: var(--aide-text-muted);
  cursor: not-allowed;
}

.btn-builtin {
  background: transparent;
  border: 1px solid var(--aide-surface-default);
  color: var(--aide-text-muted);
  font-size: 11px;
  cursor: default;
}
</style>
