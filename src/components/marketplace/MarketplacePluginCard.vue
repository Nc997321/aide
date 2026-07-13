<script setup lang="ts">
import type { PluginEntry } from "../../types/marketplace";
import { computed } from "vue";
import { marketplaceApi } from "../../api/marketplace";
import { useMarketplace } from "../../composables/useMarketplace";
import { useModal } from "../../composables/useModal";

const props = defineProps<{
  entry: PluginEntry;
}>();

const {
  getInstalled,
  hasUpdate,
  isInstalling,
  installPlugin,
  uninstallPlugin,
  updatePlugin,
  setEnabled,
} = useMarketplace();

const installed = computed(() => getInstalled(props.entry.marketName, props.entry.name));

const statusClass = computed(() => {
  if (installed.value && installed.value.enabled) return "on";
  return "off";
});

const statusText = computed(() => {
  if (installed.value && installed.value.enabled) return "已启用";
  if (installed.value && !installed.value.enabled) return "已禁用";
  return "未安装";
});

const sourceLabel = computed(() => {
  switch (props.entry.sourceId) {
    case "claude-plugins-official":
      return "官方";
    case "claude-community":
      return "社区";
    default:
      return props.entry.sourceId;
  }
});

const badgeClass = computed(() => {
  return props.entry.sourceId === "claude-plugins-official" ? "official" : "community";
});

const caveatText = computed(() => {
  // 仅 UNSUPPORTED 组件（lsp/output_styles/themes/monitors）会出现于 entry.unsupported；
  // mcp_servers 属于 SUPPORTED，永不在其中，故不列入此映射。
  const mapComp: Record<string, string> = {
    lsp_servers: "LSP",
    output_styles: "输出样式",
    themes: "主题",
    monitors: "后台监控",
  };
  return (
    props.entry.unsupported.map((c) => mapComp[c] || c).join("、") +
    " 在 Aide 中不可用"
  );
});

async function onInstall() {
  if (props.entry.sourceId === "claude-community") {
    const ok = await useModal().confirm(
      "安装社区插件",
      "此插件将执行代码，请确认信任来源。",
    );
    if (!ok) return;
  }
  installPlugin(props.entry);
}

const compLabel = (t: string): string => ({
  skills: "Skills", commands: "Commands", agents: "Agents", hooks: "Hooks",
  mcp_servers: "MCP", lsp_servers: "LSP", output_styles: "输出样式",
  themes: "主题", monitors: "后台监控",
} as Record<string,string>)[t] ?? t;

async function openDetail() {
  try {
    const d = await marketplaceApi.getPluginDetails(props.entry.sourceId, props.entry.name);
    if (d.components.length === 0) {
      await useModal().notice(props.entry.name, "组件清单在安装后由 SDK 自动发现。");
      return;
    }
    const lines = d.components.map(c => `${compLabel(c.type)}：${c.available ? "可用" : "在 Aide 中不可用"}`);
    const allUnavailable = d.components.every(c => !c.available);
    const prefix = allUnavailable ? "此插件在 Aide 中不可用\n\n" : "";
    await useModal().notice(props.entry.name, prefix + lines.join("\n"));
  } catch { /* best-effort: detail fetch failure must not block */ }
}
</script>

<template>
  <div class="card">
    <div>
      <div class="top">
        <span class="name" @click="openDetail">{{ entry.displayName || entry.name }}</span>
        <span class="ver">v{{ entry.version || "—" }}</span>
        <span class="badge" :class="badgeClass">{{ sourceLabel }}</span>
        <span v-if="entry.category" class="cat">{{ entry.category }}</span>
      </div>
      <div class="desc">{{ entry.description }}</div>
      <span v-if="entry.availability === 'mixed'" class="caveat">{{ caveatText }}</span>
      <span v-else-if="entry.availability === 'unavailable'" class="caveat unavailable-caveat">在 Aide 中不可用</span>
    </div>
    <div class="actions">
      <div class="status" :class="statusClass"><span class="d"></span>{{ statusText }}</div>
      <div class="btns">
        <button
          v-if="hasUpdate(entry)"
          class="btn"
          @click="updatePlugin(entry)"
        >更新</button>
        <button
          v-if="!installed"
          class="btn primary"
          :disabled="entry.availability === 'unavailable' || isInstalling(entry.name)"
          @click="onInstall"
        >安装</button>
        <button
          v-else-if="installed.enabled"
          class="btn"
          @click="setEnabled({ market: entry.marketName, name: entry.name }, false)"
        >禁用</button>
        <button
          v-else
          class="btn primary"
          @click="setEnabled({ market: entry.marketName, name: entry.name }, true)"
        >启用</button>
        <button
          v-if="installed"
          class="btn danger"
          @click="uninstallPlugin({ market: entry.marketName, name: entry.name })"
        >卸载</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 18px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  padding: 14px 16px;
  margin-top: 10px;
  transition: border-color 0.15s, background 0.15s;
}

.card:hover {
  border-color: var(--aide-border);
  background: var(--aide-surface-hover);
}

.card .top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.card .name {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
  cursor: pointer;
}

.card .ver {
  font-family: inherit;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.badge {
  font-family: inherit;
  font-size: 10.5px;
  letter-spacing: 0.02em;
  padding: 1.5px 7px;
  border-radius: 4px;
  border: 1px solid var(--aide-border);
  color: var(--aide-text-secondary);
}

.badge.official {
  color: var(--aide-accent);
  border-color: color-mix(in srgb, var(--aide-accent) 45%, transparent);
  background: var(--aide-accent-subtle);
}

.badge.community {
  color: var(--aide-info);
  border-color: color-mix(in srgb, var(--aide-info) 35%, transparent);
  background: color-mix(in srgb, var(--aide-info) 10%, transparent);
}

.cat {
  font-size: 10.5px;
  color: var(--aide-text-secondary);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  padding: 1.5px 7px;
  border-radius: 4px;
}

.card .desc {
  color: var(--aide-text-secondary);
  font-size: 12.5px;
  margin-top: 6px;
  max-width: 62ch;
  line-height: 1.5;
}

.caveat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 30%, transparent);
  padding: 2px 8px;
  border-radius: 4px;
}

.caveat::before {
  content: "▸";
  font-size: 14px;
}

.caveat.unavailable-caveat {
  color: var(--aide-text-muted);
  background: color-mix(in srgb, var(--aide-text-muted) 10%, transparent);
  border-color: color-mix(in srgb, var(--aide-text-muted) 30%, transparent);
}

.caveat.unavailable-caveat::before {
  content: "▸";
  font-size: 14px;
}

.card .actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  gap: 8px;
}

.status {
  font-size: 11.5px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.status .d {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.status.on .d {
  background: var(--aide-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aide-success) 16%, transparent);
}

.status.off .d {
  background: var(--aide-text-muted);
}

.status.on {
  color: var(--aide-success);
}

.status.off {
  color: var(--aide-text-muted);
}

.btns {
  display: flex;
  gap: 8px;
}

.btn {
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-raised);
  color: var(--aide-text-primary);
  transition: background 0.12s, border-color 0.12s;
}

.btn:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-text-muted);
}

.btn.primary {
  background: var(--aide-accent);
  border-color: var(--aide-accent);
  color: var(--aide-text-on-accent);
}

.btn.primary:hover {
  background: var(--aide-accent-hover);
}

.btn.danger {
  color: var(--aide-danger);
  border-color: color-mix(in srgb, var(--aide-danger) 30%, transparent);
}

.btn.danger:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
  border-color: var(--aide-danger);
}

.btn[disabled] {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
