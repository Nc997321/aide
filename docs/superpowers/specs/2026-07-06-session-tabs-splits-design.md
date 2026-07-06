# 会话多 Tab + 任意分屏（VS Code 式编辑器组）设计

日期：2026-07-06
状态：已确认（形态与交互语义经用户逐项确认；实现细节授权自行决定，以健壮性优先）

## 修订 2026-07-07：混合 tab（跨工作区）+ MRU 切换

用户确认的行为变更，覆盖原文对应条目：

1. **布局改为全局唯一一份**（原 §3 按工作区分份作废）：不同工作区的会话同屏并存，
   切换活动工作区不再动聊天区 tab。快照升级 v2（每 tab 附带会话名 + wsKey/wsPath，
   恢复时 seed 注册表并逐工作区校验存在性）；v1 快照直接作废回退空白。
2. **会话级 cwd**：`send_message` 新增 `workspace_root` 可选参数，sidecar 在会话
   自己的项目目录里跑；归属来自 `useSessionWorkspaces` 注册表（侧栏加载/新会话
   创建/快照恢复三处写入），无记录回落当前活动工作区。
3. **tab 工作区标识**：会话不属于当前活动工作区时，tab 名后缀淡色小字工作区短名
   （hover 显示完整路径）；同工作区不显示（减噪）。
4. **Ctrl+Tab 改为 OS Alt+Tab 语义**（替代原「组内位置循环」）：全局 MRU 列表，
   按住 Ctrl 连按 Tab 回溯（栈序冻结），松开 Ctrl 提交；快速按一次在最近两个
   会话间往返。Ctrl+Shift+Tab 反向。
5. 侧栏会话右键「在新标签页/分屏打开」对所有工作区开放（原「仅当前工作区」限制取消）。

## 1. 需求

聊天区从「单一 ChatPanel」升级为 VS Code 式编辑器组：

- **Tab**：每个分屏组自带 tab 栏，每个 tab 承载一个会话（或空白"新建会话"面板）。
- **分屏**：任意方向递归切分（横/纵嵌套的布局树）。
- **其余会话逻辑不变**：对话核心、事件路由、权限、变更追踪等全部沿用。

### 已确认的交互语义

1. **预览 tab（用户逐字确认）**：
   - 已启动的会话占住自己的 tab，永远不会被覆盖。
   - 点击侧栏里未启动的会话：若聚焦组已有预览 tab → 覆盖其内容；否则新增一个预览 tab。
   - 预览 tab 里会话真正启动（派发消息）后转正为固定 tab；下次点未启动会话再新增预览 tab。
   - "已启动"判定：`useSessionState` 中该 sid 非 `stopped`，或本次运行中派发过消息。只看历史不算启动。
   - 预览覆盖只发生在聚焦组内，其他组的预览 tab 不受影响。
2. **会话全局唯一**：一个会话最多占一个 tab（跨组同样）；点击已打开的会话直接聚焦到那个 tab。
3. **分屏入口**：tab 右键菜单（向右/向下拆分）、快捷键、侧栏会话右键菜单（在新标签页打开 / 在右侧分屏打开 / 在下方分屏打开）。不做拖拽 tab 分屏（留作未来扩展）。
4. **布局持久化**：布局树跨重启恢复（按工作区分别保存）；只恢复面板结构与历史消息，不恢复会话进程。
5. **权限弹窗**：全局弹窗只显示聚焦组激活会话的权限请求；其他可见会话等权限时靠 tab 上的 attention 状态点提示，切过去才弹。
6. **新建会话（Ctrl+N / 侧栏按钮）**：空白面板天然是"未启动"，走预览 tab 语义（复用或新增预览 tab）。

## 2. 架构（方案 A：递归布局树 + 自治面板组件）

分层：**状态层**（纯数据布局树 composable，可脱离 UI 单测）→ **视图层**（递归渲染组件）→ **接线层**（App.vue 桥接现有系统）。

### 2.1 状态层：`src/composables/usePaneLayout.ts`

模块级 reactive 单例（与 `useSessionState` / `useFileViewer` 同风格）。

```ts
type PaneNode = SplitNode | GroupNode;

interface SplitNode {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical"; // horizontal = 左右并排
  children: PaneNode[];                 // ≥2
  sizes: number[];                      // 与 children 等长，比例和为 1
}

interface GroupNode {
  type: "group";
  id: string;
  tabs: TabItem[];
  activeTabId: string | null;
  previewTabId: string | null;          // 本组预览 tab（至多一个）
}

interface TabItem {
  id: string;                // tab 自身 id，不是 session id
  sessionId: string | null;  // null = 空白"新建会话"面板
  pendingName?: string;      // 空白面板预起的名字（取代现在 App.vue 的 pendingSessionName）
}
```

根节点 + `focusedGroupId`。初始/兜底状态 = 单组单空白 tab（与现状等价）。

**核心 API**（全部纯树操作）：

| API | 语义 |
|---|---|
| `openSession(sid)` | 全局已开 → 聚焦；聚焦组有预览且目标未启动 → 覆盖预览；否则新增预览 tab |
| `openSessionInSplit(sid, direction)` | 侧栏右键「在分屏中打开」：先拆分聚焦组再打开 |
| `openBlankTab(name)` | 新建会话：走预览语义，`sessionId: null` |
| `closeTab(groupId, tabId)` | 关 tab + 树规范化 |
| `closeOtherTabs(groupId, tabId)` | 关其他 tab |
| `splitGroup(groupId, direction)` | 组所在位置替换成 split，激活 tab 移入新组并聚焦 |
| `promoteTab(sid)` | 预览转正（会话启动时调用；双击 tab 也转正） |
| `focusGroup(id)` / `setActiveTab(groupId, tabId)` | 聚焦/激活 |
| `bindSession(tabId, sid)` / `rebindSession(oldSid, newSid)` | 空白 tab 绑临时 sid；temp→real id 迁移 |
| `closeSessionTab(sid)` | 会话被删除时关掉对应 tab |
| `setSizes(splitId, sizes)` | 分隔条拖拽写回 |
| `activeSessionId: ComputedRef<string \| null>` | 聚焦组激活 tab 的 sessionId——全体下游消费此值 |
| `serialize()` / `restore(snapshot)` | 持久化快照（防御式校验，见 §5） |

**树不变量**（每次变更后 `normalize()` 强制成立，单测覆盖）：

- 无空组（组内 tab 清空 → 从父 split 摘除，尺寸并入兄弟）。
- 无单孩子 split（拍平提升孩子）。
- 无嵌套同方向 split（并入父级，成多孩子 split，同 VS Code）。
- `sizes` 与 `children` 等长且归一化；`activeTabId`/`previewTabId`/`focusedGroupId` 永远指向存在的实体。
- 根节点永远存在；最后一个 tab 被关闭 → 重置为单组单空白 tab。

### 2.2 视图层：`src/components/PaneLayout.vue` + `src/components/panelayout/`

遵循「组织文件在上层、子实现在同名子目录」（同 `FileViewer.vue` + `fileviewer/` 先例）：

- **`PaneLayout.vue`**（组织层）：渲染布局树根节点，注入布局操作。
- **`panelayout/PaneSplit.vue`**：递归组件。split 节点 → flex 容器 + 子节点 + 分隔条（复用 `useResizable` 的交互模式，按比例写回 `setSizes`）；group 节点 → `PaneGroup`。
- **`panelayout/PaneGroup.vue`**：tab 栏 + 内容区。**内部自持 `useChatSession(自己的 activeSessionId ref)`**，把现在 App.vue 里 ChatPanel 的 props/emits 接线整体搬入。每组常驻**一个** ChatPanel 实例，切 tab 只换 `sessionId` prop（与现状切会话行为一致，输入草稿等组件内状态的表现不回退）。组容器点击/输入 → `focusGroup`。聚焦组有可视高亮（tab 栏底色/边框微差）。
- **`panelayout/PaneTabBar.vue`**：tab 条。显示会话名 + 状态点（复用 `useSessionState.dotTone`，含 attention 提示）+ 关闭按钮；预览 tab 斜体；双击转正；右键菜单（关闭 / 关闭其他 / 向右拆分 / 向下拆分）。样式对齐现有 `ATabBar` 设计语言，但独立组件（语义不同：可关闭、可预览、带状态点）。

ChatPanel 自身**零改动**（props/emits 不变）。

### 2.3 接线层：App.vue 及周边改动

| 现状 | 改为 |
|---|---|
| `panel-center` 内单个 ChatPanel + 全套 props 接线 | 只放 `<PaneLayout />`，接线随 PaneGroup 下沉 |
| `const activeSessionId = ref("")` | `usePaneLayout().activeSessionId`（计算属性）。右面板 FileTree/ChangeLog、标题栏、侧栏高亮、`useConversationChanges` 等下游**零语义变化** |
| App.vue 持有唯一 `useChatSession` | App.vue 保留一个绑定 `activeSessionId` 的轻量实例，只服务 PermissionDialog（`pendingPermission` / `respondPermission`）——store 是模块级的，多实例零成本 |
| `pendingSessionName` ref | 下沉为 `TabItem.pendingName` |
| `onSessionCreated` 回调更新 `activeSessionId` | 两个订阅：`usePaneLayout.rebindSession(tempId, realId)`（换 tab 绑定）；App.vue 照旧写元数据/加侧栏/记最近访问，名字从 tab 的 `pendingName` 取 |
| 侧栏 `session-changed` → 赋值 activeSessionId | → `openSession(id)` |
| 侧栏 `new-session` → 清空 activeSessionId | → `openBlankTab(name)` |
| 工作区切换 → 清空 activeSessionId | → 保存当前工作区布局，恢复目标工作区布局（无则单组空白 tab） |
| 侧栏删除会话 | 额外调 `closeSessionTab(sid)` |

**发送流**：PaneGroup 内 `sendMessage` 返回 sid 后，若本 tab 是空白 tab → `bindSession(tabId, sid)`；随后 `promoteTab(sid)`（启动即转正）。

**快捷键**（沿用 `settings.keybindings` + `matchShortcut` 体系，可在设置里改）：

- `Ctrl+\`：当前 tab 向右拆分；`Ctrl+Shift+\`：向下拆分
- `Ctrl+W`：关闭当前 tab
- `Ctrl+Tab` / `Ctrl+Shift+Tab`：聚焦组内切 tab（若与 WebView 默认行为冲突则只保留组内右键/点击切换，实现时验证）

**右键菜单**：走现有 `useContextMenu` + `menus/contextMenus.ts` 工厂模式，新增 `paneTabMenuItems()` 与侧栏会话菜单项（在新标签页打开 / 在右侧分屏打开 / 在下方分屏打开）。

## 3. 持久化

- 存储：`useSettings` 新增 `paneLayouts: Record<string /* wsKey */, PaneLayoutSnapshot>`，布局变更 debounce（~500ms）落盘。
- 快照内容：树结构 + 每 tab 的 sessionId + 激活/聚焦/预览标记 + sizes。**空白 tab（sessionId: null）不入快照**。
- 恢复（工作区加载时）：
  1. 结构校验失败（字段缺失/类型不符/违反不变量）→ 整体丢弃，回退单组空白 tab，不抛错。
  2. 逐 tab 校验会话仍存在（对照 `listSessions`），不存在的 tab 剔除后 `normalize()`。
  3. 恢复的会话 tab 均视为"未启动"，但**不**标记为预览（用户上次留下的布局即固定布局）。

## 4. 权限与状态提示

- PermissionDialog 保持全局单例，数据源 = `activeSessionId` 对应 store 的权限队列（即：只弹聚焦会话的）。
- 非聚焦会话进入 `attention`：其 tab 状态点变橙（`dotTone` 现成逻辑），标题栏活跃会话列表照旧提示。切换聚焦到该 tab 时弹窗自然出现（数据源随 `activeSessionId` 切换，无需额外事件）。
- 切走时不取消权限请求——请求仍挂在该会话 store 的队列里，sidecar 侧 Promise 继续等待（现有机制，无改动）。

## 5. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 关闭正在运行会话的 tab | 只关面板，不 stop 进程（与现状"切走会话仍后台跑"一致）；后台事件照常写入模块级 store |
| 关闭最后一个 tab | 重置为单组空白 tab |
| 会话进程崩溃（session_dead） | tab 状态点变灰，面板内错误消息照旧显示——无布局层特殊处理 |
| temp id 阶段（session_init 未返回）关闭 tab | 允许；孤儿 pending store 无害（现状同款内存驻留），不落盘 |
| 恢复快照引用已删除会话 | 剔除该 tab（§3） |
| openSession 目标 = 聚焦组当前激活会话 | no-op |
| 同一会话在快照中出现两次（手改文件等） | restore 时去重保首个 |

## 6. 测试

- **`src/composables/usePaneLayout.test.ts`（vitest，重点投入）**：预览开/覆盖/转正全语义（含用户确认的边界：聚焦已启动会话时点未启动会话 → 新增预览）、全局唯一聚焦、split/close/normalize 全部不变量、serialize→restore 往返、损坏快照回退、会话删除剔除 tab、rebindSession 迁移。
- 组件层：PaneGroup 的 useChatSession 绑定切换冒烟（现有组件测试基建有多少用多少，无则以类型检查 + 手测清单代替）。
- 手测清单（实现完成后逐项过）：双组并行对话互不干扰、后台组权限 attention 点、重启恢复布局、工作区切换布局隔离、Ctrl+N 预览语义。

## 7. 不做的事（YAGNI）

- 拖拽 tab 到边缘分屏 / 拖拽 tab 跨组移动（未来扩展，布局树 API 已预留 `splitGroup`/`setActiveTab` 基础）。
- 同一会话多处打开。
- 分屏组内嵌权限弹窗。
- tab 溢出滚动之外的花哨管理（固定/分组/颜色等）。
