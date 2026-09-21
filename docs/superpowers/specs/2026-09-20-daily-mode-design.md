# 日常模式：新建页两段切换 + 侧栏「日常」栏 + 档位默认快速

日期：2026-09-20
状态：**已实现（2026-09-21）；端到端冒烟未做**（逐条见文末「实现状态」）
基线证据：2026-09-20 代码走查（逐条给 `文件:行号`，标注「代码事实」与「推断」）
修订：2026-09-21 —— 原「已知代价」第 1 条（记忆空间）框架错误：把"记忆按工作空间分"这条统一规则写成了日常模式的特例，已改写为「边界」节并注明修订理由。

## 背景

### 需求是怎么收敛的

用户原话：*"我希望咱们 aide 有一个默认工作空间，用户在不选择的工作空间的情况下就是它，而且为此我想为其创造一个聊天模式，档位默认是快速。"*

经过澄清，形态收敛为：**新建对话页分「日常 / 工程」两段，默认日常**。「日常」没有工作区这个概念、文案另写、档位默认快速、右栏切进去即收起；侧栏「会话」分区顶部出现一栏「日常」，直接是会话列表。

「默认工作区」是**内部概念**，任何 UI 都不出现它的名字。

### 现状（代码事实）

**工作区模型**

- 工作区 = 显式注册的真实目录：`registeredWorkspaces[]` 存 `~/.aide/state.json`（`src-tauri/src/commands/workspace/registry.rs:23-30`），`key = path_to_key(path)` 且**注册时冻结**（`workspace/mod.rs:34-41`），活动 key 存 `state.json:workspace`（`workspace/mod.rs:474-479`）。
- 没有活动工作区时 `project_root_for_commands()` **静默回落到家目录**（`commands/mod.rs:187-198`）；而显示/索引类消费者 `get_project_info` **刻意不回落**，返回空 root（`filesystem.rs:14-43`，注释记录了 2026-08-01 CodeGraph 索引整个家目录 405 万符号 / 3GB 的事故）。**两个消费者看到的不是同一个世界**——这正是本次要消掉的分裂。
- 首次发消息且 cwd 落在 home 时，home 会被**隐式注册进侧栏**（`chat.rs:265-270`）。

**新建对话页（hero）**

- `HeroWelcome.vue` → `VariantMorning.vue`；文案池 `heroCopy.ts:68-89`（5 条，全部工程向）；归属行是 `新会话位于 [WorkspacePicker] · 模型名`（`VariantMorning.vue:31-36`）。
- 归属传递：空白 tab 的 `pendingWs`（`PaneGroup.vue:101`、`:132-141`），零 tab 时 `layout.defaultWs`（`PaneGroup.vue:85`、`:143-155`）。`onPickWorkspace` 是既有的"只写归属、不切活动工作区"范式（`PaneGroup.vue:143-155`）。

**档位**

- 三档 UI 值：`low`=快速 / `high`=进阶 / `max`=极致（`packages/aide-sdk/src/utils/effort.ts:6-10`）。
- 默认解析链（`src/components/ChatPanel/ChatInputBox.vue:264-302`）：live → `api.sessionEffort(sid)` → provider 默认（`providers[].effortLevel`）→ 硬编码 `"high"`。
- `low` 会**连带关掉思考**（`chat.rs:224-234` `thinking_enabled_for_effort`）。
- 档位在**每轮发送**时随消息下发（`ChatInputBox.vue:970-981`、`:1007-1012`）。

**侧栏**

- 「会话」根分区 → 工作区行 → 会话行（`SidebarLeft.vue:506-601`），与「自动化」根分区平级（`:607`）。会话按 `sessionsByWorkspace[wsKey]` 分组，展开时用 `api.listSessionsForWorkspace(wsKey)` 按需加载（`SidebarLeft.vue:200-209`）。

## 目标

1. 新建对话页加「日常 / 工程」两段切换，**默认日常**。
2. 「日常」：无任何工作区痕迹（去掉归属选择器）、专属文案、档位默认**快速**、右栏切进去即收起。
3. 侧栏新增与「会话」**并级的根分区**「日常」，直接呈现会话列表（工作区树原样留在「会话」里）。
4. 「日常」背后的目录是内部概念，**不出现在任何工作区列表**（侧栏分组、WorkspacePicker 都看不见它）。引导向导不受影响 —— 它调的是目录选择对话框（`WorkspaceStep.vue:42`），本来就不列工作区。

## 非目标

- **活动工作区不跟随焦点**（用户 2026-09-20 定：维持现状）。标题栏/文件树/Git/搜索仍显示"你手选的那个项目"。
- 不做虚拟工作区类型（见「已否方案」）。
- 不动 28 个隐式取根的 git 命令、不改 cwd 解析链。
- 不做远程 PWA / 鸿蒙的「日常」标记。
- 不做会话改归属（日常 ↔ 工程 互转）——**模式只在新建前可选**，对话开始后切换会等于改归属，不做。
- **不做输入框上方的技能 chips 行**（参考图里有，但那对应 aide 的 `/` 技能唤起，是另一个特性，可单独立项）。
- **不动引导向导**（用户 2026-09-20 定：保持现状不改）。
- 不自动激活日常工作区（否则会顶掉用户的当前项目，并影响引导向导的跳过判据）。

## 架构

### 单一判定：`isDaily(wsKey)`

整个特性**只有一个新概念**：会话的归属 key 是不是日常那一个。

```
isDaily(wsKey) = (wsKey === dailyKey)
```

- 日常会话、日常空白 tab、日常 hero —— 全部由同一条判定驱动（文案、档位默认、右栏策略、侧栏归属）。
- **零新增会话字段**：归属本来就是会话属性（`wsPath`/`wsKey` 已在 `~/.aide/sessions/<id>.json`），日常只是"绑到了那个特定目录"。不需要 `kind` 之类的 schema 变更。
- 判定函数落 `packages/aide-sdk`（桌面 + PWA 共用），**禁止在业务代码里再写一份**（CLAUDE.md「能力单一事实源」）。

**判定的输入从哪来（实现者最需要的一句）**：聊天面板族要判"这个 tab 是不是日常"，取 key 的通路与 `effectiveWorkspacePath`（`PaneGroup.vue:79-86`）**同源**：

```
归 key = 有 sid 时 workspaceOf(sid)?.wsKey    // useSessionWorkspaces 注册表
         空白 tab 时 tab.pendingWs?.wsKey     // 创建时已绑定
```

档位默认与右栏策略都吃这条通路，别各自再造一个来源。

### 日常工作区：存在但对 UI 不存在

| 层 | 决定 |
|---|---|
| 路径 | `~/.aide/workspace`（`our_config_dir()/workspace`；常量，用户不可改） |
| 注册时机 | Rust 启动钩子（`lib.rs` setup，与既有 `load_workspace_state` 同一批）：ensure 目录存在 + 幂等注册进 `registeredWorkspaces`。**不激活** |
| 前端取用 | SDK 内懒加载一次并缓存（`ensureDailyWorkspace()`），api 门面收口；会话判定、hero 落点、侧栏数据都吃这一份 |
| 为什么必须注册 | `key = path_to_key(path)` 是信任 / 记忆目录 / LSP / run configs / 会话归属的共同锚，绕不开 |
| 对外可见性 | `list_workspaces` **不返回它**；WorkspacePicker 因此天然看不到 |
| 读取入口 | 新增命令 `daily_workspace() -> { key, path }`，SDK api 门面收口 |
| 可移除性 | 不可移除（侧栏不渲染它，故无移除入口；`remove_workspace` 对它的调用不存在） |

### 模式表（唯一的新抽象）

模式写成**一张数据表**，不写 `if (daily) … else …`。每条模式回答四轴：

| 轴 | 日常 | 工程 |
|---|---|---|
| 文案池 | `DAILY_COPY_POOL`（新增） | 现有 5 条（`heroCopy.ts:68-89`） |
| 默认档位 | `low`（快速） | 现状（provider 默认 → `high`） |
| 落点 | 日常工作区 | 用户选的工作区 / 活动工作区 |
| 右栏 | 切进去即收起 | 现状 |

先填两条。第三条什么时候有真实的行为差异什么时候加 —— **不接受只有文案不同的装饰性模式**（对照 2026-09-20 删掉的 btw 假控件）。

### 新建对话页：两段切换

- 切换控件放 `VariantMorning.vue` 顶部（问候行之下、输入盒之上居中）；**默认日常**。位置与参考图一致，不另造页面。
- **日常**：文案换 `DAILY_COPY_POOL`；**删掉「新会话位于 [WorkspacePicker]」整行**（保留模型名）。
- **工程**：`VariantMorning.vue` **原样不动**（现有 5 条文案 + 归属选择器）。
- **输入框 placeholder 按模式给**：现状是三层嵌套三元写死在 `ChatInputBox.vue:1210`（hero 分支 `'你正在解决什么问题？'`）。加日常会变四层 —— 顺手抽成一个小纯函数（现状 `btwMode` / `isBusy` / `isHero` 三个裸条件已经在往"参数墙"方向长）。
- 落点写入复用既有机制，两个方向都要能写：

| 场景 | 现状机制 | 日常写什么 | 工程写什么 |
|---|---|---|---|
| 零 tab（hero） | `pl.setDefaultWs(bind)` + `pl.setHeroMode(mode)` | `dailyBind` / `"daily"` | `null` / `"project"` |
| 空白 tab | `pl.setTabPendingWs(tabId, bind)` | `dailyBind` | `wsSnapshot()`（可能是 undefined） |

  说明：`onNewTab()` 当前默认绑 `pl.layout.defaultWs ?? wsSnapshot()`（`PaneGroup.vue:132-141`）；改为**按模式意图取**：日常 → `dailyBind`，工程 → `defaultWs ?? wsSnapshot()`。

- **实现期修正（2026-09-21）：零 tab 欢迎态必须多一个模式意图字段 `layout.heroMode`。**
  初稿以为模式可以完全从归属派生（零新增字段），但「**工程 + 还没选工作区**」与「日常」在数据上都是"没有归属"，光看 `defaultWs` / `pendingWs` 分不开 —— 而前者是真实可达状态（全新安装没有活动工作区，用户切到工程后会就地用 WorkspacePicker 选）。
  所以：**零 tab 看 `layout.heroMode`（新字段，默认 `"daily"`，与 `defaultWs` 同生命周期、同样不落盘），有 tab 后模式由那个 tab 的 `pendingWs` 派生**（`isDailyKey`，且 `pendingWs` 本就落盘，所以切走再回来不丢）。一个字段、一个写入者（`setHeroMode`，只由 hero 的模式切换调用），不会漂移。
  初稿的"零新增**会话**字段"仍然成立 —— 这条是布局层的 UI 意图，不是会话属性。

### 侧栏

「日常」是**根分区**，与「会话」「自动化」并级（用户 2026-09-21 定）。分区树本来就是多根结构（`SidebarLeft.vue:485` 注释："「会话」降级为分区树的根分区之一，与自动化平级"），第三条根分区的先例就是 `AutomationSidebarSection.vue`。

```
「日常」分区          ← 新增根分区：栏头（可折叠）+ 会话行直接挂它下面
    └ 会话行 …
「项目」分区          ← 现「会话」分区改名（用户 2026-09-21 定）；子树渲染不动
    └ 📁 <工作区> ▸
        └ 会话行 …
「自动化」分区        ← 不动
```

- 数据：`api.listSessionsForWorkspace(dailyKey)`（既有 API，侧栏已用它加载展开的非活动工作区）。
- 栏头复用 `SidebarSectionHead` 的视觉；会话行复用现有 `.session-row` 渲染与右键菜单语义。
- **不动**「会话」分区的子树渲染（工作区循环）——并级结构天然规避了回归面。
- 过滤点：`useWorkspaces` 的列表来源就剔掉日常 key（**源头过滤**，而非渲染期过滤）——这样 WorkspacePicker 和任何其他消费者都不会漏。
- 「会话」分区**改名为「项目」**（用户 2026-09-21 定）：并级之后它装的是工作区树、不再装全部会话，旧名字失准。改动是**一个字符串**（`SidebarLeft.vue:489` 的 `label="会话"`），代码里没有第二处引用这个分区名。

### 档位默认快速

插入点在既有解析链内（`ChatInputBox.vue:264-302`）：

```
live 当前值 → api.sessionEffort(sid)（用户显式改过的） → 【日常默认 low】 → provider 默认 → 硬编码 high
```

- 位置理由：**用户显式改过档的会话，记忆优先**；日常的定位压过 provider 默认。
- 空白 tab（尚无 sid）：`pendingWs` 是日常 → 同样落 `low`。
- 用户在日常会话里手动切档 → 照既有机制持久化（`useChatSession.ts:493-508`），下次进该会话仍是他的选择。

### 右栏收起

- 触发：**切进日常会话 / 日常 hero 时**右栏收起（用户 2026-09-20 定）。
- 实现落在 `useRightPanel` 的 `collapsed`（`src/composables/useRightPanel.ts:24-25`），由"当前聚焦 tab 是否日常"驱动。
- 切回工程会话**不自动展开**（避免反复开合）。用户手动打开右栏照常可用。
- 这是**布局动作，不是归属变更**：不改活动工作区（与「不跟随焦点」不冲突）。

## 边界（先说清"本来就是这样"的，避免被误读成缺陷）

1. **记忆按工作空间分，日常不例外 —— 统一规则，不是特例，也不破坏什么。**
   记忆目录由会话 cwd 派生的 key 映射到 `~/.aide/claude/projects/<key>/memory`（`agent-sidecar/src/engine/memoryDirs.ts:17-29`；与 Rust `path_to_key` 同规则、两侧都做 dot 归一，函数头注释明写"两边规则必须一致"）。日常会话 cwd = 日常目录 ⇒ 它有自己的记忆空间，**与"你再打开一个项目"完全同构**。
   跨空间共享的那层是全局 `CLAUDE.md`（`customizations/mod.rs:56-62`），日常照样读。
   若要的是"日常里也记得项目里的事"，那不会发生 —— 但这是"记忆按空间分"的既有设计（用户 2026-09-20 已定保持现状），不是日常模式引入的偏差。
   （**2026-09-21 修订**：本节初稿把这条写成"已知代价"，是把统一规则当成了例外，徒增误解。已改正。）
2. **日常的记忆/文件没有 UI 入口**：记忆观测台只在有活动工作区时才渲染（`App.vue:1038-1041`），而日常工作区永不激活、也不在任何列表里 —— 想看/清理日常的记忆得走文件系统。这是"把工作区藏起来"的必然结果，不是缺陷。
3. **日常的项目级指令 = `<日常目录>/CLAUDE.md`**（`customizations/mod.rs:60-62`）。默认不存在，所以日常会话没有项目级指令；**想给日常模式一套常驻指令，放这个文件即可** —— 顺手可用的能力，不是本次任务。
4. **文件树空态**：无活动工作区时 `get_project_info` 返回空（`filesystem.rs:37-41`），文件树显示"未选择工作区"。日常下右栏收起，通常看不到；手动打开会看到它。
5. **首聊隐式注册 home**（`chat.rs:265-270`）只在 cwd 落到 home 时触发；日常会话 cwd 不是 home，不受影响。

## 待验证（上线前必须实测）

- **`list_sessions_for_workspace(日常key)` 必须真能列出日常会话**。该路径用 `resolve_path_from_key(&ws_key)` 反解路径（`session/mod.rs:721`），**不是**查注册表；反解失败时 `root` 为空，元数据补扫会被整段跳过（`session/mod.rs:724`）。这是整个侧栏「日常」栏的数据前提。

  **代码走查已把风险收敛（非实测）**：`resolve_path_from_key`（`workspace/mod.rs:722-737`）是 Windows 盘符硬编码（取首字符当盘符、跳两字符）；`try_decode`（`:1071-1089`）按 `-` 逐段递归、**每段都要求磁盘上真实存在**（`.exists()`）才继续。对 `C:\Users\<user>\.aide\workspace` 逐段走：`C:\Users` ✓ → `C:\Users\<user>` ✓ → `..\.aide` ✓ → `..\.aide\workspace`（需存在）。**结论：只要目录存在就能反解成功** —— 这正是"启动时必须 ensure 目录存在"的第二个理由（不只是为了能当 cwd）。仍按"未实测"对待，plan 里放一条冒烟。

- hero 两段切换后 `pendingWs` 的双向改写不会漏掉"零 tab 同 tick 建 tab"的路径（`PaneGroup.vue:97-98` 注释描述的兜底分支）。

## 顺带记录（本次不修，但别踩）

- `resolve_path_from_key` 是 **Windows 盘符硬编码**（`workspace/mod.rs:722-737`：取首个字符当盘符、`{}:\` 拼前缀），跨平台红线（CLAUDE.md「架构红线：跨平台」）在这条路径上是**既有欠账**。日常模式会把它推到"侧栏栏目数据"这么显眼的位置，若将来在 macOS/Linux 上跑出问题，第一个要看的就是这里。

## 已否方案（记录以免重提）

| 方案 | 为何否 |
|---|---|
| **虚拟工作区**（不落真目录的特殊类型） | 会话子进程必须有真实 cwd，目录还是得存在；然后要为它绕开 `project_root_for_commands` 解析器、28 个隐式取根的 git 命令与所有 key 型子系统。付全部成本，换零能力。 |
| **家目录正名**（把隐式回落正式化） | 2026-08-01 CodeGraph 索引整个家目录（405 万符号 / 3GB）的前科；显示类消费者已被刻意设计成不回落 home。 |
| **活动工作区跟随焦点** | 12 个单例面板（文件树/Git/搜索/CodeGraph/标题栏/记忆观测台/终端…）会失去"现在在哪个项目"的答案：要么全改 per-tab（大面积 UI 重构），要么重写 28 个 git 命令；且跨项目切 tab 会触发重定向风暴（本仓库有卡顿前科）。用户 2026-09-20 决定维持现状。 |
| **栏目名「任务」** | 与自动化的「任务节点」撞车（`AutomationSidebarSection.vue:56`、`contextMenus.ts:264`「新建自动化任务」）。改用「日常」。 |

## 用户决定（2026-09-20）

| 问题 | 决定 |
|---|---|
| 聊天模式是什么形态 | 只是 UI 形态（能力不变），面板收起来 |
| 默认工作区指向 | 专用新目录（非家目录） |
| 模式判定 | 会话属性：绑日常工作区即日常 |
| 活动工作区是否跟随焦点 | **不跟随**（维持现状） |
| 新建语义 | 新建对话页两段切换，默认日常 |
| 栏目名 | 「日常」 |
| 右栏策略 | 切进去就收起 |
| 引导向导 | 保持现状不改 |
| 模式数量 | **两个**（日常 / 工程）；第三条要有真实行为差异才加 |
| UI 参考 | WorkBuddy 截图（给灵感，不照抄）：切换控件位置收下；技能 chips 行不收 |

## 修订（2026-09-21）

| 问题 | 决定 |
|---|---|
| 「日常」放哪 | **与「会话」并级的根分区**（不是塞在「会话」分区内部）—— 并级反而更简单：不碰工作区循环，零回归面 |
| 「会话」分区名 | **改「项目」**（装的是工作区树，旧名失准） |
| 零 tab 欢迎态的模式 | 需要**布局层意图字段** `layout.chatMode`（原计划以为可从归属完全派生，见「新建对话页」节的修正段） |

## 实现状态（2026-09-21）

八个提交（`3f577ebb` → `6be6fbf0`），逐条对齐「目标」：

| 目标 | 落点 | 提交 |
|---|---|---|
| 日常目录引导 + 隐身注册 | `commands/workspace/daily.rs`、`list_workspaces` 过滤、`daily_workspace` 命令 | `3f577ebb` |
| 归属单一判定 + 列表唯一过滤点 | `packages/aide-sdk/src/utils/dailyWorkspace.ts` | `99ce9913` |
| 新建对话页两段切换（默认日常） | `hero/modes.ts`、`heroCopy.ts` 双池、`VariantMorning`、`PaneGroup.currentMode` | `ebe95b43`、`646489be` |
| placeholder 按模式 | `inputPlaceholder.ts` | `3b1bb196` |
| 档位默认快速 | `effortDefault.ts` + `ChatInputBox` 三处落点 | `fd748699` |
| 侧栏「日常」根分区 + 「项目」改名 | `SidebarDailySection.vue`、`SidebarLeft` | `4f14e1d4` |
| 切进日常收起右栏 | `useRightPanel.collapse()`、`activeTabWsKey` | `6be6fbf0` |

**真机首轮发现并修复（`7e380e99`）**：切模式没重算档位。`selectedEffort` 的重算触发点只有
`sessionId` 与 `sessionProvider.id`，切模式两者都不动 → 日常(快速) 切到 工程 仍停在「快速」，
而工程该落 provider 默认（实机供应商 `effort_level=MAX` ⟹ 极致）。不只是显示：首条消息的
`initialEffort` 取的就是这个值，发出去的档位也错。修法是给 `props.mode` 加 watcher，只在
**还没开始会话**时接管（零 tab 欢迎态 / 空 tab），已有会话一律不碰——它们的 mode 由 tab 归属
派生，是同一次切换的副产品，档位归 `sessionId` watcher（重置/恢复记忆）。
同族排查：hero 上其余三处按模式分叉的读数（hero 文案、placeholder、归属选择器）都是 computed，
只有档位这一个不是——**新增"按维度分叉的读数"时先问一句它是 computed 还是只在某个 watcher 里被读到**。

**非目标逐条确认未越界**：活动工作区仍未跟随焦点（右栏收起是布局动作）；未做虚拟工作区类型；
28 个隐式取根的 git 命令与 cwd 解析链一字未动；未做远程端「日常」标记（PWA/鸿蒙调
`daily_workspace` 会走 `ensureDailyWorkspace` 的降级分支，warn 一次后当普通工作区）；
未做会话改归属（模式仅新建前可选）；未做技能 chips 行；引导向导未动（日常目录不激活，
故 `getProjectInfo().root` 对新装仍为空，向导照常出现）。

**验证到什么程度**：
- 单测/组件测试：TS 259 files / 3232 tests 全绿；Rust 913 passed。
- 真机（2026-09-21 首轮）：日常页形态正确（两段控件默认日常、无归属选择器、文案来自日常池、
  药丸「快速」）；**发现档位不随模式重算，已修 + 补 3 条组件测试**（见上）。
- 构建守卫：`pnpm build` 通过（`check:sync-io` / `check:overlay-layers` / `vue-tsc` / vite）。
- 后端引导做过一次性集成自检（`cargo test --lib -- --ignored smoke`）：目录被建、条目已注册、
  **活动工作区一字未动**、二次调用幂等；并做了独立的外部读盘核对（注册 key 与
  `path_to_key(daily_path_in(..))` 一致、路径串完全相等）。
- **仍未验**（真机冒烟后半段）：发一句话 → 会话出现在「日常」分区 → **重启后仍在** → 档位药丸
  是快速 → 工作区列表没多出日常目录 → 切进日常右栏收起。其中「重启后仍在」同时是本文件
  「待验证」那条（`list_sessions_for_workspace(日常key)` 能否列出会话）的实测装置。

## 参考图哪里收、哪里不收（2026-09-20）

用户给了一张 WorkBuddy 的新建对话页截图作为 UI 灵感。四条读数与取舍：

| 图上元素 | 取舍 |
|---|---|
| 居中分段控件（日常办公 / 代码开发 / 设计创意）在**输入框正上方** | **收下位置** —— 与 aide hero 天然同构（`VariantMorning` 本就在输入盒上方居中）；但只做两段 |
| 输入框下方的技能 chips 行 | **不收** —— 对应 aide 的 `/` 技能唤起，是另一个特性，硬塞会把范围搞糊 |
| 按模式写的 placeholder（"今天帮你做些什么？@ 引用对话文件，/ 调用技能与指令"） | **收下** —— 日常要有自己的 placeholder |
| 右下角「⚡ 快速 ⌄」档位药丸 | **已有** —— `effortLabel("low")` 就是"快速"，本次只是让日常默认落在这档 |
