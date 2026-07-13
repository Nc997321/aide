import { ref, computed } from "vue";

export type WbTabKind = "shell" | "run";

export interface WbTabInfo {
  id: string;
  label: string;
  shellName: string;
  exited: boolean;
  kind: WbTabKind;
}

interface WorkspaceGroup {
  tabs: WbTabInfo[];
  activeId: string;
}

// 模块级单例状态：工作空间 -> 终端分组
const groups = new Map<string, WorkspaceGroup>();
const activeWorkspaceKeyRef = ref<string>("");
let wbCounter = 0;

// 版本戳：groups Map 不是 reactive，每次变更时 bump 让 computed 重新求值
const _wbVersion = ref(0);

export function resetWorkbenchState(): void {
  groups.clear();
  activeWorkspaceKeyRef.value = "";
  wbCounter = 0;
  _wbVersion.value++;
}

export function setActiveWorkspace(key: string): void {
  activeWorkspaceKeyRef.value = key;
}

/** 读取当前激活工作空间 key（DOM 层判断显示哪组用）。 */
export function activeWorkspaceKey(): string {
  return activeWorkspaceKeyRef.value;
}

/** 生成带工作空间归属的全局唯一 session_id（不复用序号）。 */
export function genSessionId(workspaceKey: string): string {
  return `__wb_${workspaceKey}__${wbCounter++}`;
}

function ensureGroup(key: string): WorkspaceGroup {
  let g = groups.get(key);
  if (!g) {
    g = { tabs: [], activeId: "" };
    groups.set(key, g);
  }
  return g;
}

/** 把 tab 加入指定工作空间分组并设为该组激活 tab。 */
export function addTab(workspaceKey: string, tab: WbTabInfo): void {
  const g = ensureGroup(workspaceKey);
  g.tabs.push(tab);
  g.activeId = tab.id;
  _wbVersion.value++;
}

/** 删除 tab；若删的是激活 tab，回退到组内最后一个；组空则删组。返回所属工作空间或 null。 */
export function removeTab(sessionId: string): { workspaceKey: string } | null {
  for (const [wk, g] of groups) {
    const idx = g.tabs.findIndex(t => t.id === sessionId);
    if (idx >= 0) {
      g.tabs.splice(idx, 1);
      if (g.activeId === sessionId) {
        g.activeId = g.tabs.length ? g.tabs[g.tabs.length - 1].id : "";
      }
      if (g.tabs.length === 0) groups.delete(wk);
      _wbVersion.value++;
      return { workspaceKey: wk };
    }
  }
  return null;
}

/** 标记 tab 已退出（pty-exit 用）。找不到返回 false。 */
export function markExited(sessionId: string): boolean {
  for (const g of groups.values()) {
    const t = g.tabs.find(t => t.id === sessionId);
    if (t) {
      t.exited = true;
      _wbVersion.value++;
      return true;
    }
  }
  return false;
}

export function hasTabs(key: string): boolean {
  return !!groups.get(key)?.tabs.length;
}

export function workspaceKeyOf(sessionId: string): string | null {
  for (const [wk, g] of groups) {
    if (g.tabs.some(t => t.id === sessionId)) return wk;
  }
  return null;
}

export function allSessionIds(): string[] {
  const out: string[] = [];
  for (const g of groups.values()) for (const t of g.tabs) out.push(t.id);
  return out;
}

/** 删除整个工作空间分组，返回被移除的 session id 列表（供调用方 kill PTY）。 */
export function killWorkspace(key: string): string[] {
  const g = groups.get(key);
  if (!g) return [];
  const ids = g.tabs.map(t => t.id);
  groups.delete(key);
  _wbVersion.value++;
  return ids;
}

/** 切换某工作空间组内的激活 tab（点击 tab 时用）。 */
export function setActiveTab(workspaceKey: string, id: string): void {
  const g = groups.get(workspaceKey);
  if (g && g.tabs.some(t => t.id === id)) { g.activeId = id; _wbVersion.value++; }
}

/** 更新某 tab 的 shellName（spawn 成功后用）。找不到则无操作。 */
export function setShellName(sessionId: string, shellName: string): void {
  for (const g of groups.values()) {
    const t = g.tabs.find(t => t.id === sessionId);
    if (t) { t.shellName = shellName; _wbVersion.value++; return; }
  }
}

/** 复位某 tab 的 exited 标记（run 重启 / shell 重启用）。找不到则无操作。 */
export function clearExited(sessionId: string): void {
  for (const g of groups.values()) {
    const t = g.tabs.find(t => t.id === sessionId);
    if (t) { t.exited = false; _wbVersion.value++; return; }
  }
}

// 派生（给 UI）：只反映当前激活工作空间
// 读 _wbVersion 让 computed 在 groups Map 变更时重新求值
export const tabs = computed<WbTabInfo[]>(() => { void _wbVersion.value; return groups.get(activeWorkspaceKeyRef.value)?.tabs ?? []; });
export const activeId = computed<string>(() => { void _wbVersion.value; return groups.get(activeWorkspaceKeyRef.value)?.activeId ?? ""; });
export const activeExited = computed<boolean>(() => {
  void _wbVersion.value;
  const g = groups.get(activeWorkspaceKeyRef.value);
  if (!g) return false;
  return g.tabs.find(t => t.id === g.activeId)?.exited ?? false;
});
