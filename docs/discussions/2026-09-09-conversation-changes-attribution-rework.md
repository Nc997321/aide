# 会话变更：归属重构 + 面板形态重构

日期：2026-09-09
触发：变更面板内容窜到别的会话 / 别的工作区（上一次 per-sid 修复后照旧）
状态：**方案待评审**，未动工

---

## 1. 现象与根因

面板 186 个文件、轮次里出现别的会话/别的工作区改的文件。

根因一句话：**变更归集的数据源是无归属的全局 git diff**。

坐标链：

- `packages/aide-sdk/src/api.ts:353` `gitDiffFiles()` 无参
- → `src-tauri/src/commands/git/status.rs:23-26` 走 `project_root_for_commands`
- → `src-tauri/src/commands/mod.rs:185-196` 读 `WorkspaceState.path`（**全局单例**）
- → `src-tauri/src/commands/workspace/mod.rs:362-377` `set_workspace`，由 `SidebarLeft.vue:261` 切 tab 时改写

归集三处全无差别调用：`useConversationChanges.ts:138`（轮首快照）/ `:165`（轮末固化）/ `:238`（实时刷新）。

三条窜的路径：

1. **跨工作区**：后台会话固轮时，拍的是你**当前正看着**的那个工作区的 diff。
2. **同仓库多会话**：git 对"谁改的"天然无归属，A 的改动记进 B 的轮。
3. **非会话改动**：手改、`git pull`、其它工具，全算进正在跑的那一轮。

前端**有** per-session 工作区（`useSessionWorkspaces.ts:26`、`useChatSession.ts:310`），只在 `ChangeLogPanel.vue:42` 打开文件时用对了，捕获时没用。
`ChangeLogPanel.vue:38` 那句「捕获变更时 git 就以它为 cwd」的注释**与代码不符**，是错的。

### 上次修复为何无效

`2494a19` 的 per-sid tracker 只隔离了**状态容器**（轮次/快照/落盘队列），每个 tracker 差分的仍是同一份无归属全局 diff——容器分家、内容物共享。

### 附加风险（比显示错更严重）

`useConversationChanges.ts:344-349` `revertRound` 对该轮及之后所有轮逐文件 `git_revert_file`。窜进来的文件是别的会话的真实成果——**点一次撤回会真破坏其它会话的工作**。

---

## 2. 目标形态（本次定为功能规格）

| 区域 | 形态 | 点开后的 diff |
|---|---|---|
| 面板顶部 | **一个统一的文件树**（整个会话累计，目录树） | **单排** unified |
| 下方轮次区 | 每轮下文件**平铺**（不再一轮一个树） | **并排** split |

即：取消"每个轮次各自一棵文件树"，树只在顶部出现一次。

---

## 3. 数据层：归属来自事件，不从工作树反推

### 3.1 为什么能这么做

- sidecar 事件**本身带 `session_id`**（`useChatSession/events.ts:126`），按 sid 路由，归属是一等公民，**不需要新增协议**；
- 前端已有从 tool_call 抽文件路径的纯函数 `buildChangeInfo`（`src/utils/changeCard.ts:93`）与工具白名单 `CHANGE_TOOL_NAMES`（`src/utils/blockSegments.ts:28`）；
- 旁路隔离已有先例：btw 会话就是旁路 store（`events.ts:129-133`），同构复用即可。

### 3.2 归集器

新增 `src/composables/useChangeAttribution.ts`（纯 TS，API 注入式可脱网单测）：

```
TouchedFile { path, status: "M"|"A", addCount, delCount, segments?: Segment[] }
RoundTouches = Map<path, TouchedFile>
```

- 挂在**事件流**上，**不挂消息 store**——消息块会被体积回收（`useChatSession/evict.ts:90`），长会话/后台会话的块会被扔掉；
- 按 sid 分桶；轮边界沿用现有 `sessionState` 转移，但取数方式从「差分」改成**游标取增量**：`drain(sid)` 取走自上次 drain 以来新触碰的文件，天然对应一轮（与现有 `snapshotDiff` 取增量同构）；
- 未跟踪会话（自动化运行，`events.ts:161` `markSessionUntracked`）不归集。

### 3.3 git 降级为「校验者」

git 只用于**补已有条目的 status / 行数**，**发现新条目的权力归事件**。这样即使混用 git，也不会有外来文件混进列表。

同时 `git_diff_files` 需要加可选 `cwd` 参数（跨工作区那条路径必须堵），归集侧从 `sessionWs.workspaceOf(sid)` 取。

### 3.4 落盘

`ChangeRoundData`（`commands/mod.rs:156`）与 JSONL 格式**不变**，磁盘数据兼容，不需要迁移格式。片段是否落盘见决策点 D1。

---

## 4. UI 层

### 4.1 结构

```
会话变更 [N]
├─ 统一文件树（buildChangeTree 复用，输入 = 全会话累计文件）  → 单排
└─ 轮次列表（倒序）
     └─ 轮 N：文件平铺一行一条                              → 并排
```

- 统一树输入：所有轮 files 去重合并（同路径取最新状态，+/- 累加），走 `src/utils/changeTree.ts:60` `buildChangeTree`；
- 平铺行：新组件 `ChangeFileList.vue`，一行 = 状态徽标 + 路径（目录段弱化、文件名强调）+ `+a -d` + 撤回图标；
- 点击行 = **展开 diff**（不再是打开文件）；"打开 ↗" 保留为独立图标（`openResolved`，`ChangeLogPanel.vue:58`）；
- D（删除）条目磁盘上无对应物，不可点开，只能撤回。

### 4.2 diff 视图

`src/components/fileviewer/DiffViewer.vue` **已支持** `initialMode: "split" | "unified"`（`:42`），并可切换（`:177`）。两种形态现成，新增一个薄壳 `ChangeDiffPane.vue` 做懒加载 + 加载态 + 高度估算（高度估算参考 `ToolCallBlock.vue:75-86`）。

### 4.3 组件清单

| 文件 | 动作 |
|---|---|
| `src/composables/useChangeAttribution.ts` | **新增**（归集器，纯函数可测） |
| `src/components/ChangeFileList.vue` | **新增**（轮内平铺 + 展开并排） |
| `src/components/ChangeDiffPane.vue` | **新增**（DiffViewer 薄壳） |
| `src/components/ChangeLogPanel.vue` | 改：顶部统一树 + 轮区平铺 |
| `src/composables/useConversationChanges.ts` | 改：`:138/:165/:238` 三处取数换源 |
| `src/components/ChangeFileTree.vue` | 改：支持点击展开 diff（供顶部统一树用） |
| `src-tauri/src/commands/git/` | **新增** `git_file_pair`（见 §5） |
| `packages/aide-sdk/src/api.ts` | 加 `gitFilePair`；`gitDiffFiles` 加可选 cwd |
| `src/composables/useConversationChanges.test.ts` | 改：mock 从 git 换成事件 |

---

## 5. 后端 diff 取数：能力**已存在**，只需补 cwd（原断言已更正）

> **更正（2026-09-09 实施第 1 笔时发现）**：本文初版写「现状没有任何命令能拿到 old/new 全文」——**是错的**。
> 当时 grep 的是 `git_show_file` / `fileAtHead` / `gitFileDiff` 这些**我猜的命令名**，没搜到就下了结论。
> 实际能力在 `src-tauri/src/commands/git/diffpair.rs:417` `git_diff_pair`，且 `old_text/new_text/
> status/is_binary/eol_only/too_big` 全都有，`assemble_diff_pair` 是纯函数并已有测试模块，
> SDK 侧 `api.ts:455` `gitDiffPair` 也已暴露，`GitPanel.vue:196` 在用。
> **教训：搜不到某个名字 ≠ 能力不存在；应当搜能力描述，而不是搜猜出来的标识符。**

因此本项不是"新增命令"，而是给三个 git 命令补 `cwd`：

| 命令 | 位置 | 补 cwd 的理由 |
|---|---|---|
| `git_diff_files` | `git/status.rs:23` | 变更归集的数据源，跨工作区窜的主因 |
| `git_revert_file` | `git/operations.rs:43` | **唯一的破坏性操作**，不传会在用户当前所看的工作区执行 `checkout --` |
| `git_diff_pair` | `git/diffpair.rs:417` | 历史轮 diff 兜底（C3 的第二态） |

统一经新 helper `commands/mod.rs:205` `project_root_for(ws, cwd: Option<&str>)`：
显式 cwd 优先，空串/纯空白视同省略回落全局，向后兼容既有调用方。

约束不变：git 命令必须 async + `spawn_blocking`（CLAUDE.md「同步 command 禁止重 IO」，
`session/changes.rs:10-14` 有同类事故档案）—— `git_diff_pair` 原本已是此形态。

---

## 6. 影响面（确认过：只碰一处接缝）

| 层 | 位置 | 动不动 |
|---|---|---|
| 落盘格式 | `ChangeRoundData`、`session/changes.rs` JSONL | **不动** |
| 面板 props | `ChangeLogPanel.vue:12-17` | **不动**（rounds / revertRound / revertSingleFile 形状不变） |
| 撤回 | 前端 props 形状不变；**后端 `git_revert_file` 必须加 `cwd`**（见 §10.4） | 前端不动，后端补参数 |
| 消费者 | ChangeLogPanel + `App.vue:302` 一个计数 | **不动** |
| 取文件清单 | `useConversationChanges.ts:138/165/238` | **只换这三处的实现** |

判据：若哪天发现「改归属」要顺带动面板 props 或落盘格式，那才是耦合坏了。现在不需要。

---

## 7. 代价与风险（全部摊开）

1. **覆盖度变窄**：只认 Edit / Write / NotebookEdit。Bash（`sed`/脚本/`mv`/`rm`）、MCP 工具改的文件**会漏**。漏是安全失败（不显示），不会错显示。
2. **删除态 D 识别不了**：纯事件看不出删除，需 git 补 status。发现权归事件，git 只校验已有条目 → 安全。
3. **追溯退化**：应用启动前就在跑的轮，事件没见过 → 该轮显示「无变更」。现在 git 能兜底补上，改完这里退化成漏。
4. **子代理**：内部工具能否拿到 file_path 未实测（`agent-sidecar/src/mapper.ts:252-263` 有映射）。拿不到则子代理的改动会漏。
5. **脏数据**：磁盘上已有的 186 条错误记录不会自动消失，需清理 `-changes.json`。
6. **落盘体积**：若片段落盘（D1 选 A），Write 的 content 是全文，大文件会显著膨胀。

---

## 8. 决策点（2026-09-09 已拍板，结论与依据见 §10）

**D1 — 每轮「并排」的 diff 内容从哪来**

- **A 事件片段**：精确本轮、零后端成本；但历史轮 / 重启后拿不到片段。
- **B 后端 pair**：始终可得，但显示的是「HEAD → 当前」累计差异，**每轮点开内容都一样**，失去「本轮」意义 —— 与你要的形态冲突。
- **C 混合（原推荐）**：内存有片段就用片段（本次会话的轮），没有就调 `git_file_pair` 兜底并在卡片上标注「累计视图」；落盘只存 Edit 片段，Write 不存全文。

#### C 的复杂度复核（2026-09-09 追加，结论：砍成 C3）

复核后确认「C 会不会把结构搞复杂」，分三处看：

**① 渲染层：零成本。** `DiffViewer.vue:38-40` 已有 `firstLineNumber`（注释明写「片段级 diff 传真实起始行」），
`changeCard.ts:93` `buildChangeInfo` 已直接产出片段级 `DiffPair`，`:175` `locateEditStartLine` 已算行号偏移。
两种数据源喂给**同一个** DiffViewer，不需要第二套视图。

**② 落盘：复杂度放大器，砍掉。** 片段落盘 → 体积（Write 全文）、迁移、兼容旧数据、Edit 有片段而 Write 无的
半吊子状态。落盘格式本是全案最大优势（§6「不动」），为片段破例不值。

**③ fallback 粒度：真正的不稳定源，必须收敛。**
以**文件**为单位判断「有没有片段」→ 同一轮内可能一部分文件是片段视图、另一部分是累计视图，
用户看到同一轮两种语义却无从判断哪种可信。
以**轮**为单位判断 → 整轮二态一致。

**→ C3（替代原 C）**：

- 片段**纯内存不落盘**；落盘格式维持不动（保住 §6 的最大优势）；
- 以**轮**为单位二态：本轮有片段 → 片段视图；否则 → `git_file_pair` 累计视图 + 卡片标注；
- 一轮内同一文件被 Edit 多次 → **依次渲染多个片段**（ChangeDiffPane 本身是列表），不做片段合并；
  （必要：现有 `ChangeFile` 是「一文件一条」，事件源天然产生 N 条，聚合策略必须显式定义。）

**关于「不稳定」的净效应判断**：C3 比现状**多**一条取数分支，但**去掉**了两处隐式时序依赖
（轮首快照时间窗、全局工作区单例）。现状的不稳定来自「猜归属」，C3 的不确定只剩「片段有没有存活」。
绝对分支数增加，不确定性下降 —— 净效应是更稳，不是更脆。

**C3 代价**：重启后 / 历史轮一律累计视图，「本轮精确 diff」只在进程生命周期内可见。
核心需求（每轮改了哪些文件）是持久的，不受影响。

**D2 — 统一文件树的范围**

- **本会话累计**（所有轮去重合并）— 我的默认理解；
- 还是 **当前工作区全部改动**（与会话无关，接近 GitPanel）。

**D3 — 平铺行的信息密度**：状态徽标 + 全路径（目录段弱化）+ `+a -d` + 撤回图标，是否还要「打开 ↗」。

---

## 9. 实施顺序（每笔 single-topic）

1. `git_file_pair` 后端命令 + 单测（自足，可先落）
2. `useChangeAttribution` 归集器 + 单测（纯函数，不接 UI，可独立验证）
3. `useConversationChanges` 三处取数换源 + 现有测试改 mock
4. UI：统一树 + 平铺 + `ChangeDiffPane`（并排/单排）
5. 清 `ChangeLogPanel.vue:38` 那条错误注释；清理磁盘脏数据

第 2 步之前面板行为不变，可随时停。

---

## 10. 拍板结论（2026-09-09）

**D1 = C3**（片段纯内存不落盘、以轮为单位二态、一轮内多次 Edit 依次渲染）。依据见 §8 追加的复杂度复核。

**D2 = 本会话累计**（统一树输入 = 该会话所有轮 files 去重合并）。

**D3 = 做「打开 ↗」**，原因不是"能做"，而是**做完层次更清晰**。论证如下。

### 10.1 路径形态：两个来源天然不同（硬事实）

- 事件侧 = **绝对路径**：`.workbuddy/package/sdk-tools.d.ts:760` `FileEditInput.file_path`
  注释原话 "The absolute path to the file to modify"（`FileReadInput` 同）。
- git 侧 = **相对仓库根**：`git diff --numstat` / `git checkout -- <path>`（`operations.rs:48`）语义。

C3 下**文件清单 100% 来自事件**（git 只校验已有条目、不发现新条目），故清单里每一条天生都有绝对路径——
不存在"两种形态混在一个列表里"的情况需要在使用时分辨。

### 10.2 数据模型：会话级 `wsRoot` + 文件级 `relPath`

| 消费者 | 需要 | 取法 |
|---|---|---|
| 撤回 | 相对仓库根 | `relPath` |
| 统一树 / 平铺展示 | 相对（否则 `C:/Users/...` 会把树撑爆） | `relPath` |
| 打开 ↗ | 绝对 | `join(wsRoot, relPath)` —— **确定组合，不是猜测** |
| `git_file_pair` / `git_diff_files` | 需要知道根 | `wsRoot` |

`wsRoot` 是**会话级**事实（这个会话属于哪个工作区），归集时从 `sessionWs.workspaceOf(sid)` 绑定一次；
`relPath` 是文件在工作区内的位置。**两者不冗余**：`absPath` 若单独存，就与 `relPath` 互为派生、
可能不一致；只存 `wsRoot + relPath` 是单一事实源。

这不是影子参数：影子参数是"借用别的通道传不属于它的语义"（如把 `CLAUDE_CONFIG_DIR` 塞进 env）。
`wsRoot` 是数据模型里本就缺失的**实体归属字段**（会话属于哪个工作区），现在补上，语义自明。

### 10.3 做完能删掉一处散落的隐式逻辑

现状 `ChangeLogPanel.vue:42-51` `workspaceRootOf()` 是**消费时猜测**：先查会话注册表，
查不到就 `try/catch` 拿全局活动工作区；注释里还留着"曾缓存于 onMounted → 失锚 → 全部拼到旧根"的事故记录。

改完：`wsRoot` 归集时绑定，`openFile` 退化为 `openResolved(join(wsRoot, relPath))`，
`workspaceRootOf` 整体删除。**隐式逻辑下沉，UI 层变纯** —— 这是 D3 该做的真正理由。

### 10.4 本轮新发现：`git_revert_file` 缺 cwd，撤回有同一个 bug

`src-tauri/src/commands/git/operations.rs:43-50`：

```rust
let root = project_root_for_commands(&workspace_state);
git_run_async(vec!["checkout", "--", path], root).await?;
```

与 `git_diff_files` **同一个全局单例根**、同一类跨工作区错乱：会话属于工作区 A，
你在看工作区 B，撤回会在 B 里执行 `git checkout -- <path>`。

§6 原写"撤回不动"仅指**前端 props 形状**不变；**后端必须加 `cwd`**，与 `git_diff_files` 同款。
撤回是唯一的破坏性操作，这条比显示错更该优先修。

### 10.5 边界规则（清晰、可测、无特判）

- **工作区外文件不归集**：`absPath` 不以 `wsRoot` 为前缀 → 丢弃。
  漏是安全失败；且撤回对工作区外文件本就无意义，语义上也不属于"本会话在我这个项目里改了什么"。
- **会话未绑定工作区 → 不归集**：与既有"未跟踪会话不归集"（`events.ts:161`）同一条规则，不新增分支类型。
