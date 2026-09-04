// 记忆观测台面板状态闭包：scan/snapshot 加载、删除流、预览缓存。
// 桌面专属（不进 remote REGISTRY），故放 src/composables 而非共享包。
import { reactive, ref } from "vue";
import { memoryObservatoryApi } from "@aide/sdk/api";
import type { MemoryEvent, MemoryScanResult, MemorySnapshotDiff } from "@aide/sdk/api";

export function useMemoryObservatory() {
  const loading = ref(false);
  const error = ref<string | null>(null);
  const scan = ref<MemoryScanResult | null>(null);
  const diff = ref<MemorySnapshotDiff | null>(null);
  const events = ref<MemoryEvent[]>([]);
  const sessionNames = ref<Record<string, string>>({});
  const previews = reactive(new Map<string, string>());
  const confirming = ref<string | null>(null);
  const deleting = ref(false);
  let loadSeq = 0;

  async function load(workspaceKey: string) {
    const seq = ++loadSeq;
    loading.value = true;
    error.value = null;
    try {
      const [s, d, ev] = await Promise.all([
        memoryObservatoryApi.scan(workspaceKey),
        memoryObservatoryApi.snapshot(workspaceKey),
        memoryObservatoryApi.events(workspaceKey),
      ]);
      if (seq !== loadSeq) return; // 过期响应丢弃
      scan.value = s;
      diff.value = d;
      events.value = ev.events;
      sessionNames.value = ev.sessionNames;
      previews.clear();
    } catch (e) {
      if (seq === loadSeq) error.value = String(e);
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  }

  async function preview(workspaceKey: string, name: string): Promise<string> {
    const cached = previews.get(name);
    if (cached != null) return cached;
    const text = await memoryObservatoryApi.readFile(workspaceKey, name);
    previews.set(name, text);
    return text;
  }

  /** 删除记忆：成功后本地状态同步（行移除 + 孤儿/死链计数联动），不重扫。 */
  async function remove(workspaceKey: string, name: string): Promise<boolean> {
    deleting.value = true;
    try {
      const r = await memoryObservatoryApi.deleteFile(workspaceKey, name);
      const s = scan.value;
      if (s) {
        s.topics = s.topics.filter((t) => t.name !== name);
        s.orphans = s.orphans.filter((n) => n !== name);
        s.deadlinks = s.deadlinks.filter((n) => n !== name);
        if (r.indexLineRemoved && s.index) {
          s.index.entries = s.index.entries.filter((e) => e.file !== name);
        }
        previews.delete(name);
      }
      // 后端已写 deleted 事件；本地同步一条，避免为重扫台账再发一次请求。
      events.value = [
        ...events.value,
        { ts: Date.now(), sessionId: "", workspaceKey, op: "deleted", memoryId: name },
      ];
      confirming.value = null;
      return r.deleted || r.indexLineRemoved;
    } finally {
      deleting.value = false;
    }
  }

  return {
    loading,
    error,
    scan,
    diff,
    events,
    sessionNames,
    previews,
    confirming,
    deleting,
    load,
    preview,
    remove,
  };
}
