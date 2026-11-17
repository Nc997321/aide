<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { appsApi, type MarketApp } from "@aide/sdk/api/apps";
import { useModal } from "../../composables/useModal";

const props = defineProps<{ search: string }>();
const apps = ref<MarketApp[]>([]);
const loading = ref(false);
const pending = ref<string | null>(null);
const error = ref("");
const catalogError = ref<string | null>(null);
let disposed = false;
const visibleApps = computed(() => {
  const query = props.search.trim().toLowerCase();
  return apps.value.filter((app) =>
    [app.name, app.description, app.id].some((value) => value.toLowerCase().includes(query)),
  );
});

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const listing = await appsApi.marketList();
    apps.value = listing.apps;
    catalogError.value = listing.catalogError;
  } catch (cause) {
    error.value = String(cause);
  } finally {
    loading.value = false;
  }
}

function removalLabel(app: MarketApp) {
  if (app.installedVersion || !app.shadowed) return "卸载";
  return app.installed ? "放弃改动" : "删除开发版";
}

function removalMessage(app: MarketApp) {
  if (app.installedVersion) return "将从当前 Host 卸载市场版。应用数据和工作区开发副本会保留。";
  if (app.shadowed) return "将删除当前工作区的开发副本，并结束应用启动的进程。应用数据会保留。";
  return "将卸载本地应用，移除与安装版相同的开发副本，并结束应用启动的进程。应用数据会保留。";
}

async function run(app: MarketApp, action: "install" | "uninstall" | "toggle") {
  if (pending.value) return;
  pending.value = app.id;
  error.value = "";
  try {
    if (action === "uninstall") {
      const label = removalLabel(app);
      const confirmed = await useModal().confirm(
        `${label}「${app.name}」`,
        removalMessage(app),
        label,
        true,
      );
      if (!confirmed || disposed) return;
      if (app.installedVersion) await appsApi.marketUninstall(app.id, app.installedVersion);
      else await appsApi.uninstall(app.id);
    } else if (action === "toggle") {
      if (app.enabled == null) return;
      if (app.enabled && !await useModal().confirm(
        `禁用「${app.name}」`,
        "禁用会结束此应用启动的进程。你可以在这里重新启用。",
        "禁用",
      )) return;
      if (disposed) return;
      await appsApi.setEnabled(app.id, !app.enabled);
    } else if (action === "install" && app.availableVersion) {
      await appsApi.marketInstall(app.id, app.availableVersion, app.installedVersion);
    }
    if (!disposed) await refresh();
  } catch (cause) {
    error.value = String(cause);
  } finally {
    pending.value = null;
  }
}

onMounted(refresh);
onBeforeUnmount(() => { disposed = true; });
</script>

<template>
  <section class="apps-market">
    <p class="hint">应用安装到当前窗口连接的 Host，安装后可在 Aide 面板中打开并授权。</p>
    <p v-if="loading" role="status">正在读取应用目录…</p>
    <div v-else-if="error || catalogError" role="alert">
      <p>{{ error || catalogError }}</p>
      <button type="button" class="btn" :disabled="pending !== null" @click="refresh">重新加载</button>
    </div>
    <p v-else-if="visibleApps.length === 0">{{ search.trim() ? "没有匹配的应用" : "暂无适用于此客户端的应用" }}</p>
    <article v-for="app in visibleApps" v-show="!loading" :key="app.id" class="app-card">
      <div>
        <strong>{{ app.name }}</strong>
        <span v-if="app.installedVersion" class="version">已安装 {{ app.installedVersion }}</span>
        <span v-else-if="app.installed" class="version">本地安装 {{ app.localVersion }}</span>
        <span v-else-if="app.shadowed" class="version">开发版 {{ app.localVersion }}</span>
        <span v-else class="version">{{ app.availableVersion }}</span>
        <p v-if="app.description" class="hint">{{ app.description }}</p>
        <p v-if="app.shadowed && app.installed" class="hint">当前工作区的开发版优先显示。</p>
        <p v-if="app.enabled === false" class="hint">已禁用</p>
      </div>
      <div class="app-actions">
        <button v-if="app.availableVersion && (!app.installed || app.canUpdate)" type="button" class="btn"
          :class="{ primary: !app.canUpdate }"
          :disabled="pending !== null" @click="run(app, 'install')">
          {{ app.canUpdate ? `更新到 ${app.availableVersion}` : "安装" }}
        </button>
        <button v-if="app.enabled != null" type="button" class="btn" :class="{ primary: !app.enabled }" :disabled="pending !== null"
          @click="run(app, 'toggle')">{{ app.enabled ? "禁用" : "启用" }}</button>
        <button v-if="app.installed || app.shadowed" type="button" class="btn danger" :disabled="pending !== null"
          @click="run(app, 'uninstall')">{{ removalLabel(app) }}</button>
        <span v-if="pending === app.id" class="hint" role="status">正在处理…</span>
      </div>
    </article>
  </section>
</template>

<style scoped>
.apps-market {
  display: grid;
  gap: 12px;
}
.app-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  background: var(--aide-surface-default);
}
.hint, .version {
  color: var(--aide-text-muted);
}
.app-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.version {
  margin-inline-start: 8px;
}
</style>
<style scoped src="./marketplace-buttons.css"></style>
