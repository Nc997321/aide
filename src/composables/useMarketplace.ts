import { ref, computed } from "vue";
import type { PluginEntry, InstalledPlugin } from "../types/marketplace";
import { marketplaceApi } from "../api/marketplace";
import { parseGitError } from "../utils/errors";
import type { ErrorAction } from "../utils/errors";

export const DEFAULT_MARKETPLACE_URL = "https://github.com/anthropics/claude-plugins-community";

// Module-level reactive state (singleton, shared across all consumers)

const plugins = ref<PluginEntry[]>([]);
const installedPlugins = ref<Map<string, InstalledPlugin>>(new Map());
const loading = ref(false);
const installing = ref<Set<string>>(new Set());
const error = ref<string | null>(null);
const errorActions = ref<ErrorAction[]>([]);
const searchQuery = ref("");

// ── Computed ──

const filteredPlugins = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return plugins.value;
  return plugins.value.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q),
  );
});

// ── Actions ──

async function fetchPlugins() {
  loading.value = true;
  error.value = null;
  plugins.value = []; // clear stale data before re-fetch
  try {
    plugins.value = await marketplaceApi.fetchMarketplace(DEFAULT_MARKETPLACE_URL);
  } catch (e) {
    const raw = typeof e === "string" ? e : (e as Error).message || "UNKNOWN_ERROR";
    const parsed = parseGitError(raw);
    error.value = parsed.message;
    errorActions.value = parsed.actions;
  } finally {
    loading.value = false;
  }
}

async function refreshInstalled() {
  try {
    const list = await marketplaceApi.listInstalledPlugins();
    const map = new Map<string, InstalledPlugin>();
    for (const p of list) map.set(p.name, p);
    installedPlugins.value = map;
  } catch (_) {
    // best effort
  }
}

function isInstalled(name: string): boolean {
  return installedPlugins.value.has(name);
}

function isInstalling(name: string): boolean {
  return installing.value.has(name);
}

async function installPlugin(entry: PluginEntry) {
  if (installing.value.has(entry.name)) return;
  installing.value = new Set([...installing.value, entry.name]);
  error.value = null;
  try {
    await marketplaceApi.installPlugin(entry.repo, entry.name);
    await refreshInstalled();
  } catch (e) {
    const raw = typeof e === "string" ? e : (e as Error).message || "UNKNOWN_ERROR";
    const parsed = parseGitError(raw);
    error.value = parsed.message;
    errorActions.value = parsed.actions;
  } finally {
    const next = new Set(installing.value);
    next.delete(entry.name);
    installing.value = next;
  }
}

async function uninstallPlugin(name: string) {
  if (installing.value.has(name)) return;
  installing.value = new Set([...installing.value, name]);
  error.value = null;
  try {
    await marketplaceApi.uninstallPlugin(name);
    await refreshInstalled();
  } catch (e) {
    const raw = typeof e === "string" ? e : (e as Error).message || "UNKNOWN_ERROR";
    const parsed = parseGitError(raw);
    error.value = parsed.message;
    errorActions.value = parsed.actions;
  } finally {
    const next = new Set(installing.value);
    next.delete(name);
    installing.value = next;
  }
}

// ── Export ──

export function useMarketplace() {
  return {
    plugins,
    installedPlugins,
    loading,
    installing,
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
  };
}
