# Memory Observatory（记忆观测台）设计

- 日期：2026-09-04
- 状态：设计草案，待评审
- 关联记忆：UI 变体先出可视原型；Feature logic → submodule layering；同步命令禁止重 IO

## 1. 背景与目标

aide 的 auto memory 就是 Claude Code 的 auto memory，落在 `~/.aide/claude/projects/<key>/memory/`（CLAUDE_CONFIG_DIR 由 runtime 强制指向 `~/.aide/claude/`，见 onboarding.rs）。形态：

- `MEMORY.md` 索引 + 若干 topic 笔记（纯 markdown）。本项目实测：索引 42 行链出 56 篇 topic，单文件最大 ~13KB
- 加载语义：每会话启动只线性加载 MEMORY.md 的**前 200 行 / 25KB**（先到先截）；topic 文件由 agent 按需 Read，无向量无搜索
- 写入：agent 会话中自行 Write/Edit（记忆也可能被后台整理机制改动/删除——观测台只如实报告文件变化，不做归因）
- 另有用户级全局指令 `~/.aide/claude/CLAUDE.md`（实测 1.9KB），每会话全量加载——按用户定案纳入观测范围，**只展示内容，不引申其功能**

问题：这套记忆完全不可见——记了什么、索引离截断线还有多远、哪些笔记其实永远到不了 agent、记忆随时间怎么长，用户一概不知。

目标：左侧栏独立入口的「记忆观测台」，三个镜头：**Memory（记了什么/健康度）、Influence（能不能到 agent）、Evolution（怎么生长）**。只读观测，v1 不做编辑。

排雷：`.aide/`（codegraph 索引）与本特性**无关**，不碰。

## 2. 范围

**本期做（P0+P1 一次交付）**：

1. 左侧栏入口 + `MemoryObservatory.vue` 面板（三个 tab：记忆 / 影响 / 演化）
2. 后端聚合命令：memory 目录解析 + MEMORY.md 解析 + 孤儿/死链检测 + CLAUDE.md 读取
3. Influence 可达性分级（纯 memory 文件推导，见 §5）
4. Evolution 基础：生长时间线 + 快照台账 diff
5. **删除记忆**（v1 唯一写操作，用户定案）：行内确认后删 topic 文件；若被 MEMORY.md 引用，索引行一并移除（防删出死链）

**先不做（非目标）**：

- 扫描会话 transcript 统计真实召回——用户定案：观测对象只有记忆文件本身，单文件不过十几 KB，不存在大会话数据。若未来要测「真实召回率」另立一期
- 记忆的编辑（v1 只读 + 删除，不做内容修改）
- CLAUDE.md 的功能解析（只展示原文，且 CLAUDE.md 不可删除）
- 远程 PWA 侧展示（桌面 UI 专属，不进 remote REGISTRY）

## 3. 数据源与解析

### 3.1 目录解析（复用现有逻辑，不新造）

- workspace key → 项目目录：复用 `commands/workspace/mod.rs` 的 `path_to_key` + `resolve_project_dirs`（dot 归一多目录合并，2026-07-24 分裂目录已实锤），取每个命中目录下的 `memory/` 子目录，内容合并；同名文件冲突时后命中目录优先并在 DTO 里标注来源目录
- 用户 CLAUDE.md：`<CLAUDE_CONFIG_DIR>/CLAUDE.md` 单文件直读

### 3.2 MEMORY.md 解析

提取 markdown 链接 `- [标题](文件.md) — 描述`，产出索引条目列表（含行号——行号是截断判定的依据）。非链接行原样保留计数（索引里允许自由文本条目，如实测第 21 行）。

### 3.3 快照台账（Evolution 用）

存 aide 自己的配置侧，**不写进 Claude 的 projects 目录**（避免 claude.exe 误读）：`~/.aide/observatory/<key>.jsonl`，append-only，每条 `{ts, files:[{name, size, mtime}], indexLines, indexBytes}`。每次打开观测台追加一份并返回与上一份的 diff。滚动保留最近 200 份。

## 4. 命令设计（Rust 主进程）

新子模块 `src-tauri/src/commands/memory_observatory.rs`（feature logic 下沉同名子模块，宿主只留转发）。三条命令，全部 `async fn` + `spawn_blocking`（遍历 + 读几十个小文件，遵守主线程禁令；不埋 trace_command——async 命令埋了也抓不到）：

| 命令 | 返回 |
|---|---|
| `memory_observatory_scan(workspaceKey)` | 聚合 DTO：`index{lines, bytes, entries[{title, file, desc, line}]}`、`topics[{name, size, created, modified, indexed, truncated, exists}]`、`orphans[]`、`deadlinks[]`、`claudeMd{path, bytes, modified}`、`limits{maxLines:200, maxBytes:25600}` |
| `memory_observatory_read_file(workspaceKey, name)` | 单文件全文（前端预览用）。**路径必须 confined 在解析出的 memory 目录内**（拒绝 `..`/绝对路径/分隔符），`name == "__claude_md__"` 特判读用户 CLAUDE.md |
| `memory_observatory_snapshot(workspaceKey)` | 写快照并返回 `{previousTs, added[], removed[], modified[]}` |
| `memory_observatory_delete_file(workspaceKey, name)` | 删除 topic 文件；若 MEMORY.md 中有链接到该文件的索引行，**一并移除索引行**（防删出死链），返回 `{deleted, indexLineRemoved}`。同样 confined 校验；`MEMORY.md` 本体与 `__claude_md__` 拒绝删除。删除是写操作，前端必须先行内二次确认（见 §6.3） |

安全：memory 目录与 CLAUDE.md 都是 app 自有数据，读取不做 trust 门控；路径 confinement 防穿越是硬性校验（删除命令同样适用）。

前端经 api 门面收编：`packages/aide-sdk/src/api/memoryObservatory.ts` 新增分域文件，facade 注册；mock 边界指 `@aide/sdk/api`。

### 4.2 事件台账（sidecar 内建 hook，Influence 的事件来源）

记忆操作没有独立工具，就是 Read/Write/Edit 落在 memory 目录上的普通文件调用。埋点走 sidecar 既有内建 hooks 注册表（`agent-sidecar/src/builtinHooks/index.ts` 的 `BUILTIN_HOOKS`）：

- 新增 `memoryEvents` hook：**PostToolUse**，matcher `Read|Write|Edit|MultiEdit`；回调里取 `tool_input.file_path`，前缀命中当前工作区解析出的 memory 目录时，append 一行到 `~/.aide/observatory/events.jsonl`：`{ts, session_id, workspace_key, op, memory_id}`（memory_id = 文件名；op 分类：Read→`read`，Write 新文件→`created`、已有文件→`updated`，Edit/MultiEdit→`updated`；`deleted` 由观测台自己的删除命令写入，或快照 diff 事后补记）
- 写盘是几十字节的 append，hook 内 fire-and-forget，失败静默（与学习/记录类 hook 同政策，永不阻塞工具调用）
- `BuiltinHookEntry.event` 联合类型需扩 `"PostToolUse"`（现有 4 事件之外新增）；**「扩展」面板的内置 hooks 前端镜像（useCustomizations.ts 静态登记）必须同步加一行**，否则不显示（既有教训）
- 历史不追溯：事件从部署之日起累积，不回填
- op 不区分「agent 主动写」还是后台整理写——只记文件行为，不做归因（用户定案）

### 4.3 文件清单（新增功能目录骨架）

```
src-tauri/src/commands/memory_observatory/     ← 新子模块（feature logic 下沉，宿主 commands/mod.rs 只留转发）
├── mod.rs            — 4 个 Tauri 命令签名 + 注册转发（全 async + spawn_blocking）
├── resolve.rs        — workspaceKey → memory 目录（复用 path_to_key/resolve_project_dirs）、
│                       observatory 数据目录（~/.aide/observatory/）、路径 confinement 校验
├── parse.rs          — MEMORY.md 链接解析（标题/文件/描述/行号）、孤儿/死链/截断线判定
├── scan.rs           — scan 聚合 DTO 组装（含 events.jsonl 读取与聚合统计）
├── snapshot.rs       — 快照台账读写与 diff（snapshots/<key>.jsonl，滚动 200 份）
└── （内联 #[cfg(test)] fixture 测试）

agent-sidecar/src/builtinHooks/
├── memoryEvents.ts        ← 新增：PostToolUse hook（路径命中判定 + events.jsonl append）
├── memoryEvents.test.ts   ← 新增
└── index.ts               ← 改：注册 memoryEvents + event 联合类型扩 PostToolUse

packages/aide-sdk/src/api/
└── memoryObservatory.ts   ← 新增：api 门面分域（4 命令 DTO 对象化）

src/composables/
└── useMemoryObservatory.ts ← 新增：面板状态闭包（scan 缓存 / tab / 筛选 / 删除流）

src/components/MemoryObservatory/
├── MemoryObservatory.vue   ← 弹层壳 + 三 tab + 关闭三路
├── MemoryList.vue          ← 记忆 tab：stat 行 / 告警 chips / 清单 / 行内删除确认
├── InfluenceView.vue       ← 影响 tab：可达性分级 + 使用统计（见 §5.2）
├── EvolutionView.vue       ← 演化 tab：生长曲线 / 最近变化 / 快照 diff
├── observatory.ts          ← 纯函数层：分级归类 / 徽标 / 事件聚合（全部可直测）
└── MemoryObservatory.test.ts

改动既有文件（只加不改语义）：
├── src/components/SidebarLeft.vue   — 状态栏入口按钮（设置左侧），emit open-memory-observatory
├── src/App.vue                      — defineAsyncComponent + observatoryVisible 挂载弹层
└── src/composables/useCustomizations.ts — 内置 hooks 镜像登记 memoryEvents

运行时数据（应用自有，不进 Claude 目录）：
└── ~/.aide/observatory/
    ├── events.jsonl            ← hook append 的事件台账
    └── snapshots/<key>.jsonl   ← 每工作区快照台账
```

## 5. 三镜头指标定义

### 5.1 Memory（记忆 tab）

- **索引余量**：MEMORY.md 行数 / 200、字节 / 25KB 双占比（取高者为主仪表）——超限即静默截断，是本系统最真实的暗伤，放第一屏
- **健康告警**：孤儿（文件在、索引无链接→永远不被回忆）、死链（索引链接指向不存在文件）
- **记忆清单**：全部条目表格——标题、大小、创建/修改时间、状态徽标（索引内 / 孤儿 / 死链 / 窗口外），点击展开全文预览
- **全局指令卡片**：用户 CLAUDE.md（大小、修改时间、可展开原文）

### 5.2 Influence（影响 tab）——可达性分级 + 事件台账使用统计

**第一块：可达性分级**（纯 memory 文件推导，不需要事件）：

| 层级 | 定义 | 实测含义 |
|---|---|---|
| L0 常驻 | 用户 CLAUDE.md + MEMORY.md 截断窗口内（前 200 行/25KB）的索引条目 | 每会话必载 |
| L1 可达 | 窗口内条目链接的 topic 文件 | agent 看得到链接，可按需 Read |
| L2 边缘 | 截断线之外的索引条目及其 topic | 链接根本没进上下文，实际不可达 |
| L3 不可达 | 孤儿文件 | 无任何入口 |

**第二块：使用统计**（事件台账驱动，§4.2 的 events.jsonl；功能清单逐条对账用户 2026-09-04 定的 16 行表）：

| 功能 | 数据来源 |
|---|---|
| 记忆总数 / 本周新增 / 本周使用 | scan + events 按周 COUNT |
| 新增/更新/删除记忆流 | events（created/updated/deleted）+ 文件时间兜底 |
| 记忆使用次数 / 最常用 TOP 5 | events read 按 memory_id GROUP BY |
| 最近学习 / 最近活动混排 | created+updated 倒序 / 四类事件按时间混排 |
| 使用趋势图（按天 read）/ Learning 趋势图（按天 created+updated） | events 按天聚合，SVG 手绘 |
| Session→memories / memory→sessions / 使用场景 | events 带 session_id + workspace_key，会话标题从会话注册表取 |
| 「本次任务使用了 N 条 Memory」 | 当前 session_id 下 COUNT(DISTINCT memory_id) |
| Memory 详情 | 原文 + created/updated + usage count + 最近使用时间 |

限制如实写进 UI 空态：事件从部署之日起累积，部署前的使用无记录。

### 5.3 Evolution（演化 tab）

- **生长曲线**：按文件创建时间的累积面积图（SVG 手绘，不引图表库；颜色走 chart token）
- **最近变化**：近 7 天新增/修改列表（mtime/birthtime）
- **快照 diff**：与上次打开观测台相比的 +新增 / −消失 / ~修改（只报告变化，不归因来源）
- **停滞提示**：最近一次新记忆距今天数

## 6. UI 设计（高级简约）

### 6.1 入口与挂载

- `SidebarLeft.vue` 底部状态栏加按钮（设置按钮左侧），图标用简洁的圆点阵/脑形线性图标，`v-tooltip="'记忆观测台'"`，emit `open-memory-observatory`
- `App.vue` 仿 SettingsPanel 模式：`defineAsyncComponent` + `observatoryVisible` flag，居中弹层（宽 ~880px、高 ~85vh），close / 点击外部 / Esc 三路关闭（复用 ContextUsagePanel 已验证的关闭模式）

### 6.2 面板结构

顶部：标题「记忆观测台」+ 工作区名 + 三 tab（记忆 / 影响 / 演化），tab 用下划线指示器而非胶囊——观测台是仪表盘气质，不做药丸。

视觉原则：

- 全部 `var(--aide-*)`，零硬编码 hex；图表用 context-usage 已建好的 chart token 槽位，不新增色板
- 数字一律 tabular-nums；大数字 + 小标签的 stat 排布；大量留白，无卡片套卡片
- 第一屏直接给结论：索引余量仪表 + 健康告警数 + 记忆总数，不要欢迎语不要空态插画
- 加载中骨架用既有表面 token 脉冲，不新增动画规范

### 6.3 删除流（v1 唯一写操作）

- 行 hover 出现垃圾桶图标 → 点击后该行展开**行内确认条**（danger 色底）：「删除「标题」？topic 文件将被删除；若被 MEMORY.md 引用，索引行一并移除（防死链）。此操作不可撤销。」+ [删除] [取消]
- 确认后行淡出，stat 区记忆总数/告警数即时联动；死链条目（文件已不存在）不提供删除按钮，只提示「从索引移除该条目」走同一命令的索引行移除路径
- CLAUDE.md 行无删除按钮

可视原型（三 tab + 删除确认态已截图验证）：`docs/prototypes/memory-observatory.html`，预览图 `docs/prototypes/memory-observatory-preview.png`。落地时颜色全部换算成 `--aide-*` token（原型中的 hex 仅作设计定稿参照：accent #3987e5 / warning #c98500 / danger #d95926 / success #199e70，与 chart token 种子同源）。

## 7. 测试与验收

- Rust 单测：MEMORY.md 链接解析（含非链接行、坏链接、重复链接）、孤儿/死链判定、路径 confinement（`..`、绝对路径、分隔符注入全拒绝）、多目录合并冲突标注；删除命令——索引行同步移除（含一行多链接只摘该行、无引用时纯删文件）、MEMORY.md 本体/CLAUDE.md 拒绝删除；events.jsonl 聚合（按周/按天/按 memory_id GROUP BY、session 双向查询）——fixture 目录构造
- sidecar 单测：memoryEvents hook——路径命中/不命中、op 分类（Read→read、Write 新旧文件、Edit→updated）、写盘失败静默不阻塞工具调用、BUILTIN_HOOKS 注册顺序与 manifest 登记
- 前端：`MemoryObservatory.vue` 挂载测试，mock `@aide/sdk/api`；状态徽标与分级归类的纯函数抽出直测；删除确认流（确认→调命令→行移除→stat 联动，取消→状态复位）；useCustomizations.ts 镜像含 memoryEvents
- 实机验收：打开面板看到本项目真实记忆（56 topics / 42 行索引），孤儿/死链计数与手工 `ls` + 索引对照一致；快照二次打开 diff 正确；删除一篇测试记忆后 MEMORY.md 无残留死链；会话中让 agent 读/写一篇记忆后，影响 tab 出现对应事件且 session 关联正确

## 8. 分期

- **P0**：四条命令（含删除）+ 入口 + 记忆 tab（含删除流）+ 演化 tab（生长曲线/最近变化/快照 diff）
- **P1**：memoryEvents hook + 事件台账 + 影响 tab 完整版（可达性分级 + 16 行使用统计）+ 全文预览打磨
- **P2**：跨项目聚合视图（扫 `projects/*/memory/` 全量，全局健康/搜索/演化）+ 全局记忆卡片（`~/.aide/memory/shared.md`，经用户 CLAUDE.md 的 `@import` 进入所有会话）——统一管理方向按此落地，junction 共享存储方案明确放弃
- P3 候选（不承诺）：记忆编辑、主题自动聚类、存量 transcript 一次性回填（需另立一期评审）
