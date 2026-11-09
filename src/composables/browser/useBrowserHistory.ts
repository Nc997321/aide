import { readonly, ref } from "vue";
import { hostApi } from "@aide/sdk/api/host";
import { useComposerDrafts } from "@aide/sdk/composables/useComposerDrafts";
import {
  historyUrl, mergeRecents, parseHistory, persistentHistory, recentKey,
  type BrowserRecent, type RecentInput,
} from "./useBrowserHistory/model";
import type { NavStateDto } from "./useEmbeddedBrowser";

export type { BrowserRecent, BrowserRecordTarget, CreationMode } from "./useBrowserHistory/model";

const records = ref<BrowserRecent[]>([]);
const showBookmarkBar = ref(false);
const error = ref("");
const ready = ref(false);
let storageKey: string | null = null;
let loading: Promise<void> | null = null;
let preferenceChanged = false;
const removedBeforeLoad = new Set<string>();

function reportFailure(cause: unknown): void {
  error.value = `浏览器记录暂未保存：${String(cause)}`;
  console.warn("[browser-history]", cause);
}

async function load(): Promise<void> {
  const host = await hostApi.identity();
  if (!host?.key) throw new Error("无法确认当前 Host，未混用其他 Host 的历史记录");
  const key = `aide:browser-history:v1:${host.key}`;
  const saved = parseHistory(localStorage.getItem(key));
  records.value = mergeRecents([...records.value, ...saved.records]
    .filter((entry) => !removedBeforeLoad.has(recentKey(entry))));
  removedBeforeLoad.clear();
  if (!preferenceChanged) showBookmarkBar.value = saved.showBookmarkBar;
  storageKey = key;
  ready.value = true;
  error.value = "";
}

async function initialize(): Promise<void> {
  if (ready.value) return;
  loading ??= load().finally(() => { loading = null; });
  await loading;
}

function persist(): void {
  if (!storageKey) return;
  localStorage.setItem(storageKey, JSON.stringify({
    version: 1, records: persistentHistory(records.value), showBookmarkBar: showBookmarkBar.value,
  }));
  error.value = "";
}

function save(): void {
  void initialize().then(persist).catch(reportFailure);
}

function record(input: RecentInput): void {
  if (!input.title.trim()) return;
  const entry: BrowserRecent = { ...input, title: input.title.slice(0, 512), visitedAt: Date.now() };
  removedBeforeLoad.delete(recentKey(entry));
  records.value = mergeRecents([entry, ...records.value]);
  save();
}

function recordNavigation(nav: NavStateDto): void {
  if (nav.state !== "ready") return;
  const url = historyUrl(nav.url);
  if (url) record({ kind: "web", url, title: nav.title.trim() || url });
}

function remove(key: string): BrowserRecent | undefined {
  if (!ready.value) removedBeforeLoad.add(key);
  const removed = records.value.find((entry) => recentKey(entry) === key);
  records.value = records.value.filter((entry) => recentKey(entry) !== key);
  save();
  return removed;
}

function restore(entry: BrowserRecent): void {
  removedBeforeLoad.delete(recentKey(entry));
  records.value = mergeRecents([...records.value, entry]);
  save();
}

function setBookmarkBar(show: boolean): void {
  preferenceChanged = true;
  showBookmarkBar.value = show;
  save();
}

/** 草稿别名已随 session_init 搬迁；只有此时才把新会话引用写入持久历史。 */
function finalizeSession(realId: string): void {
  const { resolveDraftKey } = useComposerDrafts();
  records.value = mergeRecents(records.value.map((entry) => {
    if (entry.kind === "web" || entry.target.kind === "session" || resolveDraftKey(entry.target.key) !== realId) return entry;
    return { ...entry, target: { kind: "session", key: realId } };
  }));
  if (records.value.length) save();
}

export function useBrowserHistory() {
  return {
    records: readonly(records), showBookmarkBar: readonly(showBookmarkBar),
    error: readonly(error), ready: readonly(ready),
    initialize, record, recordNavigation, remove, restore, setBookmarkBar, finalizeSession,
  };
}

export function __resetBrowserHistoryForTest(): void {
  records.value = [];
  showBookmarkBar.value = false;
  error.value = "";
  ready.value = false;
  storageKey = null;
  loading = null;
  preferenceChanged = false;
  removedBeforeLoad.clear();
}
