# 每工作空间独立终端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个工作空间拥有独立、互相隔离的终端组（多 tab、keep-alive、默认不启动），切换工作空间不再 `cd` 同一个 shell；并让终端面板宽度跟随对话框宽度。

**Architecture:** 把终端的"工作空间分组 / 激活 tab / session_id 生成 / pty-exit 路由"抽成一个**纯逻辑、无 DOM、可在 node 环境单测**的状态核心 `workbenchTerminalState.ts`；现有 `useWorkbenchTerminal.ts` 退化为只管 xterm/div/轮询/spawn 的 DOM 层，向核心查/改 tab 元数据。Rust 端零改动（`ShellManager` 已是 `HashMap<session_id, ShellSession>` 多实例）。切换工作空间只换 `activeWorkspaceKey` 并切换显示哪组 div，不碰任何 PTY、不发 `cd`。run config 的 session_id 仍是 Rust 生成的 `run__{config_id}`，前端在 attach 时把它归档进当前工作空间分组。

**Tech Stack:** Vue 3 Composition API + TypeScript、xterm.js 5、Tauri v2 IPC、vitest（`environment: node`，无 jsdom——所以 DOM/xterm 相关逻辑不写单测，纯状态核心可测）。

## Global Constraints

- 跨平台：不硬编码 `\\`，路径用 `path`/字符串拼接；无平台特有逻辑新增。
- 主题：所有颜色/边框/圆角用 `var(--aide-*)`，禁止硬编码 hex（见 CLAUDE.md 主题系统约定）。
- 禁止原生 `title=`/`alert/confirm/prompt`：hover 提示用 `v-tooltip`，弹窗用 `useModal`。
- 非 scoped 样式：xterm 动态 DOM 的样式放非 scoped `<style>` 块。
- 终端样式三角箭头统一 `font-size: 14px`（项目约定，本计划新增样式遵循）。
- vitest 跑在 node 环境，测试不能依赖 `document`/`window`/xterm。
- 单一 100ms 轮询循环保留（CLAUDE.md 红线：事件出口过 delta 合并层、单一轮询）。

## Spec 解析（相对 spec 的一处澄清）

spec 同时写了"Rust 零改动"和"run session_id 改成 `run__{workspaceKey}__{config_id}`"——但 `run__{config_id}` 是 `src-tauri/src/commands/run_process.rs:5` 的 `run_session_id()` 在 Rust 端生成的。二者冲突。本计划取**Rust 零改动**：run session_id 保持 `run__{config_id}`，前端在 `attachSession` 时把它归档进当前激活工作空间分组（核心里记 `kind: "run"`）。这样 Rust 完全不动，隔离仍彻底（切走看不到别的工作空间的 run tab）。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/composables/workbenchTerminalState.ts` | 纯逻辑核心：工作空间分组、tab 元数据、session_id 生成、激活 tab、pty-exit 路由、批量清理。无 DOM/xterm/Vue 副作用外的依赖（只用 `ref`/`computed`）。可单测。 | 新建 |
| `src/composables/workbenchTerminalState.test.ts` | 核心的 vitest 单测 | 新建 |
| `src/composables/useWorkbenchTerminal.ts` | DOM 层：xterm/div/observer/轮询/spawn/attach/显示切换。向核心查改 tab。删除 `changeCwd`。 | 改 |
| `src/composables/useChatPaneWidth.ts` | 单例：暴露响应式 `chatPaneWidth`（聚焦对话框的宽度）。供终端面板绑定宽度。 | 新建 |
| `src/components/WorkbenchTerminal.vue` | 空状态 UI + "新建终端"按钮；删 cwd watch/changeCwd；pill 宽度绑 `chatPaneWidth`；exited 覆盖层仅对 shell tab。 | 改 |
| `src/components/ChatPanel.vue` | 加 `focused` prop，用 ResizeObserver 把自身宽度上报到 `useChatPaneWidth`（仅聚焦时上报）。 | 改 |
| `src/components/panelayout/PaneGroup.vue` | 向 `<ChatPanel>` 传 `:focused="focused"`。 | 改 |
| `src/composables/useRunProcess.ts` | `attachSession` 调用带当前 `activeWorkspaceKey`；run tab 归档进当前工作空间（核心记 `kind:"run"`）。 | 改 |
| `src/App.vue` | watch `useWorkspaces().activeKey` → `setActiveWorkspace`；删除 `changeCwd` 相关；`removeWorkspace` 时 kill 该工作空间 PTY；卸载时 dispose 全部。 | 改 |
| `src-tauri/**` | **零改动**。 | 不动 |

---

## Task 1: 纯状态核心 `workbenchTerminalState.ts`

**Files:**
- Create: `src/composables/workbenchTerminalState.ts`
- Test: `src/composables/workbenchTerminalState.test.ts`

**Interfaces:**
- Produces: `WbTabInfo`（`{id,label,shellName,exited,kind:"shell"|"run"}`）、`setActiveWorkspace(key)`、`genSessionId(workspaceKey)`、`addTab(workspaceKey, tab)`、`removeTab(sessionId) → {workspaceKey}|null`、`markExited(sessionId) → boolean`、`tabs`/`activeId`/`activeExited`（computed）、`hasTabs(key)`、`workspaceKeyOf(sessionId)`、`allSessionIds()`、`killWorkspace(key) → string[]`、`resetWorkbenchState()`。后续任务消费这些签名。

- [ ] **Step 1: 写失败测试（覆盖核心行为）**

Create `src/composables/workbenchTerminalState.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  resetWorkbenchState,
  setActiveWorkspace,
  genSessionId,
  addTab,
  removeTab,
  markExited,
  hasTabs,
  workspaceKeyOf,
  allSessionIds,
  killWorkspace,
  tabs,
  activeId,
} from "./workbenchTerminalState";

describe("workbenchTerminalState", () => {
  beforeEach(() => resetWorkbenchState());

  it("genSessionId 带工作空间归属且全局自增不复用", () => {
    const a1 = genSessionId("WS_A");
    const a2 = genSessionId("WS_A");
    const b1 = genSessionId("WS_B");
    expect(a1).toBe("__wb_WS_A__0");
    expect(a2).toBe("__wb_WS_A__1");
    expect(b1).toBe("__wb_WS_B__2");
  });

  it("addTab 进对应工作空间分组并设为该组激活 tab；tabs/activeId 只反映当前工作空间", () => {
    setActiveWorkspace("WS_A");
    addTab("WS_A", { id: genSessionId("WS_A"), label: "1", shellName: "bash", exited: false, kind: "shell" });
    addTab("WS_A", { id: genSessionId("WS_A"), label: "2", shellName: "bash", exited: false, kind: "shell" });
    expect(tabs.value.map(t => t.label)).toEqual(["1", "2"]);
    expect(activeId.value).toBe("__wb_WS_A__1");

    // 切到 B：A 的 tab 不可见，B 为空
    setActiveWorkspace("WS_B");
    expect(tabs.value).toEqual([]);
    expect(activeId.value).toBe("");

    // 切回 A：仍是 A 的第二个 tab 激活
    setActiveWorkspace("WS_A");
    expect(activeId.value).toBe("__wb_WS_A__1");
  });

  it("removeTab 删对应 tab，激活回退到最后一个；组空则删组", () => {
    const t1 = genSessionId("WS_A");
    const t2 = genSessionId("WS_A");
    addTab("WS_A", { id: t1, label: "1", shellName: "bash", exited: false, kind: "shell" });
    addTab("WS_A", { id: t2, label: "2", shellName: "bash", exited: false, kind: "shell" });
    setActiveWorkspace("WS_A");

    expect(removeTab(t2)).toEqual({ workspaceKey: "WS_A" });
    expect(activeId.value).toBe(t1);

    expect(removeTab(t1)).toEqual({ workspaceKey: "WS_A" });
    expect(hasTabs("WS_A")).toBe(false);
    expect(activeId.value).toBe("");
  });

  it("removeTab 找不到返回 null", () => {
    expect(removeTab("nope")).toBeNull();
  });

  it("markExited 只标对应 tab，不影响其它", () => {
    const t1 = genSessionId("WS_A");
    const t2 = genSessionId("WS_A");
    addTab("WS_A", { id: t1, label: "1", shellName: "bash", exited: false, kind: "shell" });
    addTab("WS_A", { id: t2, label: "2", shellName: "bash", exited: false, kind: "shell" });
    expect(markExited(t1)).toBe(true);
    expect(markExited("nope")).toBe(false);
    setActiveWorkspace("WS_A");
    expect(tabs.value.find(t => t.id === t1)?.exited).toBe(true);
    expect(tabs.value.find(t => t.id === t2)?.exited).toBe(false);
  });

  it("workspaceKeyOf / allSessionIds 跨工作空间查找", () => {
    const a = genSessionId("WS_A");
    const b = genSessionId("WS_B");
    addTab("WS_A", { id: a, label: "1", shellName: "", exited: false, kind: "shell" });
    addTab("WS_B", { id: b, label: "1", shellName: "", exited: false, kind: "run" });
    expect(workspaceKeyOf(a)).toBe("WS_A");
    expect(workspaceKeyOf(b)).toBe("WS_B");
    expect(allSessionIds().sort()).toEqual([a, b].sort());
  });

  it("killWorkspace 返回该组所有 session id 并清组", () => {
    const a1 = genSessionId("WS_A");
    const a2 = genSessionId("WS_A");
    addTab("WS_A", { id: a1, label: "1", shellName: "", exited: false, kind: "shell" });
    addTab("WS_A", { id: a2, label: "2", shellName: "", exited: false, kind: "shell" });
    const killed = killWorkspace("WS_A").sort();
    expect(killed).toEqual([a1, a2].sort());
    expect(hasTabs("WS_A")).toBe(false);
  });

  it("run tab 与 shell tab 同组共存，kind 区分", () => {
    const s = genSessionId("WS_A");
    addTab("WS_A", { id: s, label: "dev", shellName: "", exited: false, kind: "run" });
    setActiveWorkspace("WS_A");
    expect(tabs.value[0].kind).toBe("run");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/composables/workbenchTerminalState.test.ts`
Expected: FAIL（模块不存在，导入报错）

- [ ] **Step 3: 写核心实现**

Create `src/composables/workbenchTerminalState.ts`:

```typescript
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

export function resetWorkbenchState(): void {
  groups.clear();
  activeWorkspaceKeyRef.value = "";
  wbCounter = 0;
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
  return ids;
}

/** 切换某工作空间组内的激活 tab（点击 tab 时用）。 */
export function setActiveTab(workspaceKey: string, id: string): void {
  const g = groups.get(workspaceKey);
  if (g && g.tabs.some(t => t.id === id)) g.activeId = id;
}

/** 复位某 tab 的 exited 标记（run 重启 / shell 重启用）。找不到则无操作。 */
export function clearExited(sessionId: string): void {
  for (const g of groups.values()) {
    const t = g.tabs.find(t => t.id === sessionId);
    if (t) { t.exited = false; return; }
  }
}

// 派生（给 UI）：只反映当前激活工作空间
export const tabs = computed<WbTabInfo[]>(() => groups.get(activeWorkspaceKeyRef.value)?.tabs ?? []);
export const activeId = computed<string>(() => groups.get(activeWorkspaceKeyRef.value)?.activeId ?? "");
export const activeExited = computed<boolean>(() => {
  const g = groups.get(activeWorkspaceKeyRef.value);
  if (!g) return false;
  return g.tabs.find(t => t.id === g.activeId)?.exited ?? false;
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/composables/workbenchTerminalState.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `pnpm test`
Expected: PASS（既有用例不受影响；新核心用例通过）

- [ ] **Step 6: 提交**

```bash
git add src/composables/workbenchTerminalState.ts src/composables/workbenchTerminalState.test.ts
git commit -m "feat(workbench): add pure state core for per-workspace terminal grouping"
```

---

## Task 2: 重构 `useWorkbenchTerminal.ts` 为 DOM 层 + 接入核心

**Files:**
- Modify: `src/composables/useWorkbenchTerminal.ts`
- Modify: `src/App.vue`（仅 watch activeKey → setActiveWorkspace，与本任务配套验证）

**Interfaces:**
- Consumes: Task 1 的核心 API（`setActiveWorkspace`/`genSessionId`/`addTab`/`removeTab`/`markExited`/`tabs`/`activeId`/`activeExited`/`killWorkspace`/`allSessionIds`）。
- Produces: `useWorkbenchTerminal()` 返回 `{ visible, tabs, activeId, activeExited, init, createSession, attachSession(workspaceKey,id,label,clearFirst), switchTo, closeSession, show, hide, toggle, clear, restart, dispose, setActiveWorkspace }`。删除 `changeCwd`。`attachSession` 签名变为 `(workspaceKey, id, label, clearFirst?)`。

- [ ] **Step 1: 改导入与模块状态**

Modify `src/composables/useWorkbenchTerminal.ts` 顶部（替换第 10-37 行的扁平状态）：

```typescript
import { ref, watch, computed, nextTick } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api } from "../api";
import { useSettings } from "./useSettings";
import { buildXtermTheme } from "../utils/xterm";
import { themes } from "../themes";
import {
  setActiveWorkspace as coreSetActiveWorkspace,
  activeWorkspaceKey,
  genSessionId,
  addTab,
  removeTab,
  markExited,
  clearExited,
  killWorkspace,
  allSessionIds,
  workspaceKeyOf,
  setActiveTab,
  tabs as coreTabs,
  activeId as coreActiveId,
  activeExited as coreActiveExited,
  type WbTabKind,
} from "./workbenchTerminalState";

// 仅保留 xterm/div 物理对象；tab 元数据/分组/激活全在核心
interface WbSession {
  id: string;
  workspaceKey: string;   // 冗余存一份，便于 display 判断 & dispose
  kind: WbTabKind;
  terminal: Terminal;
  fitAddon: FitAddon;
  div: HTMLDivElement;
  observer: ResizeObserver;
  spawned: boolean;
}

const sessions = new Map<string, WbSession>();   // sessionId -> xterm/div
const visible = ref(false);
let containerEl: HTMLDivElement | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unlistenExit: UnlistenFn | null = null;
```

删除原 `WbTab` 接口导出（UI 改用核心的 `WbTabInfo`，Task 4 处理）。删除原 `tabs`/`activeId`/`nextIdx` 模块变量。

- [ ] **Step 2: 改 settings watcher / polling / exit listener 遍历 sessions（不变路径，只是 sessions 含义已改）**

`ensureSettingsWatchers`、`ensurePolling`、`ensureExitListener` 三处 `for (const [, s] of sessions)` 遍历保持不变——sessions 现在是物理对象 map，遍历它给所有 xterm 写数据/设主题，正是 keep-alive 要的（切走的工作空间也照常轮询写输出）。

`ensureExitListener` 改成用核心路由（替换第 106-119 行）：

```typescript
function ensureExitListener() {
  if (unlistenExit) return;
  listen<string>("pty-exit", (event) => {
    try {
      const p = JSON.parse(event.payload) as { session_id: string };
      // 物理对象：标记并清理 DOM
      const s = sessions.get(p.session_id);
      if (s) {
        s.spawned = false;
        // run tab 的 DOM 也保留到关闭按钮触发；shell 标 exited 让 UI 显示覆盖层
      }
      // 元数据：标 exited（核心 tabs 反映）
      markExited(p.session_id);
    } catch (_) { /* ignore */ }
  }).then((fn) => { unlistenExit = fn; });
}
```

删除原 `syncTabs()`（核心 `tabs` computed 直接反映，无需手动同步）。

- [ ] **Step 3: 重写 `createSession`（签名 + session_id + 入核心）**

替换第 133-185 行：

```typescript
function createSession(workspaceKey: string, cwd: string, initialCommand?: string): string {
  if (!containerEl) return "";
  const id = genSessionId(workspaceKey);
  const stg = settingsRef!;

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: stg.fontSize,
    fontFamily: stg.fontFamily,
    theme: buildXtermTheme(themes[stg.theme || "warm-dark"]),
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const div = document.createElement("div");
  div.className = "wb-term-pane";
  div.style.display = "none";
  containerEl.appendChild(div);
  div.style.display = "";
  terminal.open(div);
  fitAddon.fit();

  terminal.onData((data) => { api.ptyWrite(id, data).catch(() => {}); });
  const observer = new ResizeObserver(() => {
    fitAddon.fit();
    api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {});
  });
  observer.observe(div);

  const session: WbSession = { id, workspaceKey, kind: "shell", terminal, fitAddon, div, observer, spawned: false };
  sessions.set(id, session);
  addTab(workspaceKey, { id, label: initialCommand || "", shellName: "", exited: false, kind: "shell" });
  switchTo(id);
  spawnShell(id, cwd, initialCommand);
  ensurePolling();
  ensureExitListener();
  return id;
}
```

- [ ] **Step 4: 重写 `switchTo`（按工作空间 + 激活 tab 双层判断）**

替换第 187-196 行。核心已在 Task 1 导出 `setActiveTab`/`activeWorkspaceKey`，直接用：

```typescript
function switchTo(id: string) {
  for (const [, s] of sessions) s.div.style.display = "none";
  const wk = workspaceKeyOf(id);
  if (wk) setActiveTab(wk, id);
  const s = sessions.get(id);
  if (s && wk === activeWorkspaceKey() && visible.value) {
    s.div.style.display = "";
    s.fitAddon.fit();
    s.terminal.focus();
  }
}
```

> 语义：先把所有 pane 隐藏；把核心里该 session 所属组的激活 tab 设为 id；仅当该 session 属于当前激活工作空间**且**面板可见时才显示它并 fit/focus。切到非当前工作空间的 tab 不会显示（但核心 activeId 已更新，切回该工作空间时它就是激活的）。

- [ ] **Step 5: 重写 `closeSession`（用核心 removeTab）**

替换第 198-218 行：

```typescript
function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  const wk = s.workspaceKey;            // 先存，removeTab 后 workspaceKeyOf 查不到
  api.ptyKill(id).catch(() => {});
  s.observer.disconnect();
  s.terminal.dispose();
  s.div.remove();
  sessions.delete(id);
  removeTab(id);
  // 若删的是当前激活工作空间的 tab，切到该组剩下的最后一个（核心已回退 activeId；同步显示）
  const newActive = coreActiveId.value;
  if (newActive && wk === activeWorkspaceKey()) switchTo(newActive);
  if (allSessionIds().length === 0) {
    stopPolling();
    visible.value = false;
  }
}
```

- [ ] **Step 6: 重写 `attachSession`（签名加 workspaceKey，run tab 入核心）**

替换第 243-309 行。新签名 `attachSession(workspaceKey, id, label, clearFirst?)`：

```typescript
function attachSession(workspaceKey: string, id: string, label: string, clearFirst = false): void {
  ensureSettingsWatchers();
  const existing = sessions.get(id);
  if (existing) {
    existing.spawned = true;
    clearExited(id); // run 重启时把 exited 复位（核心已导出 clearExited）
    if (clearFirst) existing.terminal.clear();
    setActiveTab(workspaceKey, id);
    switchTo(id);
    ensurePolling();
    return;
  }
  if (!containerEl) return;
  const stg = settingsRef!;
  const terminal = new Terminal({
    cursorBlink: true, fontSize: stg.fontSize, fontFamily: stg.fontFamily,
    theme: buildXtermTheme(themes[stg.theme || "warm-dark"]), allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const div = document.createElement("div");
  div.className = "wb-term-pane";
  containerEl.appendChild(div);
  div.style.display = "";
  terminal.open(div);
  fitAddon.fit();
  terminal.onData((data) => { api.ptyWrite(id, data).catch(() => {}); });
  const observer = new ResizeObserver(() => {
    fitAddon.fit(); api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {});
  });
  observer.observe(div);
  const session: WbSession = { id, workspaceKey, kind: "run", terminal, fitAddon, div, observer, spawned: true };
  sessions.set(id, session);
  addTab(workspaceKey, { id, label, shellName: "", exited: false, kind: "run" });
  switchTo(id);
  ensurePolling();
  ensureExitListener();
  nextTick(() => { api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {}); });
}
```

> 核心已在 Task 1 导出 `setActiveTab` 和 `clearExited`，DOM 层直接 import 使用，无需再改核心。

- [ ] **Step 7: 删 `changeCwd`，重写 `show`/`toggle`（不再自动 createSession）**

替换第 311-337 行。`show`/`toggle` 不再自动起终端（"默认不启动"）；空状态由 UI 处理：

```typescript
function changeCwdRemoved() {} // 占位删除：下面整段替换

async function show() {
  visible.value = true;
  ensurePolling();
  setTimeout(() => {
    const s = sessions.get(coreActiveId.value);
    if (s) { s.fitAddon.fit(); s.terminal.focus(); }
  }, 200);
}

function hide() { visible.value = false; }

function toggle() {
  if (visible.value) hide();
  else show();
}
```

删除原 `changeCwd` 整个函数。

- [ ] **Step 8: 重写 `restart`（只对 shell；run 走 useRunProcess）**

替换第 344-351 行：

```typescript
async function restart(id: string, cwd: string) {
  const s = sessions.get(id);
  if (!s || s.kind !== "shell") return;   // run tab 不在此重启
  clearExited(id);
  await spawnShell(id, cwd);
  s.terminal.focus();
}
```

- [ ] **Step 9: 重写 `dispose`（遍历所有 session kill）**

替换第 353-367 行：

```typescript
function dispose() {
  stopPolling();
  unlistenExit?.();
  unlistenExit = null;
  for (const [id, s] of sessions) {
    api.ptyKill(id).catch(() => {});
    s.observer.disconnect();
    s.terminal.dispose();
    s.div.remove();
  }
  sessions.clear();
  resetWorkbenchState();
  containerEl = null;
}
```

import `resetWorkbenchState` from 核心。

- [ ] **Step 10: 补 `killWorkspaceTerminals` 导出（删除工作空间时用）**

在 `useWorkbenchTerminal` 内加并导出：

```typescript
function killWorkspaceTerminals(workspaceKey: string) {
  const ids = killWorkspace(workspaceKey); // 核心返回待 kill 的 id
  for (const id of ids) {
    const s = sessions.get(id);
    if (s) {
      api.ptyKill(id).catch(() => {});
      s.observer.disconnect();
      s.terminal.dispose();
      s.div.remove();
      sessions.delete(id);
    }
  }
}
```

- [ ] **Step 11: 改返回对象**

替换第 369-387 行返回：

```typescript
return {
  visible,
  tabs: coreTabs,
  activeId: coreActiveId,
  activeExited: coreActiveExited,
  init,
  createSession,
  attachSession,
  switchTo,
  closeSession,
  show,
  hide,
  toggle,
  clear,
  restart,
  dispose,
  killWorkspaceTerminals,
  setActiveWorkspace: coreSetActiveWorkspace,
};
```

删除返回里的 `changeCwd`。

- [ ] **Step 12: 类型检查**

Run: `pnpm vue-tsc --noEmit`
Expected: 无类型错误（如有，修正 import/签名）。

- [ ] **Step 13: 跑单测确认核心仍绿**

Run: `pnpm vitest run src/composables/workbenchTerminalState.test.ts`
Expected: PASS（DOM 层改动不碰核心）。

- [ ] **Step 14: 提交**

```bash
git add src/composables/useWorkbenchTerminal.ts src/composables/workbenchTerminalState.ts
git commit -m "refactor(workbench): per-workspace terminal DOM layer using pure state core"
```

---

## Task 3: `useChatPaneWidth` + ChatPanel/PaneGroup 宽度上报

**Files:**
- Create: `src/composables/useChatPaneWidth.ts`
- Modify: `src/components/ChatPanel.vue`
- Modify: `src/components/panelayout/PaneGroup.vue`

**Interfaces:**
- Produces: `useChatPaneWidth()` 返回 `{ chatPaneWidth }`（`ref<number>`，0=未测得）。ChatPanel 接收新 prop `focused: boolean`。

- [ ] **Step 1: 写宽度单例**

Create `src/composables/useChatPaneWidth.ts`:

```typescript
import { ref } from "vue";

// 模块级单例：聚焦对话框（chat pane）的实时宽度（px）。终端面板绑定它。
// 0 = 尚未测得（终端面板在拿到值前用兜底宽度）。
const chatPaneWidth = ref(0);

export function useChatPaneWidth() {
  return { chatPaneWidth };
}

/** 供聚焦的 ChatPanel ResizeObserver 上报自身宽度。仅聚焦组应调用。 */
export function setChatPaneWidth(px: number): void {
  if (px > 0) chatPaneWidth.value = px;
}
```

- [ ] **Step 2: ChatPanel 加 focused prop + ResizeObserver**

Modify `src/components/ChatPanel.vue`：

在 `defineProps`（第 23 行起）的 props 对象里加 `focused: boolean`（默认 false）：

```typescript
const props = defineProps<{
  // ...既有字段...
  focused?: boolean;
}>();
```

在 `<script setup>` 顶部 import 区加：

```typescript
import { ref as vueRef, onMounted, onUnmounted, watch as vueWatch } from "vue";
import { setChatPaneWidth } from "../composables/useChatPaneWidth";
```

（若已 import `ref`/`onMounted`/`watch`，合并，勿重复 import。）

在 setup 内（紧接 props/emits 之后）加根元素 ref + observer：

```typescript
const rootEl = vueRef<HTMLElement | null>(null);
let widthObserver: ResizeObserver | null = null;

function reportWidth() {
  if (props.focused && rootEl.value) setChatPaneWidth(rootEl.value.clientWidth);
}

onMounted(() => {
  reportWidth();
  if (typeof ResizeObserver !== "undefined") {
    widthObserver = new ResizeObserver(() => reportWidth());
    if (rootEl.value) widthObserver.observe(rootEl.value);
  }
});
onUnmounted(() => { widthObserver?.disconnect(); widthObserver = null; });
vueWatch(() => props.focused, () => reportWidth());
```

在 `<template>` 根 `<div class="chat-panel">`（第 470 行）加 ref：

```html
<div ref="rootEl" class="chat-panel">
```

> 说明：多个分屏会渲染多个 ChatPanel；只有 `focused` 为真的那个上报宽度，避免互相覆盖。聚焦切换时 `watch` 触发重报。

- [ ] **Step 3: PaneGroup 传 focused**

Modify `src/components/panelayout/PaneGroup.vue` 的 `<ChatPanel>`（第 100 行起）加一行：

```html
    <ChatPanel
      :focused="focused"
      :session-id="activeTab?.sessionId ?? null"
      ...
```

（`focused` computed 已在第 25 行存在。）

- [ ] **Step 4: 类型检查**

Run: `pnpm vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useChatPaneWidth.ts src/components/ChatPanel.vue src/components/panelayout/PaneGroup.vue
git commit -m "feat(workbench): expose focused chat pane width for terminal sizing"
```

---

## Task 4: `WorkbenchTerminal.vue` — 空状态 + 删 cwd watch + 宽度绑定 + kind 感知退出层

**Files:**
- Modify: `src/components/WorkbenchTerminal.vue`
- Modify: `src/App.vue`（传入 activeWorkspaceKey + width；删除 cwd/changeCwd 相关）

**Interfaces:**
- Consumes: Task 2 的 `useWorkbenchTerminal()` 返回（无 `changeCwd`、`createSession(workspaceKey, cwd)`、`tabs`/`activeId`/`activeExited` 来自核心含 `kind`）；Task 3 的 `useChatPaneWidth().chatPaneWidth`。
- Props 改为 `{ workspaceKey: string; cwd: string; height: number }`（加 `workspaceKey`，`cwd` 仅用于 spawn/restart 的一次性目录，不再驱动 cd）。

- [ ] **Step 1: 改 props，删 cwd watch，加 workspaceKey**

Modify `src/components/WorkbenchTerminal.vue` `<script setup>`：

第 6 行 props 改为：
```typescript
const props = defineProps<{ workspaceKey: string; cwd: string; height: number }>();
const emit = defineEmits<{ "update:height": [v: number] }>();
```

删除第 20-22 行的 `watch(() => props.cwd, ...)`（changeCwd 已不存在）。

import 宽度：
```typescript
import { useChatPaneWidth } from "../composables/useChatPaneWidth";
const { chatPaneWidth } = useChatPaneWidth();
const pillWidth = computed(() => chatPaneWidth.value > 0 ? `${chatPaneWidth.value}px` : "calc(100% - 20px)");
```
（需 import `computed`，合并到顶部 vue import。）

- [ ] **Step 2: `addTerminal` 带 workspaceKey**

把第 33-35 行 `addTerminal` 改为：
```typescript
function addTerminal() {
  wb.createSession(props.workspaceKey, props.cwd);
}
```

- [ ] **Step 3: 退出层仅对 shell tab + restart 带 workspaceKey**

模板第 79-87 行 `workbench-exited` 加 `v-if` 限定 shell kind，restart 传 workspaceKey：

```html
        <div
          v-if="wb.activeExited.value && activeTabKind === 'shell'"
          class="workbench-exited"
          tabindex="0"
          @keydown.enter.prevent="wb.restart(wb.activeId.value, props.cwd)"
          @click="wb.restart(wb.activeId.value, props.cwd)"
        >
          <div class="workbench-exited__title">Shell 已退出</div>
          <div class="workbench-exited__hint">按 Enter 或点击重启</div>
        </div>
```

script 加：
```typescript
const activeTabKind = computed<"shell" | "run" | undefined>(() => {
  const t = wb.tabs.value.find(t => t.id === wb.activeId.value);
  return t?.kind;
});
```

- [ ] **Step 4: 空状态 UI**

模板：在 `<div ref="containerRef" class="wb-container">` 内、exited 层之前加空状态（当面板可见且当前工作空间无 tab）：

```html
      <div ref="containerRef" class="wb-container">
        <div
          v-if="wb.visible.value && wb.tabs.value.length === 0"
          class="wb-empty"
        >
          <div class="wb-empty__title">该工作空间还没有终端</div>
          <button class="wb-empty__btn" @click.stop="addTerminal">新建终端</button>
        </div>
        <div v-if="wb.activeExited.value && activeTabKind === 'shell'" ...>...</div>
      </div>
```

非 scoped `<style>` 块内加（沿用 `--aide-*` token，三角箭头 14px）：
```css
.wb-empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--aide-text-muted);
}
.wb-empty__title { font-size: 13px; }
.wb-empty__btn {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 6px 16px; font-size: 13px; cursor: pointer;
  transition: background 0.12s;
}
.wb-empty__btn:hover { background: var(--aide-surface-default); }
```

- [ ] **Step 5: pill 宽度绑定 chatPaneWidth**

模板第 57 行 `.workbench-pill` 的 `:style` 改为绑定宽度：
```html
    <div class="workbench-pill" :class="{ 'is-shown': wb.visible.value }" :style="{ height: props.height + 'px', width: pillWidth }">
```

> 现有 `.workbench-pill { width: calc(100% - 20px); }`（第 110 行）作为内联 style 未生效时的兜底保留；内联 `width` 优先。`chatPaneWidth` 拿到值后内联覆盖；拿不到时 `pillWidth` 本身就是 `calc(100% - 20px)`。

- [ ] **Step 6: App.vue 传 workspaceKey + 删 changeCwd 用法 + 宽度不需要额外传**

Modify `src/App.vue`：

第 725 行 `WorkbenchTerminal` 改为：
```html
      <WorkbenchTerminal :workspace-key="activeWorkspaceKey" :cwd="workspacePath" :height="workbenchHeight" @update:height="onWorkbenchHeightChange" />
```

顶部加（import useWorkspaces 已存在则复用其 `activeKey`）：
```typescript
const { activeKey: activeWorkspaceKey } = useWorkspaces();
```
（确认 `useWorkspaces` 已 import；若未 import 则 import。）

watch activeKey → 终端核心 setActiveWorkspace（在 setup 内合适位置）：
```typescript
watch(activeWorkspaceKey, (k) => {
  if (k) wb.setActiveWorkspace(k);
});
```
（初始挂载后也补一次：在 onMounted 末尾 `if (activeWorkspaceKey.value) wb.setActiveWorkspace(activeWorkspaceKey.value);`）

第 380 行 `wb.toggle(workspacePath.value)` 改为 `wb.toggle()`（toggle 不再要 cwd）。
第 666 行 `@open-workbench="wb.toggle(workspacePath)"` 改为 `@open-workbench="() => wb.toggle()"`。

- [ ] **Step 7: 类型检查 + 构建**

Run: `pnpm vue-tsc --noEmit && pnpm build`
Expected: 无错误。（如 build 慢，至少 `vue-tsc --noEmit` 通过。）

- [ ] **Step 8: 提交**

```bash
git add src/components/WorkbenchTerminal.vue src/App.vue
git commit -m "feat(workbench): per-workspace empty state, width follows chat pane, drop cd-on-switch"
```

---

## Task 5: `useRunProcess.ts` — run tab 归当前工作空间

**Files:**
- Modify: `src/composables/useRunProcess.ts`

**Interfaces:**
- Consumes: Task 2 的 `attachSession(workspaceKey, id, label, clearFirst?)`。
- 需要：当前 `activeWorkspaceKey`（从 `useWorkspaces` 取）。

- [ ] **Step 1: import activeWorkspaceKey**

Modify `src/composables/useRunProcess.ts` 顶部加：
```typescript
import { useWorkspaces } from "./useWorkspaces";
```
在 `useRunProcess()` 内加：
```typescript
const { activeKey } = useWorkspaces();
function currentWs(): string { return activeKey.value ?? ""; }
```

- [ ] **Step 2: attachSession 带 workspaceKey**

把 `start` 里第 42 行 `wb.attachSession(sessionId, config.name);` 改为：
```typescript
    wb.attachSession(currentWs(), sessionId, config.name);
```

把 `restart` 里第 63 行 `wb.attachSession(sessionId, config.name, true);` 改为：
```typescript
    wb.attachSession(currentWs(), sessionId, config.name, true);
```

> run session_id 仍是 Rust 生成的 `run__{config_id}`；前端只在 attach 时把它归档进当前激活工作空间分组。spec 解析见本计划开头。

- [ ] **Step 3: 类型检查**

Run: `pnpm vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/composables/useRunProcess.ts
git commit -m "feat(workbench): file run-config tabs under active workspace"
```

---

## Task 6: 生命周期 — 删除工作空间 kill 其 PTY + 卸载 dispose 全部

**Files:**
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: Task 2 的 `wb.killWorkspaceTerminals(workspaceKey)`、`wb.dispose()`。

- [ ] **Step 1: removeWorkspace 后 kill 该工作空间终端**

Modify `src/App.vue` 找到调用 `useWorkspaces().removeWorkspace` 的地方（侧栏事件处理）。在 remove 成功后加：
```typescript
wb.killWorkspaceTerminals(key);
```

> 具体位置：搜索 `onSidebarWsRemoved` 或 `removeWorkspace` 调用处。若 remove 是在 `SidebarLeft` emit 后 App 处理，在 App 的处理函数里、`await ...removeWorkspace(...)` 之后加 `wb.killWorkspaceTerminals(key);`。若无法定位，加一个 watch：`watch(() => workspaces.value, ...)` 不可靠——优先找到显式 remove 处理点。

- [ ] **Step 2: 卸载 dispose 全部（已有则确认范围）**

确认 `src/App.vue` `onUnmounted`/`onBeforeUnmount` 里是否已调 `wb.dispose()`；若无则加：
```typescript
onUnmounted(() => { wb.dispose(); });
```
（`wb.dispose()` 已遍历所有工作空间所有 session kill。）

- [ ] **Step 3: 类型检查**

Run: `pnpm vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/App.vue
git commit -m "feat(workbench): kill workspace PTYs on workspace removal, dispose all on unmount"
```

---

## Task 7: 手动验收

**Files:** 无（运行 `pnpm tauri dev` 验收）

- [ ] **Step 1: 启动开发环境**

Run: `pnpm tauri dev`
Expected: 应用启动，无控制台报错。

- [ ] **Step 2: 跑验收清单（spec 第「验收清单」节）**

逐项验证：
1. 两个工作空间各开终端跑不同命令，历史 / 环境 / cwd 互不串味。
2. A 工作空间跑 `npm run dev`（或任意长跑命令），切到 B 干别的，切回 A —— 进程还在、输出历史完整、滚动位置保留。
3. 全新工作空间首次打开 quake 面板（Ctrl+`）：显示空状态 + "新建终端"按钮，不占 PTY；点按钮才起 shell，cwd 默认在该工作空间路径。
4. 拖宽对话框（分屏拖拽），终端 pill 宽度同步变化；重启应用后宽度恢复（分屏尺寸已持久化）。
5. 在某工作空间跑一条 run config：run tab 出现在该工作空间分组下；切到别的工作空间看不到它，切回还在。
6. shell 里输入 `exit` 让其自然退出：该 tab 显示"Shell 已退出"覆盖层（仅 shell，run tab 不显示该层），按 Enter 重启；关闭按钮清掉 tab，工作空间变空回空状态。
7. 删除一个有终端的工作空间：其 PTY 被 kill（任务管理器/Activity Monitor 里对应 shell 进程消失）。

- [ ] **Step 3: 修复发现的问题并提交**

如有问题，修复后：
```bash
git add -A
git commit -m "fix(workbench): <具体修复>"
```

- [ ] **Step 4: 最终全量测试**

Run: `pnpm test`
Expected: 全绿。

---

## Self-Review 结果

**Spec 覆盖：** 逐条对照 spec——
- keep-alive：Task 2 轮询遍历所有 session + 切走只隐藏 div → ✅
- 多 tab / 工作空间：核心 `Map<workspaceKey, group>` + Task 2 → ✅
- 显式创建 / 空状态：Task 4 空状态 + `show` 不再自动 createSession → ✅
- run tab 归工作空间：Task 5 → ✅（spec 解析：Rust 不改，前端归档）
- 删 changeCwd：Task 2 Step 7 + Task 4 Step 1/6 → ✅
- 终端宽度跟对话框：Task 3 + Task 4 Step 5 → ✅（持久化由分屏快照负责，免费）
- 生命周期清理（应用退出 / 删工作空间）：Task 6 → ✅
- pty-exit 处理：Task 2 Step 2 + 核心 `markExited` → ✅
- Rust 零改动：✅（run session_id 保持 `run__{config_id}`）

**占位符扫描：** 无 TBD/TODO；Step 6 Task 6 Step 1 给了定位策略（优先找显式 remove 处理点）而非空泛"处理一下"。

**类型一致性：** `attachSession` 签名在 Task 2 Step 6 定义为 `(workspaceKey, id, label, clearFirst?)`，Task 5 Step 2 调用一致；`WbTabInfo.kind` 在核心定义 `"shell"|"run"`，Task 4 Step 3 的 `activeTabKind` 类型一致；`setActiveTab`/`clearExited`/`activeWorkspaceKey()` 均在 Task 1 核心导出，Task 2 直接 import 引用——一致。

**Scope：** 单一实现计划，七任务顺序依赖清晰，每个任务有独立可测交付。