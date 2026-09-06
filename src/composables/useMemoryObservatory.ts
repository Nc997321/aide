// 记忆观测台面板状态闭包：scan/snapshot/events 加载、双 scope（当前项目 / 全局）、
// 删除流。桌面专属（不进 remote REGISTRY），故放 src/composables 而非共享包。
//
// 2026-09-06：删 previews Map 与 preview()。原行内"纯文本 pre-wrap"预览用户体验差
// （无 markdown 渲染、不可编辑），改为点行直接打开 FileViewer.open(path) 弹窗——
// 与文件树点击 markdown 文件完全一致（marked 渲染、可编辑保存到盘）。磁盘基线
// 刷新靠面板头部「刷新」按钮 + 现成 mo.load(workspaceKey)。
import { ref } from "vue";
import { memoryObservatoryApi } from "@aide/sdk/api";
import type {
  ClaudeMdInfo,
  MemoryEvent,
  MemoryScanResult,
  MemorySnapshotDiff,
  ProjectScanResult,
} from "@aide/sdk/api";

export type ObservatoryScope = "project" | "all";

/** 主区面板开关（模块级单例，与 useMarketplace 同范式）：
 *  true 时 App.vue 用 MemoryObservatory 盖住 PaneLayout，PaneLayout v-show 保活；
 *  选中会话时 App 调 closePanel 切回聊天。
 *  2026-09-05：观测台从模态（App 的 observatoryVisible）改为一级主区视图，
 *  与插件市场/自动化面板并列——侧栏底部入口区两行语义一致。 */
const panelOpen = ref(false);
function openPanel() { panelOpen.value = true; }
function closePanel() { panelOpen.value = false; }
function togglePanel() { panelOpen.value = !panelOpen.value; }

export function useMemoryObservatory() {
  const loading = ref(false);
  const error = ref<string | null>(null);
  const scope = ref<ObservatoryScope>("project");
  const scan = ref<MemoryScanResult | null>(null);
  const diff = ref<MemorySnapshotDiff | null>(null);
  // P2 跨项目聚合：scope === "all" 时填充
  const projectScans = ref<ProjectScanResult[]>([]);
  const globalClaudeMd = ref<ClaudeMdInfo | null>(null);
  const events = ref<MemoryEvent[]>([]);
  const sessionNames = ref<Record<string, string>>({});
  const confirming = ref<string | null>(null);
  const deleting = ref(false);
  let loadSeq = 0;

  async function load(workspaceKey: string) {
    const seq = ++loadSeq;
    loading.value = true;
    error.value = null;
    try {
      if (scope.value === "all") {
        // 全局模式：全量项目扫描 + 不过滤的事件台账；快照 diff 是单项目语义，跳过。
        const [all, ev] = await Promise.all([
          memoryObservatoryApi.scanAll(),
          memoryObservatoryApi.events(null),
        ]);
        if (seq !== loadSeq) return;
        projectScans.value = all.projects;
        globalClaudeMd.value = all.claudeMd;
        events.value = ev.events;
        sessionNames.value = ev.sessionNames;
      } else {
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
      }
    } catch (e) {
      if (seq === loadSeq) error.value = String(e);
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  }

  async function setScope(s: ObservatoryScope, workspaceKey: string) {
    if (scope.value === s) return;
    scope.value = s;
    await load(workspaceKey);
  }

  /** 行点击直开 FileViewer 弹窗（无独立 preview 概念，详见模块头注释）。 */

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
      }
      syncDeleted(workspaceKey, name);
      return r.deleted || r.indexLineRemoved;
    } finally {
      deleting.value = false;
    }
  }

  /** 全局模式删除：更新 projectScans 里对应项目的扫描结果。 */
  async function removeGlobal(workspaceKey: string, name: string): Promise<boolean> {
    deleting.value = true;
    try {
      const r = await memoryObservatoryApi.deleteFile(workspaceKey, name);
      const p = projectScans.value.find((x) => x.key === workspaceKey);
      if (p) {
        const s = p.scan;
        s.topics = s.topics.filter((t) => t.name !== name);
        s.orphans = s.orphans.filter((n) => n !== name);
        s.deadlinks = s.deadlinks.filter((n) => n !== name);
        if (r.indexLineRemoved && s.index) {
          s.index.entries = s.index.entries.filter((e) => e.file !== name);
        }
      }
      syncDeleted(workspaceKey, name);
      return r.deleted || r.indexLineRemoved;
    } finally {
      deleting.value = false;
    }
  }

  function syncDeleted(workspaceKey: string, name: string) {
    // 后端已写 deleted 事件；本地同步一条，避免为重扫台账再发一次请求。
    events.value = [
      ...events.value,
      { ts: Date.now(), sessionId: "", workspaceKey, op: "deleted", memoryId: name },
    ];
    confirming.value = null;
  }

  return {
    loading,
    error,
    scope,
    scan,
    diff,
    projectScans,
    globalClaudeMd,
    events,
    sessionNames,
    confirming,
    deleting,
    load,
    setScope,
    remove,
    removeGlobal,
    panelOpen,
    openPanel,
    closePanel,
    togglePanel,
  };
}
