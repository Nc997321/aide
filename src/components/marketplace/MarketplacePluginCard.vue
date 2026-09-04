<script setup lang="ts">
import type { PluginEntry } from "../../types/marketplace";
import { computed } from "vue";
import { openExternal } from "../../api";
import { useMarketplace } from "../../composables/useMarketplace";
import { useModal } from "../../composables/useModal";

const props = defineProps<{
  entry: PluginEntry;
  /** list = 默认列表卡；featured = 精选推荐网格卡（仿设计稿：图标+名称在上，操作在底部） */
  variant?: "list" | "featured";
}>();

const featured = computed(() => props.variant === "featured");

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

// 无图标时回退：取名称第一个英文字母大写（无英文字母 → "P"）。
const iconLetter = computed(() => {
  const m = (props.entry.displayName || props.entry.name).match(/[A-Za-z]/);
  return m ? m[0].toUpperCase() : "P";
});

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
    case "local":
      return "本地";
    default:
      return props.entry.sourceId;
  }
});

const badgeClass = computed(() => {
  switch (props.entry.sourceId) {
    case "claude-plugins-official":
      return "official";
    case "claude-community":
      return "community";
    default:
      // 合成本地条目（sourceId=market）与未知源共用中性徽标。
      return "local";
  }
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

// 固定源 → GitHub 仓库（entry.repository/homepage 缺失时的详情兜底）。
const SOURCE_REPO: Record<string, string> = {
  "claude-plugins-official": "anthropics/claude-plugins-official",
  "claude-community": "anthropics/claude-plugins-community",
};

// 详情链接：优先插件自带的 repository / homepage（绝对 URL），否则回退到所属市场源的仓库。
const detailUrl = computed(() => {
  const r = props.entry.repository;
  const h = props.entry.homepage;
  if (/^https?:\/\//i.test(r)) return r;
  if (/^https?:\/\//i.test(h)) return h;
  const repo = SOURCE_REPO[props.entry.sourceId];
  return repo ? `https://github.com/${repo}` : "";
});

function openGit() {
  const url = detailUrl.value;
  if (url) void openExternal(url);
}
</script>

<template>
  <div class="card" :class="{ featured }">
    <!-- 精选推荐网格卡 -->
    <template v-if="featured">
      <div class="f-head">
        <img v-if="entry.icon" class="picon" :src="entry.icon" :alt="entry.displayName || entry.name" />
        <div v-else class="picon picon-placeholder">{{ iconLetter }}</div>
        <span class="name" v-tooltip="'在 GitHub 查看详情'" @click="openGit">{{ entry.displayName || entry.name }}</span>
      </div>
      <div class="desc">{{ entry.description }}</div>
      <div class="f-tags">
        <span class="badge" :class="badgeClass">{{ sourceLabel }}</span>
        <span v-if="entry.category" class="cat">{{ entry.category }}</span>
      </div>
      <span v-if="entry.availability === 'mixed'" class="caveat">{{ caveatText }}</span>
      <div class="f-foot">
        <span class="f-meta">{{ sourceLabel }}<span class="f-ver"> · v{{ installed?.version || entry.version || "—" }}</span></span>
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
    </template>
    <!-- 默认列表卡 -->
    <template v-else>
      <div class="body">
        <img v-if="entry.icon" class="picon" :src="entry.icon" :alt="entry.displayName || entry.name" />
        <div v-else class="picon picon-placeholder">{{ iconLetter }}</div>
        <div>
          <div class="top">
            <span class="name" v-tooltip="'在 GitHub 查看详情'" @click="openGit">{{ entry.displayName || entry.name }}</span>
            <span class="ver">v{{ installed?.version || entry.version || "—" }}</span>
            <span class="badge" :class="badgeClass">{{ sourceLabel }}</span>
            <span v-if="entry.category" class="cat">{{ entry.category }}</span>
          </div>
          <div class="desc">{{ entry.description }}</div>
          <span v-if="entry.availability === 'mixed'" class="caveat">{{ caveatText }}</span>
          <span v-else-if="entry.availability === 'unavailable'" class="caveat unavailable-caveat">在 Aide 中不可用</span>
        </div>
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
    </template>
  </div>
</template>

<style scoped>
.card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 18px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  padding: 14px 16px;
  margin-top: 10px;
  box-shadow: var(--aide-highlight-inset);
  transition: border-color var(--aide-ease-t), background var(--aide-ease-t), box-shadow var(--aide-ease-t);
}

.card:hover {
  border-color: var(--aide-border-strong);
  background: var(--aide-surface-default);
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-md);
}

.card .top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.card .body {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.picon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  flex: 0 0 auto;
  object-fit: cover;
  box-shadow: var(--aide-highlight-inset);
}

.picon-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 30%, transparent);
}

/* ── 精选推荐网格卡（仿设计稿：纵向排布，操作置底） ── */

.card.featured {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 0;
}

.card.featured .f-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.card.featured .picon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
}

.card.featured .f-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.card.featured .f-foot {
  margin-top: auto;
  padding-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card.featured .f-meta {
  font-size: 11px;
  color: var(--aide-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card.featured .f-ver {
  color: var(--aide-text-muted);
}

.card .name {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  transition: text-decoration-color 0.12s, color 0.12s;
}

.card .name:hover {
  color: var(--aide-accent);
  text-decoration-color: var(--aide-accent);
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

.badge.local {
  color: var(--aide-text-secondary);
  background: var(--aide-bg-deep);
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
  line-height: 1.5;
  /* 市场面板空间有限：描述最多两行，超出截断，详情点名称去 GitHub。 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
