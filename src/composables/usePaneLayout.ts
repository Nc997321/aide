import { computed, reactive } from "vue";
import {
  createEmptyRoot,
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
  type TabItem,
} from "./paneLayout/tree";
import { useSessionState } from "./useSessionState";
import { useSessionNames } from "./useSessionNames";
import { useSessionWorkspaces } from "./useSessionWorkspaces";
import { getLastDispatchedPrompt, stopSessionById } from "./useChatSession";

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
  /**
   * 零 tab 欢迎态（hero）选定的「下一新会话归属」：hero 点归属选择器改的是它
   * 而不是活动工作区——选归属 ≠ 切工作区。首个空白 tab 创建时由调用方取用
   * （openBlankTab 的 pendingWs），取用后即清。不落盘（快照恢复与此无关）。
   */
  defaultWs?: TabItem["pendingWs"] | null;
}

/** 初始/兜底状态：空根组（零会话欢迎态——无 tab 栏，居中 hero 输入区）。 */
function emptyState(): LayoutState {
  const root = createEmptyRoot();
  return { root, focusedGroupId: root.id };
}

const layout = reactive<LayoutState>(emptyState());

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

/** 树被换根/规范化后的统一收尾：空树兜底空根组（欢迎态）+ 修正聚焦引用。 */
function commitRoot(newRoot: PaneNode | null) {
  layout.root = newRoot ?? createEmptyRoot();
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
        delete preview.pendingWs; // 改绑已存在会话：归属走注册表，空白快照作废
        activateTab(group, preview.id);
        return;
      }
    }
    const tab = createTab(sessionId);
    group.tabs.push(tab);
    if (!isStarted(sessionId)) group.previewTabId = tab.id;
    activateTab(group, tab.id);
  }

  /** 新建会话（Ctrl+N / 侧栏按钮）：空白面板天然未启动，走预览语义。
   *  pendingWs = 创建时的工作区归属快照（创建时绑定），首发时种进注册表。 */
  function openBlankTab(pendingName: string, pendingWs?: TabItem["pendingWs"]) {
    const group = focusedGroup();
    const preview = group.previewTabId
      ? group.tabs.find((t) => t.id === group.previewTabId)
      : undefined;
    if (preview) {
      preview.sessionId = null;
      preview.pendingName = pendingName;
      // 复用预览 tab = 换一个空白面板：归属快照跟着换绑（无新快照则清除旧绑定）
      if (pendingWs) preview.pendingWs = pendingWs;
      else delete preview.pendingWs;
      activateTab(group, preview.id);
      return;
    }
    const tab = createTab(null, pendingName, pendingWs);
    group.tabs.push(tab);
    group.previewTabId = tab.id;
    activateTab(group, tab.id);
  }

  /** hero 归属选择改写空白 tab 的归属快照。已启动（sessionId 非空）禁止——归属
   *  已种进注册表，改 pendingWs 是无效动作。选归属不切工作区。 */
  function setTabPendingWs(tabId: string, ws: TabItem["pendingWs"]) {
    const hit = findTabById(layout.root, tabId);
    if (!hit || hit.tab.sessionId) return;
    hit.tab.pendingWs = ws;
  }

  /** hero（零 tab）归属：作用于紧随其后的第一个新会话；openBlankTab 消费后由
   *  调用方 setDefaultWs(null) 清除。 */
  function setDefaultWs(ws: TabItem["pendingWs"] | null) {
    layout.defaultWs = ws ?? null;
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
    // 空根组（欢迎态）上没有可分的内容：退化为直接开进空组
    if (focusedGroup().tabs.length === 0) {
      openSession(sessionId);
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
    // 空根组（欢迎态）上没有可拆的内容
    const target = findGroup(layout.root, groupId ?? layout.focusedGroupId);
    if (!target || target.tabs.length === 0) return;
    const res = splitGroup(layout.root, target.id, direction, true);
    if (!res) return;
    commitRoot(res.root);
    layout.focusedGroupId = res.newGroup.id;
  }

  /** 关闭 tab：会话存活时先停止进程再移除布局（"关闭即停止"合并语义）。
   *  async 以 await stopSessionById——stop_chat_session 只是往 sidecar stdin 写一行
   *  命令即返回（毫秒级，不等 worker 退出），所以 await 几乎无成本，且能确认命令送达
   *  才移除 tab。已停止 / 空白 tab 跳过停止，直接移除。所有关闭入口（X / 中键 / 右键
   *  "关闭" / Ctrl+W / "关闭其他"）都走这里，单点一致。 */
  async function closeTab(groupId: string, tabId: string) {
    const group = findGroup(layout.root, groupId);
    const tab = group?.tabs.find((t) => t.id === tabId);
    const sid = tab?.sessionId;
    if (sid && (sessionState[sid] ?? "stopped") !== "stopped") {
      await stopSessionById(sid);
    }
    commitRoot(removeTab(layout.root, groupId, tabId));
  }

  /** 关闭聚焦组的激活 tab（Ctrl+W）。fire-and-forget：closeTab 内部仍完整执行
   *  await stop → remove，键盘快捷键语义与点 X 一致。 */
  function closeActiveTab() {
    const group = focusedGroup();
    if (group.activeTabId) void closeTab(group.id, group.activeTabId);
  }

  /** 关闭其他 tab：对每个非激活 tab 串行 closeTab（各自"存活则先停"），再固定激活 tab。
   *  串行而非并行：3-5 个 tab 各一次 stdin 写入（十几毫秒），顺序确定、可控。 */
  async function closeOtherTabs(groupId: string, tabId: string) {
    const group = findGroup(layout.root, groupId);
    if (!group || !group.tabs.some((t) => t.id === tabId)) return;
    const toClose = group.tabs.filter((t) => t.id !== tabId);
    for (const t of toClose) {
      await closeTab(group.id, t.id);
    }
    group.activeTabId = tabId;
    if (group.previewTabId !== tabId) group.previewTabId = null;
  }

  /** 会话被删除（侧栏删除动作）：关掉对应 tab。删除流程已先 stopChatSession，
   *  这里走 closeTab 时 sessionState 已 stopped → 跳过 stopSessionById，直接移除
   *  （幂等）。fire-and-forget。 */
  function closeSessionTab(sessionId: string) {
    const hit = findTabBySession(layout.root, sessionId);
    if (hit) void closeTab(hit.group.id, hit.tab.id);
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
    if (hit) {
      hit.tab.sessionId = sessionId;
      delete hit.tab.pendingWs; // 归属已种进注册表（sendMessage seed），tab 不留冗余
    }
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

  /** 整体重置为空根组（工作区无快照可恢复时 → 零会话欢迎态）。 */
  function reset() {
    const s = emptyState();
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
    /** 是否一个 tab 都没有（零会话欢迎态）——此时欢迎页本身就是新建会话页，
     *  「新建会话」动作（Ctrl+N / 侧栏 +）应 no-op，不再开冗余空白 tab */
    hasAnyTab: computed(() => listGroups(layout.root).some((g) => g.tabs.length > 0)),
    openSession,
    openBlankTab,
    setTabPendingWs,
    setDefaultWs,
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
  const s = emptyState();
  layout.root = s.root;
  layout.focusedGroupId = s.focusedGroupId;
  layout.defaultWs = null;
  isStarted = startedProbe ?? defaultIsStarted;
  mru.length = 0;
  mruFrozen = false;
  mruWalk = null;
}
