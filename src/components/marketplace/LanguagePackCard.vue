<script setup lang="ts">
import { computed } from "vue";
import type { LanguagePack } from "@aide/sdk/types/lspPacks";
import { useLanguagePacks } from "../../composables/useLanguagePacks";
import { installGuideFor } from "../../lspInstallGuide";

/**
 * 插件市场「语言服务器」分类的一张卡：一键把语言服务器装到当前窗口连着的 Host。
 * 装 / 卸 / 更新都走 useLanguagePacks（与标题栏「语言环境」面板共用一份状态）。
 */
const props = defineProps<{
  pack: LanguagePack;
  /** 当前工作区探测到了它服务的语言：卡片标「当前项目在用」。 */
  inUse?: boolean;
}>();

const { busy, errors, install, uninstall } = useLanguagePacks();

const state = computed(() => busy.value[props.pack.id] ?? (props.pack.installing ? "install" : null));
const iconText = computed(() => installGuideFor(props.pack.langs[0] ?? "")?.shortName ?? props.pack.name.slice(0, 2));
const langNames = computed(() =>
  props.pack.langs.map((l) => installGuideFor(l)?.displayName ?? l).join(" · "),
);
const statusText = computed(() => {
  if (state.value === "install") return props.pack.installed ? "更新中…" : "安装中…";
  if (state.value === "uninstall") return "卸载中…";
  const inst = props.pack.installed;
  if (!inst) return "未安装";
  return `已安装 ${inst.version} · ${inst.source}`;
});
</script>

<template>
  <div class="card" :class="{ installed: !!pack.installed }">
    <div class="body">
      <div class="picon">{{ iconText }}</div>
      <div class="main">
        <div class="top">
          <span class="name">{{ pack.name }}</span>
          <span class="server">{{ pack.server }}</span>
          <span class="ver">v{{ pack.version }}</span>
          <span v-if="inUse" class="inuse">当前项目在用</span>
        </div>
        <div class="desc">{{ pack.summary }}</div>
        <div class="meta">{{ langNames }} · {{ pack.method }}</div>
        <div v-if="errors[pack.id]" class="err">{{ errors[pack.id] }}</div>
      </div>
    </div>
    <div class="actions">
      <div class="status" :class="{ on: !!pack.installed && !state, busy: !!state }">
        <span v-if="state" class="spin" aria-hidden="true" />
        <span v-else class="d" />
        {{ statusText }}
      </div>
      <div class="btns">
        <button
          v-if="pack.installed?.updateAvailable"
          class="btn"
          :disabled="!!state"
          @click="install(pack.id)"
        >更新</button>
        <button
          v-if="!pack.installed"
          class="btn primary"
          :disabled="!!state"
          @click="install(pack.id)"
        >{{ state === "install" ? "安装中…" : "安装" }}</button>
        <button
          v-else
          class="btn danger"
          :disabled="!!state"
          @click="uninstall(pack.id)"
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

.body {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.main {
  min-width: 0;
}

.picon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 30%, transparent);
  box-shadow: var(--aide-highlight-inset);
}

.top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.name {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
}

.server,
.ver {
  font-size: 11px;
  color: var(--aide-text-muted);
}

.inuse {
  font-size: 10.5px;
  padding: 1.5px 7px;
  border-radius: 4px;
  color: var(--aide-success);
  border: 1px solid color-mix(in srgb, var(--aide-success) 35%, transparent);
  background: color-mix(in srgb, var(--aide-success) 10%, transparent);
}

.desc {
  color: var(--aide-text-secondary);
  font-size: 12.5px;
  margin-top: 6px;
  line-height: 1.5;
}

.meta {
  margin-top: 6px;
  font-size: 11px;
  color: var(--aide-text-muted);
  line-height: 1.5;
}

.err {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--aide-danger);
  white-space: pre-line;
  word-break: break-word;
}

.actions {
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
  color: var(--aide-text-muted);
}

.status .d {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--aide-text-muted);
}

.status.on {
  color: var(--aide-success);
}

.status.on .d {
  background: var(--aide-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aide-success) 16%, transparent);
}

.status.busy {
  color: var(--aide-accent);
}

.spin {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--aide-accent) 30%, transparent);
  border-top-color: var(--aide-accent);
  animation: lp-spin 0.8s linear infinite;
}

@keyframes lp-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
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
