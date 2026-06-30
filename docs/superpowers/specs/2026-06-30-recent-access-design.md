# 最近访问（Recent Access）设计

> 日期：2026-06-30
> 状态：已批准设计，待实现

## 目标

新增「最近访问」功能，包含两类：

- **最近打开的会话**：全局记录用户主动切换到的会话。
- **最近打开的文件**：按工作区隔离记录用户主动打开（预览）的文件。

入口为**命令面板默认页**：打开命令面板且查询框为空时，默认列出最近会话 + 最近文件；输入查询后切换为现有搜索结果。

## 非目标（YAGNI）

- 不做左栏/右栏/标题栏的常驻「最近」区块。
- 不做新建会话时的主动记录（等用户首次切换再记）。
- 不做 rename_session 时同步最近列表中的名称（名称仅展示用，stale 名称为可接受小瑕疵，由下次 list 自愈覆盖）。
- 不做最近项的右键菜单/单独管理界面（仅提供 `clear_recent` 清空能力）。

## 方案选型

采用**方案 A：后端拥有数据与裁剪逻辑**。

Rust 新增 `recent.rs`，独占 `recent.json` 读写 + 去重 + 容量裁剪 + 失效项清理。前端只在触发点调用 `record_recent_*`，在命令面板调用 `list_recent(wsKey)`。

理由：与现有 `settings.rs`/`workspace.rs`「后端管理持久化状态」模式一致；裁剪/校验逻辑单点；前端很薄；频繁写隔离在独立 `recent.json`，不冲击主 `config.json`。命令面板默认页通过给 `ACommandPalette` 增加 `recentFn`（空查询时调用）实现，与现有 `searchFn`（非空查询）并行，不污染搜索语义。

已否决方案：

- **方案 B（前端拥有逻辑，后端只存 blob）**：去重/裁剪逻辑散到 TS，启动要加载整张 map，源真在前端内存，与现有后端管状态约定相悖。
- **方案 C（复用 useSearchProviders provider 注册表）**：`search(query)` 语义承载「空查询=最近」是语义错位，且仍需独立记录触发与后端存储，未真正省事。

## 作用域与容量

- **作用域**：会话全局；文件按工作区隔离。
- **容量**：单一设置项 `recent_limit`（默认 10），同时用于会话与文件两类；可在设置面板配置（范围 1–50）。文件按工作区独立裁剪（每个工作区各自保留 N 条）。

## 持久化

- 文件：`~/.claude-code-desktop/recent.json`（`our_config_dir()` 下，与 `config.json` 同目录）。
- 内存缓存：`static RECENT: Lazy<Mutex<RecentState>>`，首次访问从 `recent.json` 加载（缺失/损坏取 `Default`）。
- 并发：所有 record/list/remove 命令走 `lock → 改 → 写盘`，避免读改写竞态。
- 写盘原子性：先写临时文件再 `fs::rename` 替换，防半写入。

## 数据模型（Rust，`src-tauri/src/commands/recent.rs`）

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct RecentSession {
    pub ws_key: String,
    pub ws_name: String,
    pub session_id: String,
    pub name: String,
    pub ts: u64, // 毫秒时间戳，最后访问时间（与 Session.timestamp / timeAgo 一致）
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RecentFile {
    pub path: String, // 绝对路径
    pub name: String,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct RecentState {
    pub sessions: Vec<RecentSession>,                                 // 全局，按 session_id 去重
    pub files: std::collections::HashMap<String, Vec<RecentFile>>,   // 按 ws_key 隔离
}

// list_recent 返回给前端的视图（不带 HashMap）
pub struct RecentView {
    pub sessions: Vec<RecentSession>,
    pub files: Vec<RecentFile>,
}
```

文件用 `HashMap<ws_key, Vec>`：文件按工作区隔离，每个工作区独立裁剪到 N 条、独立展示。会话全局唯一，扁平 `Vec`。

## 后端命令（注册到 `lib.rs`）

| 命令 | 入参 | 作用 |
|---|---|---|
| `record_recent_session` | `ws_key, ws_name, session_id, name` | 按 `session_id` 去重：已存在则移到队首并更新 `name/ws_*/ts`，否则 unshift；裁剪到 `recent_limit`。 |
| `record_recent_file` | `ws_key, path, name` | 在 `files[ws_key]` 内按 `path` 去重，移到队首/更新 `ts`；裁剪到 `recent_limit`。 |
| `list_recent` | `ws_key` | 返回 `RecentView { sessions, files }`：`files` 取 `files[ws_key]`；同时做失效清理（见下）。 |
| `remove_recent_session` | `session_id` | 删除匹配项（`delete_session` 流程调用）。 |
| `clear_recent` | `category: Option<String>` | `"sessions"` / `"files"` / `None`（全部）清空。 |

**容量来源**：从主 `config.json` 的 `settings.recent_limit` 读取（默认 10）。record 时按此裁剪；改设置后下一次 record/list 顺带修剪超容项。

**失效清理（在 `list_recent` 内做，若 state 变化则写回）**：

- 会话：`find_session_jsonl_globally(session_id)` 为空 → 剔除。
- 文件：`Path::new(path).metadata()` 失败 → 剔除。
- 让「最近」自愈：删会话/移走文件后，下次开面板自动消失。

**纯函数可测化**：去重/裁剪/清理抽成纯函数，命令函数只做 IO：

```rust
fn push_session(state: &mut RecentState, e: RecentSession, limit: usize);
fn push_file(state: &mut RecentState, ws_key: &str, e: RecentFile, limit: usize);
fn prune_stale(state: &mut RecentState, ws_key: &str) -> bool; // 返回是否有变化
```

**`delete_session` 集成**：`session.rs::delete_session` 成功后调用 `remove_recent_session(id)`，双保险配合 `list_recent` 自愈。

**`api.ts` 封装**：新增 `recordRecentSession / recordRecentFile / listRecent / removeRecentSession / clearRecent` 类型安全包装。

## 前端 composable（`src/composables/useRecent.ts`，模块级单例）

模块级状态：`sessions`、`files`（readonly ref）、`currentWsKey`、`currentWsName`。

对外方法：

- `refresh()`：调 `api.listRecent(currentWsKey)`，刷新 `sessions`/`files`。
- `recordSession(wsKey, wsName, sessionId, name)`：显式传 ws（跨工作区选择会话时记录其所属工作区）；调 api 后 `refresh`。
- `recordFile(path, name)`：用 `currentWs`；`currentWsKey` 为空则跳过；调 api 后 `refresh`。
- `setCurrentWs(wsKey, wsName)`：App.vue 在 workspace 切换/初始确定时调用，并 `refresh`。
- `clear(category?)`。

**为什么 `recordFile` 用 `currentWs`、`recordSession` 显式传 ws**：文件按工作区隔离，打开总在当前工作区上下文；会话全局，跨工作区选择时要记录该会话所属工作区。

**记录触发点（两处用户主动访问的 chokepoint）**：

1. **会话**：`SidebarLeft.selectSessionFromWorkspace(wsKey, sessionId)` 内，查 `workspaces` 拿 `wsName` 后调 `recordSession`。该函数同时是侧栏点击与 TitleBar `select-session`（App.vue 走同一 handler）的汇聚点，**一处埋点覆盖两条路径**。新建会话不主动记录，等首次切换再记，避免占位 `new_xxx` 污染。
2. **文件**：`useFileViewer.open(path)` 内，成功设置 `filePath` 后调 `useRecent().recordFile(path, basename)`。这是所有文件打开路径（文件树、命令面板文件搜索、变更面板 diff 跳转、`openAndScrollTo`）的唯一汇聚点。`recordFile` 失败静默，不影响打开主流程。

**`setCurrentWs` 调用点**：App.vue 现有 workspace 切换逻辑（`setWorkspace` 后 / `onMounted` 确定初始 ws 后）。

**依赖方向**：`useFileViewer` 单向 import `useRecent`；`useRecent` 不 import `useFileViewer`，避免循环依赖。

## 命令面板默认页 UI（`ACommandPalette.vue`）

- 新增 `recentFn`：面板打开且查询框为空时调用它填充结果；输入查询后切换回现有 `searchFn`，搜索行为不变。
- 空查询展示两个分组：「最近会话」「最近文件」，各按 `useRecent` 的 `sessions`/`files` 渲染，最多 `recent_limit` 条。
- 每项：图标（📝 会话 / 📄 文件，沿用现有 provider 习惯）+ 主标签（会话名/文件名）+ 副描述（工作区名或相对路径 +「x 分钟前」）。
- 点击行为：
  - 会话 → `selectSessionFromWorkspace(wsKey, sessionId)`（跨工作区自动切换）。
  - 文件 → `useFileViewer.open(path)`（展示文件均属当前工作区，直接打开）。
  - 点击同时触发 record，置顶。
- 列表为空：一行 muted 占位「暂无最近访问」。
- `timeAgo` 抽到 `src/utils/time.ts` 共享，新代码与 `SidebarLeft` 都用它（顺手消重）。

## 设置项

- `AppSettings` 新增 `recent_limit: u32`（默认 10），走现有 serde default 机制。
- `SettingsPanel` 通用页加数字输入「最近访问保留条数」（1–50），改动即 `updateSettings`。
- 后端 record 命令读此值裁剪。

## 测试与验证

- **后端单测**：`push_session`/`push_file` 的去重 + 裁剪、`prune_stale` 的失效清理，用 temp dir 模拟（仿 `mod.rs` 既有测试风格）。
- **前端**：依赖手动验证。
- **验证清单**：
  1. 开面板看空态占位。
  2. 切会话/开文件后再开面板，看排序与置顶。
  3. 点最近项跳转正确（含跨工作区会话）。
  4. 重启后列表保留。
  5. 改 `recent_limit` 后裁剪生效。
  6. 删会话/移走文件后最近列表自愈。

## 涉及文件

新增：
- `src-tauri/src/commands/recent.rs`
- `src/composables/useRecent.ts`
- `src/utils/time.ts`

修改：
- `src-tauri/src/commands/mod.rs`（`pub mod recent;`）
- `src-tauri/src/lib.rs`（注册 5 个命令）
- `src-tauri/src/commands/settings.rs`（`recent_limit` 字段 + default）
- `src-tauri/src/commands/session.rs`（`delete_session` 调 `remove_recent_session`）
- `src/api.ts`（5 个封装）
- `src/types.ts`（`RecentSession`/`RecentFile`/`RecentView` 类型）
- `src/composables/useFileViewer.ts`（`open` 内埋点 `recordFile`）
- `src/components/SidebarLeft.vue`（`selectSessionFromWorkspace` 内埋点 `recordSession`；`timeAgo` 改用共享 util）
- `src/components/SettingsPanel.vue`（`recent_limit` 输入）
- `src/ui/ACommandPalette.vue`（`recentFn` + 空查询默认页）
- `src/App.vue`（workspace 切换时 `setCurrentWs` + 把 `recentFn` 接入面板）