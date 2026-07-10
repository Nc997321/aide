import { computed, reactive } from "vue";
import {
  createBlankRoot,
  createTab,
  findGroup,
  findTabById,
  findTabBySession,
  listGroups,
  normalize,
  removeTab,
  restoreSnapshot,
  setSplitSizes,
  splitGroup,
  toSnapshot,
  type Direction,
  type GroupNode,
  type LayoutSnapshot,
  type PaneNode,
} from "./paneLayout/tree";
import { useSessionState } from "./useSessionState";
import { useSessionNames } from "./useSessionNames";
import { useSessionWorkspaces } from "./useSessionWorkspaces";
import { getLastDispatchedPrompt } from "./useChatSession";

/**
 * 聊天区多 tab + 任意分屏的状态层（模块级 reactive 单例，同 useSessionState 风格）。
 *
 * 树操作本体在 paneLayout/tree.ts（纯函数）；这里管三件事：
 *   1. 把树包成 reactive、维护 focusedGroupId、导出 activeSessionId 给全体下游
 *      （右面板 / 权限弹窗 / 标题栏 / 侧栏高亮 —— 语义与旧的单一 activeSessionId 一致）
 *   2. 预览 tab 语义（见 openSession 注释，用户逐字确认过的行为）
 *   3. 快照进出口（serialize/restore），持久化落盘由 paneLayout/persistence.ts 负责
 *      —— 本文件不 import Tauri，保持可脱离宿主单测
 */

interface LayoutState {
  root: PaneNode;
  focusedGroupId: string;
}

function blankState(pendingName?: string): LayoutState {
  const root = createBlankRoot(pendingName);
  return { root, focusedGroupId: root.id };
}

const layout = reactive<LayoutState>(blankState());

const { state: sessionState } = useSessionState();

/**
 * 「已启动」判定：进程存活（状态非 stopped），或本次运行中派发过消息（进程后来
 * 死了也算启动过）。只看过历史不算——点开旧会话看记录仍是预览 tab，可被覆盖。
 */
function defaultIsStarted(sid: string): boolean {
  const st = sessionState[sid];
  return (st !== undefined && st !== "stopped") || !!getLastDispatchedPrompt(sid);
}
let isStarted = defaultIsStarted;

function focusedGroup(): GroupNode {
  const g = findGroup(layout.root, layout.focusedGroupId);
  if (g) return g;
  // 防御：聚焦引用失效（不应发生）→ 回落到视觉序第一个组
  const first = listGroups(layout.root)[0];
  layout.focusedGroupId = first.id;
  return first;
}

/** 树被换根/规范化后的统一收尾：兜底空树 + 修正聚焦引用。 */
function commitRoot(newRoot: PaneNode | null) {
  layout.root = newRoot ?? blankState().root;
  if (!findGroup(layout.root, layout.focusedGroupId)) {
    layout.focusedGroupId = listGroups(layout.root)[0].id;
  }
}

function activateTab(group: GroupNode, tabId: string) {
  group.activeTabId = tabId;
  layout.focusedGroupId = group.id;
  if (!mruFrozen) touchMru(tabId);
}

// ── MRU 切换（OS Alt+Tab 语义）────────────────────────────────────────────────
// 全局按「最近使用」排序的 tab 栈：按住 Ctrl 连按 Tab 沿栈回溯（回溯期间冻结
// 栈序），松开 Ctrl 提交——快速按一次即在最近两个会话间往返。栈里只存 tab id，
// 已关闭的 tab 在取用时惰性过滤，不做同步清理。

const MRU_CAP = 64;
const mru: string[] = [];
let mruFrozen = false;
let mruWalk: { list: string[]; pointer: number } | null = null;

function touchMru(tabId: string) {
  const i = mru.indexOf(tabId);
  if (i !== -1) mru.splice(i, 1);
  mru.unshift(tabId);
  if (mru.length > MRU_CAP) mru.length = MRU_CAP;
}

export function usePaneLayout() {
  /**
   * 打开会话（侧栏单击 / 标题栏 / 通知横幅 / 搜索面板统一入口）。
   *
   * 语义（用户确认）：
   * - 全局唯一：已在任何组打开 → 聚焦过去，不新开不覆盖
   * - 目标未启动且聚焦组有预览 tab → 覆盖预览 tab 的内容
   * - 否则新增 tab；目标未启动 → 该 tab 成为本组预览 tab，已启动 → 固定 tab
   */
  function openSession(sessionId: string) {
    const existing = findTabBySession(layout.root, sessionId);
    if (existing) {
      activateTab(existing.group, existing.tab.id);
      return;
    }
    const group = focusedGroup();
    if (!isStarted(sessionId) && group.previewTabId) {
      const preview = group.tabs.find((t) => t.id === group.previewTabId);
      if (preview) {
        preview.sessionId = sessionId;
        delete preview.pendingName;
        activateTab(group, preview.id);
        return;
      }
    }
    const tab = createTab(sessionId);
    group.tabs.push(tab);
    if (!isStarted(sessionId)) group.previewTabId = tab.id;
    activateTab(group, tab.id);
  }

  /** 新建会话（Ctrl+N / 侧栏按钮）：空白面板天然未启动，走预览语义。 */
  function openBlankTab(pendingName: string) {
    const group = focusedGroup();
    const preview = group.previewTabId
      ? group.tabs.find((t) => t.id === group.previewTabId)
      : undefined;
    if (preview) {
      preview.sessionId = null;
      preview.pendingName = pendingName;
      activateTab(group, preview.id);
      return;
    }
    const tab = createTab(null, pendingName);
    group.tabs.push(tab);
    group.previewTabId = tab.id;
    activateTab(group, tab.id);
  }

  /** 侧栏右键「在新标签页打开」：显式动作，无论启动与否都开固定 tab。 */
  function openSessionInNewTab(sessionId: string) {
    const existing = findTabBySession(layout.root, sessionId);
    if (existing) {
      activateTab(existing.group, existing.tab.id);
      return;
    }
    const group = focusedGroup();
    const tab = createTab(sessionId);
    group.tabs.push(tab);
    activateTab(group, tab.id);
  }

  /** 侧栏右键「在右侧/下方分屏打开」。已打开 → 全局唯一优先，只聚焦不拆分。 */
  function openSessionInSplit(sessionId: string, direction: Direction) {
    const existing = findTabBySession(layout.root, sessionId);
    if (existing) {
      activateTab(existing.group, existing.tab.id);
      return;
    }
    const res = splitGroup(layout.root, layout.focusedGroupId, direction, false);
    if (!res) return;
    // 空组约定：splitGroup(moveActiveTab=false) 返回的新组必须立刻塞 tab
    const tab = createTab(sessionId);
    res.newGroup.tabs.push(tab);
    res.newGroup.activeTabId = tab.id;
    if (!isStarted(sessionId)) res.newGroup.previewTabId = tab.id;
    commitRoot(res.root);
    layout.focusedGroupId = res.newGroup.id;
  }

  /** tab 右键/快捷键「拆分」：激活 tab 移入新组（组内只剩 1 个 tab 时新组给空白面板）。 */
  function splitFocusedGroup(direction: Direction, groupId?: string) {
    const res = splitGroup(layout.root, groupId ?? layout.focusedGroupId, direction, true);
    if (!res) return;
    commitRoot(res.root);
    layout.focusedGroupId = res.newGroup.id;
  }

  function closeTab(groupId: string, tabId: string) {
    commitRoot(removeTab(layout.root, groupId, tabId));
  }

  /** 关闭聚焦组的激活 tab（Ctrl+W）。 */
  function closeActiveTab() {
    const group = focusedGroup();
    if (group.activeTabId) closeTab(group.id, group.activeTabId);
  }

  function closeOtherTabs(groupId: string, tabId: string) {
    const group = findGroup(layout.root, groupId);
    if (!group || !group.tabs.some((t) => t.id === tabId)) return;
    group.tabs = group.tabs.filter((t) => t.id === tabId);
    group.activeTabId = tabId;
    if (group.previewTabId !== tabId) group.previewTabId = null;
  }

  /** 会话被删除（侧栏删除动作）：关掉对应 tab。 */
  function closeSessionTab(sessionId: string) {
    const hit = findTabBySession(layout.root, sessionId);
    if (hit) closeTab(hit.group.id, hit.tab.id);
  }

  /** 预览转正：会话启动（首次派发消息）或双击 tab 时调用。 */
  function promoteTab(sessionId: string) {
    const hit = findTabBySession(layout.root, sessionId);
    if (hit && hit.group.previewTabId === hit.tab.id) hit.group.previewTabId = null;
  }

  function promoteTabById(groupId: string, tabId: string) {
    const group = findGroup(layout.root, groupId);
    if (group && group.previewTabId === tabId) group.previewTabId = null;
  }

  /** 空白 tab 首次发消息：绑定现场生成的临时 session id。 */
  function bindSession(tabId: string, sessionId: string) {
    const hit = findTabById(layout.root, tabId);
    if (hit) hit.tab.sessionId = sessionId;
  }

  /** SDK session_init 确认真实 id：临时 id → 真实 id（App.vue 的 onSessionCreated 里调）。 */
  function rebindSession(oldSessionId: string, newSessionId: string) {
    const hit = findTabBySession(layout.root, oldSessionId);
    if (hit) hit.tab.sessionId = newSessionId;
  }

  /** 取走空白面板预起的名字（一次性），App.vue 落盘会话元数据时用。 */
  function takePendingName(sessionId: string): string {
    const hit = findTabBySession(layout.root, sessionId);
    if (!hit || hit.tab.pendingName === undefined) return "";
    const name = hit.tab.pendingName;
    delete hit.tab.pendingName;
    return name;
  }

  function focusGroup(groupId: string) {
    if (findGroup(layout.root, groupId)) layout.focusedGroupId = groupId;
  }

  function setActiveTab(groupId: string, tabId: string) {
    const group = findGroup(layout.root, groupId);
    if (group && group.tabs.some((t) => t.id === tabId)) activateTab(group, tabId);
  }

  /**
   * MRU 切换步进（Ctrl+Tab / Ctrl+Shift+Tab，OS Alt+Tab 语义，跨组全局）。
   * 首次按下开始回溯（冻结 MRU 栈序），后续按键沿列表走；松开 Ctrl 时
   * 调 endMruSwitch 提交。已关闭 tab 惰性过滤。
   */
  function mruSwitch(delta: 1 | -1) {
    if (!mruWalk) {
      const currentId = focusedGroup().activeTabId;
      const valid = (id: string) => !!findTabById(layout.root, id);
      const seen = new Set<string>(currentId ? [currentId] : []);
      const list: string[] = currentId ? [currentId] : [];
      for (const id of mru) {
        if (!seen.has(id) && valid(id)) {
          seen.add(id);
          list.push(id);
        }
      }
      // MRU 栈没盖到的 tab（如恢复布局后从未点过的）按视觉序垫底，保证全部可达
      for (const g of listGroups(layout.root)) {
        for (const t of g.tabs) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            list.push(t.id);
          }
        }
      }
      if (list.length < 2) return;
      mruWalk = { list, pointer: 0 };
      mruFrozen = true;
    }
    const { list } = mruWalk;
    mruWalk.pointer = (mruWalk.pointer + delta + list.length) % list.length;
    const hit = findTabById(layout.root, list[mruWalk.pointer]);
    if (hit) activateTab(hit.group, hit.tab.id);
  }

  /** 结束 MRU 回溯（Ctrl 松开）：解冻栈序并把落点提到栈顶。 */
  function endMruSwitch() {
    if (!mruWalk) return;
    mruWalk = null;
    mruFrozen = false;
    const currentId = focusedGroup().activeTabId;
    if (currentId) touchMru(currentId);
  }

  function setSizes(splitId: string, sizes: number[]) {
    setSplitSizes(layout.root, splitId, sizes);
  }

  /** 整体重置为单组空白面板（工作区无快照可恢复时）。 */
  function reset(pendingName?: string) {
    const s = blankState(pendingName);
    layout.root = s.root;
    layout.focusedGroupId = s.focusedGroupId;
  }

  function serialize(): LayoutSnapshot | null {
    const { names } = useSessionNames();
    const { workspaceOf } = useSessionWorkspaces();
    return toSnapshot(layout.root, layout.focusedGroupId, (sid) => {
      const ws = workspaceOf(sid);
      return {
        ...(names[sid] ? { name: names[sid] } : {}),
        ...(ws ? { wsKey: ws.wsKey, wsPath: ws.wsPath } : {}),
      };
    });
  }

  /** 快照恢复；结构非法/剔除后为空 → 回退空白布局。返回是否成功恢复。 */
  function restore(snapshot: LayoutSnapshot, validSessionIds?: ReadonlySet<string>): boolean {
    const restored = restoreSnapshot(snapshot, validSessionIds);
    if (!restored) {
      reset();
      return false;
    }
    layout.root = restored.root;
    layout.focusedGroupId = restored.focusedGroupId;
    // 恢复的 tab 一律非预览（tree 层设计），但若聚焦组激活 tab
    // 的会话未启动，把它标回预览 tab——否则 openSession 预览覆盖
    // 逻辑对未启动会话不生效，每次点击侧栏都会新建 tab。
    const fg = findGroup(layout.root, layout.focusedGroupId);
    if (fg && fg.activeTabId) {
      const activeTab = fg.tabs.find(t => t.id === fg.activeTabId);
      if (activeTab?.sessionId && !isStarted(activeTab.sessionId)) {
        fg.previewTabId = fg.activeTabId;
      }
    }
    return true;
  }

  return {
    /** 只读浏览布局树用（渲染层）；变更一律走下面的操作函数 */
    layout,
    /** 聚焦组激活 tab 的 session id（"" = 空白面板）——全体下游的「当前会话」 */
    activeSessionId: computed(() => {
      const g = findGroup(layout.root, layout.focusedGroupId) ?? listGroups(layout.root)[0];
      const tab = g.tabs.find((t) => t.id === g.activeTabId);
      return tab?.sessionId ?? "";
    }),
    openSession,
    openBlankTab,
    openSessionInNewTab,
    openSessionInSplit,
    splitFocusedGroup,
    closeTab,
    closeActiveTab,
    closeOtherTabs,
    closeSessionTab,
    promoteTab,
    promoteTabById,
    bindSession,
    rebindSession,
    takePendingName,
    focusGroup,
    setActiveTab,
    mruSwitch,
    endMruSwitch,
    setSizes,
    reset,
    serialize,
    restore,
  };
}

/** 仅测试用：重置单例状态；可注入「已启动」判定（缺省恢复真实实现）。 */
export function __resetPaneLayoutForTest(startedProbe?: (sid: string) => boolean) {
  const s = blankState();
  layout.root = s.root;
  layout.focusedGroupId = s.focusedGroupId;
  isStarted = startedProbe ?? defaultIsStarted;
  mru.length = 0;
  mruFrozen = false;
  mruWalk = null;
}
