# 每工作空间独立终端 — 设计

## 背景与问题

现状：所有工作空间共用同一组工作台终端。切换工作空间时，`WorkbenchTerminal.vue` watch `cwd` prop → 调 `useWorkbenchTerminal.changeCwd()` → 往当前激活 tab 的 shell 发 `cd "path"` 命令。结果：

- 切换工作空间只是把同一个 shell 的 cwd 切过去，而不是换一套终端。
- 历史、后台进程、环境变量在多个工作空间之间串味。
- 想要"在 A 工作空间跑 `npm run dev`，切到 B 干别的，切回 A dev server 还在"——做不到。

目标：终端按工作空间隔离，每个工作空间有自己的终端组，互不干扰，且默认不启动（懒创建）。

## 需求决策（已与用户确认）

| 维度 | 决策 |
|---|---|
| 切走后旧工作空间终端 | **keep-alive**：PTY 继续后台运行，进程不中断、历史保留，切回原样接上 |
| 每工作空间终端数 | **多 tab**：一个工作空间内可开多个终端 |
| 创建时机 | **显式创建**：空状态 + "新建终端"按钮，点了才 spawn；打开面板不自动起 |
| run config 归属 | **归当前工作空间**：run tab 挂进当前工作空间分组，切走看不到 |
| 终端尺寸 | **宽度跟随对话框宽度**（见下「终端尺寸」一节），高度维持原有逻辑 |

## 整体架构

核心：把"工作空间"作为终端分组的第一维度，PTY 生命周期完全脱离工作空间切换。

```
应用
└─ useWorkbenchTerminal (单例)
   ├─ workspaces: Map<workspaceKey, WorkspaceTerminalState>
   │   └─ WorkspaceTerminalState { tabs: WbSession[], activeId: string }
   ├─ activeWorkspaceKey: string            // 来自 useWorkspaces
   ├─ visible: boolean                       // quake 面板开关（全局，不分工作空间）
   └─ 单个 100ms 轮询循环（遍历所有工作空间的所有 session）
       └─ xterm div 全部常驻同一 container，按规则决定 display
```

关键不变量：

1. 切工作空间**不碰任何 PTY**，只换 `activeWorkspaceKey` → 前端决定显示哪一组 div。
2. 切工作空间**不发 `cd`**（`changeCwd` 整个删除）。
3. 一个终端从 spawn 到 shell 自然退出 / 被 kill，才从 map 里消失；切走只是隐藏。
4. session_id 自带工作空间归属，Rust 端无需改动即可天然区分。

`workspaceKey` 来源：复用 `useWorkspaces` 的 `activeKey`（编码路径，如 `C--Users-proj`），已是稳定的工作空间标识。

## Rust 端：零改动

`ShellManager` 的 `HashMap<String, ShellSession>` 已是按 session_id 多实例，keep-alive 只要不 kill 就行——前端切走时它继续在 map 里跑。Rust 端一行不改，只认字符串 key 当 session_id。

## session_id 命名方案（前端约定）

| 用途 | 现在 | 改成 |
|---|---|---|
| 工作台终端 | `__wb_N__` | `__wb_{workspaceKey}__{n}` |
| run config | `run__{config_id}` | `run__{workspaceKey}__{config_id}` |

session_id 自带「哪个工作空间」信息，前端从 session_id 反推归属不用查表。Rust 端不解析其内部格式，完全透明。

序号 `n` 用模块级自增计数器（`let wbCounter = 0; wbCounter++`），不复用数组长度，避免删除 / 重建撞 id。

## 默认 cwd

spawn 时 `cwd` 参数直接传该工作空间的 path（`useWorkspaces` 里已有），不依赖 `cd` 兜底。新建终端 = 天生在对的工作目录。

## 前端状态重组（`useWorkbenchTerminal.ts`）

现在模块级状态是扁平的 `Map<sessionId, WbSession>` + `tabs[]` + `activeId`。改成：

```typescript
interface WorkspaceTerminalState {
  tabs: WbSession[];      // 该工作空间的所有终端
  activeId: string;       // 该工作空间当前激活的 tab
}

// 模块级
const workspaces = new Map<string, WorkspaceTerminalState>();
const activeWorkspaceKey = ref<string>("");
const visible = ref(false);
let containerEl: HTMLDivElement | null = null;

// 派生（给 UI）
const activeWs = computed(() => workspaces.get(activeWorkspaceKey.value));
const tabs = computed(() => activeWs.value?.tabs ?? []);
const activeId = computed(() => activeWs.value?.activeId ?? "");
```

`WbSession` 结构基本不变，仅 session_id 来源改了（见上）。

### 改动点（逐个对应现状）

1. **删除 `changeCwd()`**（`useWorkbenchTerminal.ts` 第 311-315 行）——整个删。
2. **删除 `WorkbenchTerminal.vue` 里 `watch(props.cwd) → changeCwd`**（第 20-22 行）——新终端只在 spawn 时用一次工作空间路径当 cwd，不再靠 cwd prop 驱动 cd。
3. **`newTerminal()` 改造**：session_id 用 `__wb_{activeWorkspaceKey}__{wbCounter++}`；tab push 进 `workspaces.get(activeWorkspaceKey).tabs`（必要时先 `set` 一个空 `WorkspaceTerminalState`）。
4. **`activeId` 语义改成「当前工作空间内的激活 tab」**：所有读 `activeId.value` 的地方改读 `activeWs.value?.activeId`；切工作空间时 `activeWorkspaceKey` 一变，`tabs` / `activeId` 派生值自动切到那组。
5. **`attachSession`（run-process 用）**：加 `workspaceKey` 参数，run tab 挂进 `workspaces.get(workspaceKey).tabs`，仅在 `workspaceKey === activeWorkspaceKey` 时显示。

## 工作空间切换 + keep-alive 的 DOM / xterm 机制

所有工作空间的所有 session 的 xterm div 常驻同一 `containerEl`，靠 `display` 切换。

**显示规则**（一个 div 可见当且仅当）：
```
session 所属 workspaceKey === activeWorkspaceKey.value
  && session.id === activeWs.value.activeId
  && visible.value === true
```
其余全部 `display: none`。实现：把现有「遍历 sessions 调 display/fit」的逻辑扩成两层——先判工作空间再判 tab。

**轮询**：单个 100ms 循环继续遍历**所有工作空间的所有 session**（不只是活跃的），把输出写进对应 xterm。这样切走的工作空间若有输出（后台跑着 `npm run dev`），buffer 照常累积进 xterm——切回历史完整。这是 keep-alive 体验的来源，零额外开销（div 反正都在 DOM，写文本到隐藏 xterm 几乎免费）。

**`fit` 时机**：xterm 在 `display:none` 时拿不到真实尺寸，`fitAddon.fit()` 只在「tab 变可见」那一刻调（切工作空间到它 / 切 tab 到它 / 面板拉下时），不每轮询都 fit。现有 ResizeObserver 继续负责尺寸变化时的 fit。

**面板可见性联动**：`visible` 仍是全局。收起时所有 div `display:none`；拉下时按上面规则显示当前工作空间的激活 tab。面板开着时切工作空间，内容原地换成新工作空间的激活 tab。

## 空状态 UI

某工作空间无终端（`workspaces.get(key)` 不存在或 `tabs` 为空）时，面板显示空状态：

- 一句提示："该工作空间还没有终端"
- 一个"新建终端"按钮，点击 spawn 第一个终端（cwd = 工作空间路径）

打开 quake 面板本身**不**自动起终端——必须点按钮。这是"默认不启动"的体现。

## run-process 集成

`useRunProcess.ts` 的 `attachSession` 调用加 `workspaceKey` 参数（= 当前 `activeWorkspaceKey`）。run config 执行时挂进当前工作空间分组，session_id 改为 `run__{workspaceKey}__{config_id}`。切到别的工作空间看不到该 run tab，切回还在。`pty-exit` 监听按 session_id 定位到所属工作空间分组。

## 生命周期清理

- **应用退出**：遍历 `workspaces` map 的所有 session 调 `pty_kill`（已有退出清理逻辑的话扩展成遍历所有工作空间）。
- **删除工作空间**：kill 该工作空间下的所有 PTY，并从 `workspaces` map 删该条目。

## pty-exit 处理

shell 自然退出时 Rust 发 `{"session_id": "..."}` 并从 map 移除自身。前端收到后：

1. 按 session_id 定位到所属工作空间分组。
2. 标记该 tab `exited`、移除对应 div / xterm 实例。
3. 若该工作空间变空（tabs 为空）→ 回空状态 UI。

## 终端尺寸

去掉终端面板写死的宽度，改为**宽度跟随对话框（chat input 区）宽度**：

- 终端容器宽度绑定到对话框宽度同一个来源（同一 ref / 同一持久化值）。
- 拖对话框宽度 → 终端同步变宽 / 变窄，不再写死。
- 拖拽结果持久化，重启恢复。
- 高度维持原有逻辑不变。

## 验收清单（手动）

1. 两个工作空间各开终端跑不同命令，互不串味（历史 / 环境 / cwd 隔离）。
2. A 工作空间跑 `npm run dev`，切到 B 干别的，切回 A ——dev server 还在、输出历史完整、滚动位置保留。
3. 全新工作空间首次打开面板显示空状态 + "新建终端"按钮，且不占 PTY 资源；点按钮才起 shell，cwd 默认在该工作空间路径。
4. 拖宽对话框，终端宽度同步变化，重启后恢复。
5. 在某工作空间跑 run config，run tab 出现在该工作空间分组下；切到别的工作空间看不到它，切回还在。
6. shell 自然退出后该 tab 消失，工作空间变空回空状态。

## 不在范围（YAGNI）

- 每工作空间的终端配置 / shell 选择独立化——继续用全局 shell 选择。
- 跨会话恢复终端（重启 aide 后恢复上次各工作空间的终端状态）——重启即清空。
- 终端 tab 在工作空间内拖拽排序。