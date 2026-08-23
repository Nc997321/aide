import { ref, computed } from "vue";
import type { Ref } from "vue";
import type { PluginEntry, InstalledPlugin, SourceInfo } from "../types/marketplace";
import { marketplaceApi } from "../api/marketplace";
import { parseGitError } from "../utils/errors";
import type { ErrorAction } from "../utils/errors";

const sources = ref<SourceInfo[]>([]);
const plugins = ref<PluginEntry[]>([]);
const installedPlugins = ref<Map<string, InstalledPlugin>>(new Map());
const loading = ref(false);
const installing = ref<Set<string>>(new Set());
const updating = ref<Set<string>>(new Set());
const error = ref<string | null>(null);
const errorActions = ref<ErrorAction[]>([]);
const searchQuery = ref("");
const hiddenCount = ref(0);

const keyOf = (market: string, name: string) => `${name}@${market}`;

// 已安装但不在任何已启用市场源目录里的插件（local 市场直装、源被禁用后仍安装的）。
// 合成为列表条目——否则「已安装」视图按目录条目过滤永远看不到它们，
// 底部「N 已安装」与列表对不上。无更新/安装概念：versionId 与自身一致，hasUpdate 恒 false。
const installedOnlyEntries = computed<PluginEntry[]>(() => {
  const inCatalog = new Set(plugins.value.map((p) => keyOf(p.marketName, p.name)));
  const out: PluginEntry[] = [];
  for (const inst of installedPlugins.value.values()) {
    if (inCatalog.has(keyOf(inst.market, inst.name))) continue;
    out.push({
      name: inst.name,
      displayName: inst.displayName,
      description: inst.description,
      version: inst.version,
      versionId: inst.versionId,
      sourceId: inst.market,
      marketName: inst.market,
      category: "",
      homepage: "",
      repository: "",
      availability: "available",
      unsupported: [],
    });
  }
  return out;
});

// 展示全集 = 目录条目 + 已装但不在目录的条目；「全部」「已安装」共用，计数一致。
const allEntries = computed<PluginEntry[]>(() => [...plugins.value, ...installedOnlyEntries.value]);

const filteredPlugins = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return allEntries.value;
  return allEntries.value.filter((p) =>
    p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
  );
});

async function fetchSources() {
  try { sources.value = await marketplaceApi.listMarketplaceSources(); } catch (_) { /* best effort */ }
}

async function fetchPlugins() {
  loading.value = true; error.value = null; plugins.value = []; hiddenCount.value = 0;
  const enabledSources = sources.value.length ? sources.value.filter((s) => s.enabled) : [];
  try {
    let all: PluginEntry[] = []; let hidden = 0;
    for (const s of enabledSources) {
      try {
        const list = await marketplaceApi.fetchMarketplace(s.id);
        for (const p of list) { if (p.availability === "unavailable") { hidden++; } else { all.push(p); } }
      } catch (e) { /* 单源失败不阻断其他源；错误经 error 展示最后一次 */ setError(e); }
    }
    plugins.value = all; hiddenCount.value = hidden;
  } finally { loading.value = false; }
}

function setError(e: unknown) {
  const raw = typeof e === "string" ? e : (e as Error).message || "UNKNOWN_ERROR";
  const parsed = parseGitError(raw);
  error.value = parsed.message; errorActions.value = parsed.actions;
}

async function refreshInstalled() {
  try {
    const list = await marketplaceApi.listInstalledPlugins();
    const map = new Map<string, InstalledPlugin>();
    for (const p of list) map.set(keyOf(p.market, p.name), p);
    installedPlugins.value = map;
  } catch (_) { /* best effort */ }
}

function isInstalled(market: string, name: string) { return installedPlugins.value.has(keyOf(market, name)); }
function isInstalling(name: string) { return installing.value.has(name); }
function getInstalled(market: string, name: string) { return installedPlugins.value.get(keyOf(market, name)); }
function hasUpdate(entry: PluginEntry) {
  const inst = getInstalled(entry.marketName, entry.name);
  // 比对安装身份（versionId = 版本目录名 / sha）vs marketplace versionId（同源），同源可比。
  // 不能比语义版本：sha-pinned 插件 inst.version "6.2.0" 与 entry.version "" 永不相等。
  return !!inst && !!entry.versionId && inst.versionId !== entry.versionId;
}

async function installPlugin(entry: PluginEntry) {
  if (installing.value.has(entry.name)) return;
  installing.value = new Set([...installing.value, entry.name]); error.value = null;
  try { await marketplaceApi.installPlugin(entry.sourceId, entry.name); await refreshInstalled(); }
  catch (e) { setError(e); } finally { del(installing, entry.name); }
}
async function uninstallPlugin(entry: { market: string; name: string }) {
  if (installing.value.has(entry.name)) return;
  installing.value = new Set([...installing.value, entry.name]); error.value = null;
  try { await marketplaceApi.uninstallPlugin(entry.market, entry.name); await refreshInstalled(); }
  catch (e) { setError(e); } finally { del(installing, entry.name); }
}
async function updatePlugin(entry: PluginEntry) {
  if (updating.value.has(entry.name)) return;
  updating.value = new Set([...updating.value, entry.name]); error.value = null;
  try { await marketplaceApi.updatePlugin(entry.sourceId, entry.name); await refreshInstalled(); }
  catch (e) { setError(e); } finally { del(updating, entry.name); }
}
async function setEnabled(entry: { market: string; name: string }, enabled: boolean) {
  try { await marketplaceApi.setPluginEnabled(entry.market, entry.name, enabled); await refreshInstalled(); }
  catch (e) { setError(e); }
}
async function refreshSource(sourceId: string) {
  try { await marketplaceApi.refreshMarketplace(sourceId); await fetchPlugins(); }
  catch (e) { setError(e); }
}
async function setSourceEnabled(sourceId: string, enabled: boolean) {
  try { await marketplaceApi.setMarketplaceEnabled(sourceId, enabled); await fetchSources(); await fetchPlugins(); }
  catch (e) { setError(e); }
}
function del(set: Ref<Set<string>>, name: string) {
  const n = new Set(set.value); n.delete(name); set.value = n;
}

export function useMarketplace() {
  return {
    sources, plugins, installedPlugins, loading, installing, updating,
    error, errorActions, searchQuery, hiddenCount, filteredPlugins, allEntries,
    isInstalled, isInstalling, getInstalled, hasUpdate,
    fetchSources, fetchPlugins, refreshInstalled,
    installPlugin, uninstallPlugin, updatePlugin, setEnabled, refreshSource, setSourceEnabled,
  };
}
