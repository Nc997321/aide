# 新建工作空间入口 — 设计文档

- 日期：2026-07-12
- 分支：`feat/workspace-create-entry`
- 状态：已通过 brainstorming 评审，待写实现计划

## 1. 背景与目标

当前 Aide 没有「新建/打开工作空间」的入口。工作空间在数据层只是 `~/.claude/projects/<编码key>/` 目录的存在，前端侧栏只能展示/切换已有工作区，用户要把一个新项目目录接入 Aide，没有 UI 可操作。

本设计新增「打开目录 → 登记为工作空间 → 立即切换」的完整入口，以及配套的「从列表移除工作区」能力（支持隐藏与彻底删除两种语义）。

### 已确认的需求

1. **语义**：「新建工作空间」= 选一个已存在的磁盘目录登记为工作空间（VS Code「Open Folder」式），不在磁盘上创建新文件夹、不动文件。
2. **新建入口位置**：titlebar 运行按钮右侧（`titlebar-left` 末尾、中间搜索框之前）。
3. **选中后行为**：立即切换到该工作区（侧栏刷新、文件树加载、codegraph 重建）。
4. **目录选择 UI**：应用内自定义弹窗，贴合 Catppuccin 主题，不弹系统原生对话框；「浏览」走自绘目录树。
5. **管理范围**：新建 + 移除。
6. **移除语义**：同时支持「仅隐藏（保留会话、可恢复）」和「彻底删除（删编码目录 + 全部会话 transcript，不可恢复）」两种，用户在确认框里选。
7. **移除入口**：侧栏工作区行右键菜单 → 「从列表移除…」→ 确认框选模式。

## 2. 架构选型

**选定方案 A**：目录存在即真值 + `config.json` `hiddenWorkspaces` 黑名单。

- 不引入独立 `workspaces.json` 注册表（方案 B），避免改动 `list_workspaces` 的真值来源、牵动 codegraph 重建 / 会话归属 / 侧栏匹配等下游链路，风险过高。
- 隐藏 = 把 key 写入 `config.json` 的 `hiddenWorkspaces` 数组，`list_workspaces` 扫描后过滤；磁盘会话 transcript 全保留，再加回来（从黑名单移除）即恢复。
- 彻底删除 = `fs::remove_dir_all(~/.claude/projects/<key>)`，弹强确认框。

## 3. 数据模型

`~/.claude-code-desktop/config.json` 新增字段：

```json
{
  "workspace": "C--document-owner-cypress-agent",
  "hiddenWorkspaces": ["D--foo-old-project"]
}
```

- `workspace`（已有）：当前激活工作区 key。
- `hiddenWorkspaces`（新增）：隐藏黑名单，`string[]`，元素为编码 key。

`WorkspaceInfo` / `WorkspaceState` 结构体不变。

## 4. Rust 后端

文件：`src-tauri/src/commands/workspace.rs` + `filesystem.rs` + `lib.rs`（注册命令）。

### 4.1 新增编码函数

```rust
/// 路径 → 编码 key（与 Claude CLI ~/.claude/projects 目录命名一致：
/// 把 : \ / 替换为 -）
fn path_to_key(path: &str) -> String {
    path.chars().map(|c| match c {
        ':' | '\\' | '/' => '-',
        _ => c,
    }).collect()
}
```

### 4.2 新增命令 `create_workspace`

```rust
#[tauri::command]
pub fn create_workspace(path: String) -> Result<WorkspaceInfo, String> {
    let key = path_to_key(&path);
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    let dir = claude_projects_dir().join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 顺手从黑名单移除（重新登记 = 自动恢复显示）
    unhide_workspace_inner(&key)?;
    // 切换为激活
    set_workspace(key.clone(), path.clone())?;
    Ok(WorkspaceInfo { key, name: path, missing: false })
}
```

- 单次 mkdir 属轻 IO，保留 sync；如担心杀软扫描，可后续改 async + spawn_blocking，本轮先 sync。
- `name` 字段存用户输入的原始 path（而非 key 解码结果），避免编码不可逆导致的显示歧义。
- 幂等：目录已存在时 `create_dir_all` 不报错，等同切换到已有工作区。

### 4.3 新增命令 `remove_workspace`

```rust
#[tauri::command]
pub async fn remove_workspace(
    key: String,
    mode: String,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    match mode.as_str() {
        "hide" => {
            // 写入 hiddenWorkspaces（幂等）
            hide_workspace_inner(&key)?;
        }
        "delete" => {
            // spawn_blocking 删目录，不堵主线程
            let key_clone = key.clone();
            tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                let dir = claude_projects_dir().join(&key_clone);
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)?;
                }
                Ok(())
            }).await.map_err(|e| e.to_string())??;
            // 同时从黑名单移除（已删，无需隐藏）
            unhide_workspace_inner(&key)?;
        }
        _ => return Err("invalid mode".into()),
    }
    // 若删/隐的是当前激活，清空激活状态
    let current = workspace_state.key.lock().unwrap().clone();
    if current.as_deref() == Some(&key) {
        *workspace_state.key.lock().unwrap() = None;
        *workspace_state.path.lock().unwrap() = None;
        // 清 config.json 的 workspace 字段
        clear_active_workspace_config()?;
    }
    Ok(())
}
```

- async + `State<'_, WorkspaceState>` → 按 CLAUDE.md 坑点，async 命令带引用参数须返回 `Result`（已返回 `Result<(), String>`，满足）。
- `hide_workspace_inner` / `unhide_workspace_inner` / `clear_active_workspace_config` 为模块内辅助函数，供 `create_workspace`（sync）复用。
- 删目录 IO 走 `spawn_blocking`，不埋 `trace_command`（async 命令埋了也抓不到，按 CLAUDE.md 约定不埋）。
- Windows 不 spawn 子进程，无需 `CREATE_NO_WINDOW`；路径全用 `PathBuf::join`。

### 4.4 新增命令 `unhide_workspace`

```rust
#[tauri::command]
pub fn unhide_workspace(key: String) -> Result<(), String> {
    unhide_workspace_inner(&key)
}
```

供侧栏「已隐藏工作区」管理 UI 调用恢复（本轮 UI 不强求，命令先备好）。

### 4.5 新增命令 `list_fs_roots`（filesystem.rs）

```rust
#[tauri::command]
pub async fn list_fs_roots() -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let mut roots = Vec::new();
        #[cfg(target_os = "windows")]
        {
            for c in b'A'..=b'Z' {
                let drive = format!("{}:\\", c as char);
                if std::path::Path::new(&drive).is_dir() {
                    roots.push(FileEntry {
                        name: format!("{}:", c as char),
                        path: drive,
                        is_dir: true,
                        children: None,
                    });
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            roots.push(FileEntry { name: "/".into(), path: "/".into(), is_dir: true, children: None });
            if let Some(home) = dirs::home_dir() {
                let hp = home.to_string_lossy().into_owned();
                roots.push(FileEntry { name: "Home".into(), path: hp.clone(), is_dir: true, children: None });
            }
        }
        Ok(roots)
    }).await.map_err(|e| format!("list_fs_roots panicked: {}", e))?
}
```

### 4.6 改造 `list_workspaces`（同步 → async + 过滤黑名单）

```rust
#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<WorkspaceInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let hidden: Vec<String> = load_config()
            .get("hiddenWorkspaces")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        // ... 现有扫描逻辑 ...
        scan.into_iter().filter(|w| !hidden.contains(&w.key)).collect::<Vec<_>>()
    }).await.map_err(|e| format!("list_workspaces panicked: {}", e))?
}
```

- 按 CLAUDE.md「同步命令禁止重 IO」，本轮顺带把扫目录的 `list_workspaces` 改 async + spawn_blocking，避免工作区变多时主线程阻塞。
- 黑名单过滤抽纯函数 `filter_hidden(infos, hidden)` 便于单测。

### 4.7 `lib.rs` 注册

`invoke_handler` 追加 `create_workspace`、`remove_workspace`、`unhide_workspace`、`list_fs_roots`；`list_workspaces` 改 async 不改注册名。

## 5. 前端 API 与 Composable

### 5.1 `src/api.ts` 新增封装

```typescript
createWorkspace: (path: string) => invoke<WorkspaceInfo>("create_workspace", { path }),
removeWorkspace: (key: string, mode: "hide" | "delete") =>
  invoke<void>("remove_workspace", { key, mode }),
unhideWorkspace: (key: string) => invoke<void>("unhide_workspace", { key }),
listFsRoots: () => invoke<FileEntry[]>("list_fs_roots"),
```

### 5.2 新建 composable `src/composables/useWorkspaces.ts`

模块级 reactive 单例，承载工作区列表状态 + 操作：

```typescript
const workspaces = ref<WorkspaceInfo[]>([]);
const activeKey = ref<string | null>(null);

export function useWorkspaces() {
  async function refresh() { workspaces.value = await api.listWorkspaces(); }
  async function openFolder(path: string): Promise<WorkspaceInfo> {
    const info = await api.createWorkspace(path);  // 后端建目录 + 切换
    await refresh();
    activeKey.value = info.key;
    return info;
  }
  async function removeWorkspace(key: string, mode: "hide" | "delete") {
    await api.removeWorkspace(key, mode);
    await refresh();
    // 若删的是当前激活，后端已清空；前端回落空态
    if (activeKey.value === key) activeKey.value = null;
  }
  return { workspaces, activeKey, refresh, openFolder, removeWorkspace };
}
```

### 5.3 与现有逻辑衔接

- `SidebarLeft.vue` 现 `onMounted` 自己 `loadWorkspaces()` + 匹配激活；改造为订阅 `useWorkspaces` 单例，去掉重复的本地列表状态。
- `workspace-changed` 事件链（App.vue `onSidebarWsChanged` → 刷新文件树/git/codegraph）保持不变；`openFolder` 切换后复用同一条事件链。
- `useSessionWorkspaces` 完全不动：新工作区下首次发消息时 `onSessionCreated` 自然注册到当前激活工作区。

## 6. UI 设计

### 6.1 TitleBar 新建按钮

`src/components/titlebar/TitleBar.vue` 在 `titlebar-left` 末尾（运行按钮组之后、`</div>` 之前）插入：

```vue
<button
  class="titlebar-open-folder-btn"
  v-tooltip="'打开目录 / 新建工作空间'"
  @click.stop="$emit('open-folder')"
>
  <svg width="13" height="13" viewBox="0 0 24 24" ...><!-- 文件夹打开图标 --></svg>
</button>
```

- 新增 emit `"open-folder": []`；App.vue 监听后 `useModal.open("open-folder")`。
- 样式复用 `.titlebar-run-btn` 视觉语言（22×22、无边框、hover 高亮），颜色用 `--aide-text-secondary` 而非 success 色，与运行按钮区分。

### 6.2 打开目录弹窗（应用内自定义，自绘目录树）

**新增 `src/components/DirTreePicker.vue`**（独立可复用纯目录选择器）：
- 顶部地址栏：当前路径面包屑 +「上级」按钮（`path.parent()`）+「刷新」。
- 左侧快速入口：`list_fs_roots` 盘符/根列表 + 最近打开（取自 `useWorkspaces.workspaces`）+ Home。
- 主区树：懒加载，展开节点时调 `list_directory(node.path, false)` → 过滤 `is_dir` → 渲染子节点行。仅目录、不显示文件。
- 单击行 = 选中（高亮 + 地址栏更新）；双击行 = 展开/收起；行尾展开箭头单独控制。
- 大目录保护：单层子节点超阈值（如 500）显示「目录项过多，请在地址栏输入路径」而非卡死渲染。
- 与 `FileTree.vue` 的关系：FileTree 耦合工作区根 + 双击打开文件，不作目录选择器；DirTreePicker 是新组件，可共享 FileTree 的目录行渲染样式（折叠箭头/文件夹图标/缩进）。
- 样式遵守 CLAUDE.md：xterm 之外的普通组件用 scoped 即可；非 scoped 仅限 xterm 动态 DOM。

**新增 `src/components/OpenFolderDialog.vue`**（复用 `ModalDialog.vue` 外壳）整合：

```
┌─ 打开目录 ──────────────────────────────┐
│ 路径: [ C:\my\project          ] [上级] │
├──────────────┬─────────────────────────┤
│ 快速入口      │ 目录树                   │
│  • Home       │  ▸ C:\                   │
│  • C: 盘      │    ▸ Users               │
│  • 最近:      │      ▸ yangx             │
│   cypress-agent│        ▸ document        │
│   my-app      │          ▸ owner  ← 选中  │
├──────────────┴─────────────────────────┤
│           [取消]    [打开并切换]         │
└────────────────────────────────────────┘
```

- 「打开并切换」：校验选中路径存在 → `useWorkspaces.openFolder(path)` → 关弹窗。失败在弹窗内显示错误条不关。
- 「取消」/ 遮罩点击关闭。

### 6.3 侧栏右键移除

复用 `ContextMenu.vue` + `useContextMenu.ts` + `menus/contextMenus.ts`。给 SidebarLeft.vue 工作区行注册右键，菜单项追加「从列表移除…」。点后弹确认框（复用 `ModalDialog.vue`）：

```
┌─ 移除工作区 ──────────────────────┐
│  「cypress-agent」                │
│                                    │
│  ◉ 仅隐藏（保留会话记录，可恢复）  │
│  ○ 彻底删除（删除该工作区所有会话  │
│    记录，不可恢复）                │
│                                    │
│  ⚠ 彻底删除将移除 ~/.claude/       │
│    projects/<编码目录>/ 及其全部   │
│    会话 transcript                 │
│                                    │
│              [取消]  [移除]         │
└────────────────────────────────────┘
```

- 默认选中「仅隐藏」（安全默认）；选「彻底删除」时「移除」按钮变红、警告文案显眼。
- 调 `useWorkspaces.removeWorkspace(key, mode)`。

## 7. 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| 选了不存在的路径 | 后端 `create_workspace` 校验 `path.exists()` → Err；前端弹窗内显示「目录不存在」，不关弹窗 |
| 目录无读/写权限 | `create_dir_all` 失败 → 返回错误串；前端显示「无权限访问该目录」 |
| 该目录已登记 | `create_dir_all` 幂等 → 直接 `set_workspace` 切换；等同切换到已有工作区 |
| 编码 key 不可逆 | `name` 存原始 path 而非 key 解码，避免显示歧义；`path_to_key` 单测覆盖常见路径 |
| 移除当前激活工作区 | 后端清空 `WorkspaceState`（key/path 置 None）+ 清 `config.json` 的 `workspace` 字段；前端 `activeKey=null` 触发空态 |
| 彻底删除但目录里有 running 会话 | 删除前前端检查：若该工作区有 `status===running` 会话，阻止并提示「请先停止该工作区的会话再移除」 |
| `remove_dir_all` 失败（文件被占用/杀软锁） | 返回错误，前端提示「删除失败，可能文件被占用」 |
| 删除后又点新建选回同目录 | 编码目录已删 → `create_dir_all` 重建；create 顺手 unhide（从黑名单移除） |
| 空态：无任何工作区 | 侧栏显示「打开目录开始」引导按钮（指向 titlebar 同款入口）；ChatPanel/文件树显示空态占位 |
| 跨平台路径 | 全用 `PathBuf`/`path.join`；`path_to_key` 对 `/` 和 `\` 都映射 `-` |
| Windows `\\?\` verbatim | 本功能不涉及 `resource_dir()`，不需 `dunce` |

## 8. 测试策略

### 8.1 Rust 单测（`commands/workspace.rs` `#[cfg(test)] mod tests`）

- `path_to_key` 编码：`C:\Users\yangx\proj` → `C--Users-yangx-proj`；`/Users/x/proj` → `-Users-x-proj`；含空格/中文路径保留原字符。
- `path_to_key` 与 `resolve_path_from_key` 往返一致性（在编码可逆的常见路径上）。
- `filter_hidden(infos, hidden)` 纯函数：空黑名单透传、命中过滤、多命中。
- config.json 读写 hiddenWorkspaces：用临时 config 文件（不污染真实 `~/.claude-code-desktop`），测 hide 幂等（重复 hide 同 key 不重复）、unhide 不存在 key 不报错。
- `create_workspace` / `remove_workspace` 集成测：用 `tempfile::TempDir` 模拟 `~/.claude/projects`，断言建目录/删目录/清激活。
- 运行：`cargo test --lib`（按 CLAUDE.md 绕杀软锁的约定）。

### 8.2 前端

- `pnpm vue-tsc --noEmit` 类型检查通过。
- 手动验证清单：
  1. 点 titlebar「打开目录」→ 弹窗 → 自绘树展开盘符/Home/最近 → 选目录 → 「打开并切换」→ 侧栏出现新工作区并激活、文件树加载、codegraph 重建。
  2. 同目录二次打开 → 幂等切换，不报错、不重复。
  3. 右键工作区 → 「从列表移除」→ 「仅隐藏」→ 侧栏消失；重启应用后仍隐藏；再打开同目录 → 自动 unhide 重新出现。
  4. 右键 → 「彻底删除」→ 强确认 → 删除后侧栏消失、`~/.claude/projects/<key>` 目录及会话 jsonl 不存在。
  5. 移除当前激活工作区 → 回落空态占位。
  6. 删除一个正在运行会话的工作区 → 被阻止并提示。
  7. 跨平台：Windows 盘符列表、mac/linux 根+home；路径含中文/空格正常。

### 8.3 回归点

`list_workspaces` 改 async 后，所有调用方（SidebarLeft、useWorkspaces、App 启动）改 `await`，确保不破坏现有工作区切换链路。黑匣子 `diag_heartbeat` 全程正常不冻结。

## 9. 不做的事（YAGNI）

- 不引入 `workspaces.json` 独立注册表（方案 B）。
- 不在设置弹窗加工作空间管理 tab（本轮入口够用）。
- 不做工作区重命名 / 别名 / 图标（将来若需要，再升级到注册表方案）。
- 不做「已隐藏工作区」管理 UI（命令 `unhide_workspace` 先备好，本轮不强制出 UI；重新打开同目录即自动恢复）。
- 不做快捷键 / 命令面板（titlebar 按钮入口足够；将来可加）。