# 停止会话进程功能合并到关闭 tab

- 日期：2026-08-10
- 状态：设计已确认，待出实施计划
- 相关文件：`src/components/panelayout/PaneTabBar.vue`、`src/components/panelayout/PaneGroup.vue`、`src/composables/usePaneLayout.ts`、`src/composables/useChatSession.ts`、`src/menus/contextMenus.ts`

## 背景与现状

聊天区 tab 栏（`PaneTabBar.vue`）当前有两个独立按钮：

- **per-tab 关闭按钮（X）**：长在每个 tab 上，hover 显示，`@click="emit('close', tab.id)"` → `pl.closeTab(groupId, tabId)` → `commitRoot(removeTab(...))`。**只移除布局，不停止会话进程**。
- **组级"停止会话进程"按钮**：tab 栏最右侧（`margin-left: auto`），仅在激活 tab 的会话存活（`activeLive`）时显示，`@click="emit('stop')"` → `stopSession()` → `invoke("stop_chat_session")` 杀 sidecar worker。只作用于**激活**的 tab。

三种会话相关操作的语义边界：

| 操作 | 触发位置 | 行为 | 会话进程 | 会话记录(jsonl) | 侧栏列表 |
|---|---|---|---|---|---|
| 关闭 tab | 每个 tab 的 X / 中键 / 右键"关闭" / Ctrl+W | `pl.closeTab` 只移除布局 | **保留**（后台继续跑） | 保留 | 仍可见，可再打开 |
| 停止会话进程 | tab 栏最右侧组级按钮（仅激活 tab 存活时显示） | `stopSession()` 杀 sidecar worker | **杀掉** | 保留 | 仍可见，再发消息 respawn |
| 删除会话 | 侧栏右键"删除" | 弹确认 → 杀进程 + 删 jsonl + 关 tab | 杀掉 | **删除** | 移除 |

关闭 tab 的所有入口集中度（`usePaneLayout.ts`）：

- `closeTab(groupId, tabId)` → `removeTab`（单点）。X 按钮、中键、右键"关闭"、`closeActiveTab`（Ctrl+W）、`closeSessionTab`（删除会话流程收尾）全部走它。
- `closeOtherTabs(groupId, tabId)`：直接 `group.tabs = filter(...)`，**不走 `closeTab`**。

`stop_chat_session`（`src-tauri/src/commands/chat.rs:280`）→ `send_to_runtime`（`src-tauri/src/runtime/mod.rs:346-359`）只是**往 sidecar stdin 写一行 JSON 即返回**，不等 worker 真正退出。sidecar 端 `session_stop` 同步 `worker.stop()` + `workers.delete(sid)`（`session-manager.ts:94-96`、`202-208`）。

`useChatSession.ts` 中 `stores`（174 行）、`getStore`（293 行）、`resetRuntimeState`（376 行）均为**模块级**；`setSessionState` 来自 `useSessionState`、`clearProvider` 来自 `useSessionProviders`，都是模块单例 composable。当前闭包内 `stopSession()`（1210 行）用 `sessionId.value`（激活 tab），但其核心逻辑全部是模块级、可按任意 sid 执行。

## 需求

经 brainstorming 三轮澄清确认：

1. **关闭即停止+移除**：点关闭 tab 时，该 tab 会话存活 → 先停进程再关 tab；已停止 → 只关 tab。不弹确认对话框。一个按钮、同一动作。
2. **X 不变 + 颜色强调**：关闭按钮图标始终是 X。会话存活时 hover 变危险红（`var(--aide-danger)`）+ tooltip "停止会话并关闭"；已停止时 tooltip "关闭"。颜色 + tooltip 双重提示。
3. **全部关闭入口同步**：X、中键、右键"关闭"、Ctrl+W、右键"关闭其他" 都执行"存活则先停"。`closeOtherTabs` 会一次停止所有被关 tab 的会话进程。

## 方案对比

### 方案 A（采纳）— 单点改造 `closeTab` + 模块级 `stopSessionById`

- `closeTab` 内：移除前查 `tab.sessionId`，存活则 `await stopSessionById(sid)` 再 `removeTab`。
- 从 `useChatSession.ts` 抽出**模块级** `stopSessionById(sid)`（不依赖激活 tab）。
- `closeOtherTabs` 改造成对每个被关 tab 调 `closeTab`（继承停止逻辑）。
- 移除 `PaneTabBar` 的组级"停止会话进程"按钮 + `stop` emit + `PaneGroup` 的 `@stop`。
- 优点：单点、一致、全覆盖；per-tab 停止比原"激活 tab 组级按钮"更精准（切 tab 不会误停）。
- 代价：`useChatSession` 轻微重构（抽出模块级函数）、`closeTab`/`closeOtherTabs` 改 async。

### 方案 B（不采纳）— 事件层分散处理

在 5 个关闭入口各自加"先停后关"。`closeTab` 保持"纯布局"语义。缺点：5 处分散、易漏/不一致；`closeTab` 被绕过后语义割裂。

## 设计

### 1. 架构与组件改动

**`src/composables/useChatSession.ts`**

- 新增**模块级**导出 `async function stopSessionById(sid: string)`：
  ```ts
  async function stopSessionById(sid: string) {
    const store = getStore(sid);
    try {
      await invoke("stop_chat_session", { sessionId: sid });
    } finally {
      resetRuntimeState(store);
      setSessionState(sid, "stopped");
      clearProvider(sid);
    }
  }
  ```
  复用现有模块级 `getStore` / `resetRuntimeState` 与模块单例 `setSessionState` / `clearProvider`，不依赖激活 tab。
- 现有闭包内 `stopSession()` 改为薄包装 `stopSessionById(sessionId.value)`。随 `@stop` 入口移除（见下），`PaneGroup` 不再解构 `stopSession`，该包装可一并删除。

**`src/composables/usePaneLayout.ts`**

- `closeTab` 改成 `async function closeTab(groupId, tabId)`：
  ```ts
  async function closeTab(groupId: string, tabId: string) {
    const group = findGroup(layout.root, groupId);
    const tab = group?.tabs.find(t => t.id === tabId);
    const sid = tab?.sessionId;
    if (sid && (sessionState[sid] ?? "stopped") !== "stopped") {
      await stopSessionById(sid);
    }
    commitRoot(removeTab(layout.root, groupId, tabId));
  }
  ```
  从 `useSessionState` 取 `sessionState`，从 `useChatSession` 取 `stopSessionById`（模块级导出，模块单例 composable 间 import）。
- `closeOtherTabs` 改成 `async function closeOtherTabs(groupId, tabId)`：
  ```ts
  async function closeOtherTabs(groupId: string, tabId: string) {
    const group = findGroup(layout.root, groupId);
    if (!group || !group.tabs.some(t => t.id === tabId)) return;
    const toClose = group.tabs.filter(t => t.id !== tabId);
    for (const t of toClose) {
      await closeTab(group.id, t.id);   // 串行：每个确认停止+移除后再处理下一个
    }
    group.activeTabId = tabId;
    if (group.previewTabId !== tabId) group.previewTabId = null;
  }
  ```
  串行而非 `Promise.all`：3-5 个 tab 各一次 stdin 写入（十几毫秒），顺序确定、可控。

**`src/components/panelayout/PaneTabBar.vue`**

- 删除组级 `pane-tab-stop` 按钮（106-113 行）、`stop` emit（24 行）。
- `activeLive` 重构为 per-tab 存活判定：新增 `function tabLive(tab: TabItem): boolean`，返回 `!!tab.sessionId && (sessionState[tab.sessionId] ?? "stopped") !== "stopped"`。删除原"激活 tab 存活"的 `activeLive` computed（停止按钮已移除，不再需要激活态存活判定）。
- X 按钮 `pane-tab__close` 改造：
  - `v-tooltip` 按 `tabLive(tab)` 切换文案：存活 → `"停止会话并关闭"`，已停止 → `"关闭"`。
  - 存活时加 class `pane-tab__close--live`。
  - 样式：`.pane-tab__close--live:hover { color: var(--aide-danger); }`（在现有 hover 背景上叠危险色文字）。

**`src/components/panelayout/PaneGroup.vue`**

- 删除模板里 `@stop="stopSession"`（141 行）。
- 删除 `useChatSession` 解构里的 `stopSession`（56 行，确认无其他引用后）。

**不动的部分**

- `interrupt`（中断当前轮，sidecar 存活）保留在 `ChatPanel` 输入区，不受影响。
- "删除会话"流程（`sessionMenuItems`，`contextMenus.ts:209-233`）：已先 `api.stopChatSession(id)` 再 `pane.closeSessionTab(id)`。`closeSessionTab` 走 `closeTab`，此时进程刚被 stop、`sessionState` 已 stopped → `closeTab` 跳过 `stopSessionById`，直接 `removeTab`。幂等，无重复杀。即便有极短竞态重复 invoke，sidecar `stopSession` 对不存在的 worker 是 no-op（`workers.get` 返回 undefined 即跳过）。

### 2. 数据流

**关闭运行中 tab（X 按钮）**：

```
用户点 tab 的 X（存活态，hover 红）
  → PaneTabBar emit('close', tab.id)
  → PaneGroup: pl.closeTab(group.id, tab.id)        // async
  → closeTab: tabLive(tab) === true
  → await stopSessionById(sid)                       // 等 stdin 写入（毫秒）+ finally 状态清理
      → invoke("stop_chat_session", { sessionId: sid })
      → sidecar SessionManager.stopSession: worker.stop() + workers.delete(sid)
      → finally: resetRuntimeState(store) / setSessionState(sid,"stopped") / clearProvider(sid)
  → commitRoot(removeTab(...))                       // 确认命令送达后才移除
```

**关闭已停止 / 空白 tab**：`tabLive(tab)` 为 false → 跳过 `stopSessionById` → 直接 `removeTab`。幂等。

**"关闭其他"**：对每个非激活 tab 串行 `await closeTab` → 每个存活者各自 `stopSessionById` → sidecar 按 sid 独立 stop，互不干扰；激活 tab 保留。

**Ctrl+W（`closeActiveTab`）**：调 `closeTab(group.id, group.activeTabId)`，不 await（fire-and-forget）——Promise 内部仍完整执行 `await stop → remove`，键盘快捷键语义与点 X 一致。

**关键不变量**：

- `closeTab` 改 async 后，所有调用方（事件 handler、`closeActiveTab`、`closeSessionTab`、`closeOtherTabs` 内循环）要么不关心返回值、要么 fire-and-forget——Promise 内部 `await stop → remove` 顺序始终成立。
- `sessionState` 由 `setSessionState` 更新，`AStatusDot`（tab 上/侧栏的状态点）在停止瞬间从"运行/等待"转"已停止"。

### 3. 错误处理

| 情况 | 处理 |
|---|---|
| `stop_chat_session` invoke 抛错（进程已死 / 通信瞬断 / 管道断） | `stopSessionById` try/finally——finally 仍 `resetRuntimeState` + `setSessionState("stopped")` + `clearProvider`，**不抛出**。`closeTab` 的 `await` 正常 resolve，继续 `removeTab`。tab 照常移除，不阻塞 UI。 |
| tab 无 `sessionId`（空白预览 tab） | `tabLive` 直接 false → 纯移除，不调 stop。 |
| "关闭其他"中某个 stop 失败 | 各自独立 try/finally，互不影响；失败的会话状态仍被置 stopped（前端兜底），下次发消息 respawn。 |
| 重复停止（删除会话流程已 stop，`closeSessionTab` 再走 `closeTab`） | `tabLive` 已 false → 跳过。极短竞态下重复 invoke，sidecar `stopSession` 对不存在 worker 是 no-op，幂等。 |

### 4. 测试

**单元测试**（`useChatSession.test.ts` / `usePaneLayout.test.ts` 已存在，扩展）：

1. `stopSessionById(sid)`：mock `invoke` → 断言调用 `stop_chat_session` 且 sid 正确；`await` 后 `sessionState[sid] === "stopped"`、store 被 `resetRuntimeState`（isBusy=false 等）、provider 清除。invoke reject 时仍执行 finally、不抛出。
2. `closeTab` 存活 tab：mock `sessionState[sid]="running"` → 断言调了 `stopSessionById` 且后续 `removeTab`。
3. `closeTab` 已停止 / 空白 tab：断言**不**调 `stopSessionById`，只移除。
4. `closeOtherTabs`：3 个 tab（2 存活 1 停止）→ 断言对 2 个存活者各调一次 `stopSessionById`、停止者不调；激活 tab 保留。

**组件测试**（`PaneTabBar` 已有测试范式，扩展）：

5. 存活 tab 的 X 按钮：`v-tooltip` 文案 = "停止会话并关闭"，带 `pane-tab__close--live` class。
6. 已停止 tab 的 X 按钮：tooltip = "关闭"，无 live class。
7. 组级"停止会话进程"按钮已**不存在**（断言 DOM 无 `.pane-tab-stop`），`stop` 事件不再被触发。

**手测验收**：

8. 跑一个会话（busy 中）→ 点 X → tab 立即消失，侧栏该会话状态点转灰（stopped），对应 `aide-agent.exe` worker 进程退出。
9. 重新从侧栏打开该会话 → 历史在，发消息能 respawn。
10. "关闭其他"关掉 2 个运行中 tab → 两个 worker 都退出，激活 tab 仍在跑。

## 主题适配

新增的 `.pane-tab__close--live:hover` 用 `var(--aide-danger)`——所有主题（glass / warm-dark / catppuccin / smoky-pink-glass）都已定义 `--aide-danger` 槽位，无需改主题文件。遵守"配色一律走语义 token"红线。