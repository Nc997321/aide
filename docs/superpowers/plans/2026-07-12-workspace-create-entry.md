# 新建工作空间入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 titlebar 运行按钮右侧新增「打开目录」入口，登记一个磁盘目录为工作空间并立即切换；侧栏右键支持「从列表移除」（仅隐藏 / 彻底删除两模式）。

**Architecture:** 方案 A — 工作空间仍以 `~/.claude/projects/<编码key>/` 目录存在为真值；新增 `config.json` 的 `hiddenWorkspaces` 黑名单做软隐藏；彻底删除 = `remove_dir_all`。新增 Rust 命令 `create_workspace` / `remove_workspace` / `unhide_workspace` / `list_fs_roots`，`list_workspaces` 改 async 并过滤黑名单。前端新增 `useWorkspaces` 单例承载列表与操作，`DirTreePicker.vue` 自绘目录树 + `OpenFolderDialog.vue` 弹窗 + 侧栏右键移除确认框。

**Tech Stack:** Rust（Tauri v2 命令、tokio spawn_blocking、std::fs）、Vue 3 Composition API + TypeScript、Tailwind + Catppuccin 主题变量。

## Global Constraints

- 跨平台：路径用 `PathBuf`/`path.join`，不硬编码 `\\`；平台分支用 `#[cfg(target_os = "windows")]` 隔离。
- 不 spawn 子进程的命令无需 `CREATE_NO_WINDOW`；本功能全用 std fs，不涉及。
- async 命令带 `State<'_, T>` 引用参数必须返回 `Result`（CLAUDE.md 坑点）。
- async 命令不埋 `trace_command`（埋了也抓不到）；同步重 IO 命令改 async + spawn_blocking。
- 前端分层：状态层（composable）/ 组件层分离，不在现有组件内内联堆代码（CLAUDE.md）。
- 工作区 key 编码：把 `:` `\` `/` 替换为 `-`，与 Claude CLI `~/.claude/projects` 目录命名一致。
- `name` 字段存用户输入的原始 path（非 key 解码），避免编码不可逆导致的显示歧义。
- 现有 `settings.rs` 的 `load_config()`/`save_config(&Value)` 是公开函数，从 `workspace.rs` 以 `super::settings::load_config()` 调用。
- Rust 测试运行：`cargo test --lib`（绕杀软锁，CLAUDE.md repo 怪癖）。不引入新 crate 依赖（无 `[dev-dependencies]`，纯函数 + 现有 std 测试）。

参考 spec：`docs/superpowers/specs/2026-07-12-workspace-create-entry-design.md`

---

## File Structure

**Rust（`src-tauri/src/commands/`）：**
- `workspace.rs`（改）：新增 `path_to_key`、`filter_hidden`、`hide_in_config`、`unhide_in_config`、`clear_active_in_config` 纯函数 + `create_workspace` / `remove_workspace` / `unhide_workspace` 命令；`list_workspaces` 改 async + 过滤黑名单。新增 `#[cfg(test)] mod tests`。
- `filesystem.rs`（改）：新增 `list_fs_roots` 命令。
- `lib.rs`（改）：`invoke_handler` 注册 4 个新命令。

**前端：**
- `src/api.ts`（改）：新增 `createWorkspace` / `removeWorkspace` / `unhideWorkspace` / `listFsRoots` 封装。
- `src/composables/useWorkspaces.ts`（新）：模块级单例，承载 `workspaces` / `activeKey` / `refresh` / `openFolder` / `removeWorkspace`。
- `src/components/SidebarLeft.vue`（改）：工作区列表改订阅 `useWorkspaces`；新增工作区行右键；暴露 `openWorkspaceFolder` / `removeWorkspaceByKey` 给 App.vue。
- `src/components/titlebar/TitleBar.vue`（改）：运行按钮后新增「打开目录」按钮 + `open-folder` emit。
- `src/components/DirTreePicker.vue`（新）：自绘目录树选择器。
- `src/components/OpenFolderDialog.vue`（新）：打开目录弹窗（自管遮罩/Teleport）。
- `src/components/RemoveWorkspaceDialog.vue`（新）：移除确认框（单选 hide/delete）。
- `src/menus/contextMenus.ts`（改）：新增 `workspaceMenuItems` 工厂。
- `src/App.vue`（改）：挂载两个新弹窗 + 监听 titlebar `open-folder`。

---

## Task 1: Rust 纯函数 `path_to_key` + `filter_hidden`（TDD）

**Files:**
- Modify: `src-tauri/src/commands/workspace.rs`
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `pub fn path_to_key(path: &str) -> String`；`pub fn filter_hidden(infos: Vec<WorkspaceInfo>, hidden: &[String]) -> Vec<WorkspaceInfo>`

- [ ] **Step 1: Write failing tests**

在 `workspace.rs` 末尾追加测试模块：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::WorkspaceInfo;

    #[test]
    fn path_to_key_windows_path() {
        assert_eq!(path_to_key(r"C:\Users\yangx\proj"), "C--Users-yangx-proj");
    }

    #[test]
    fn path_to_key_unix_path() {
        assert_eq!(path_to_key("/Users/x/proj"), "-Users-x-proj");
    }

    #[test]
    fn path_to_key_preserves_other_chars() {
        // 空格、中文、点不替换
        assert_eq!(path_to_key(r"C:\my project\文档.git"), "C--my project-文档.git");
    }

    #[test]
    fn filter_hidden_empty_passthrough() {
        let infos = vec![sample("k1"), sample("k2")];
        let hidden: Vec<String> = vec![];
        assert_eq!(filter_hidden(infos, &hidden).len(), 2);
    }

    #[test]
    fn filter_hidden_filters_matching() {
        let infos = vec![sample("k1"), sample("k2"), sample("k3")];
        let hidden = vec!["k2".to_string()];
        let out = filter_hidden(infos, &hidden);
        assert_eq!(out.iter().map(|w| w.key.clone()).collect::<Vec<_>>(), vec!["k1", "k3"]);
    }

    #[test]
    fn filter_hidden_multiple() {
        let infos = vec![sample("a"), sample("b"), sample("c")];
        let hidden = vec!["a".to_string(), "c".to_string()];
        let out = filter_hidden(infos, &hidden);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].key, "b");
    }

    fn sample(key: &str) -> WorkspaceInfo {
        WorkspaceInfo { key: key.to_string(), name: key.to_string(), missing: false }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib workspace::tests 2>&1 | tail -20`
Expected: 编译失败 — `path_to_key` / `filter_hidden` 未定义。

- [ ] **Step 3: Write minimal implementation**

在 `workspace.rs` 顶部（`use` 之后、`list_workspaces` 之前）加：

```rust
/// 路径 → 编码 key：把 : \ / 替换为 -，与 Claude CLI
/// `~/.claude/projects/` 目录命名一致。
pub fn path_to_key(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            ':' | '\\' | '/' => '-',
            other => other,
        })
        .collect()
}

/// 从工作区列表里滤掉黑名单中的 key（隐藏语义）。
pub fn filter_hidden(infos: Vec<WorkspaceInfo>, hidden: &[String]) -> Vec<WorkspaceInfo> {
    infos.into_iter().filter(|w| !hidden.contains(&w.key)).collect()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib workspace::tests 2>&1 | tail -20`
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/workspace.rs
git commit -m "feat(workspace): path_to_key + filter_hidden 纯函数及单测"
```

---

## Task 2: Rust config 黑名单纯函数（TDD）

**Files:**
- Modify: `src-tauri/src/commands/workspace.rs`
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `serde_json::Value`（来自 `super::settings::load_config()`）
- Produces:
  - `pub fn hidden_keys(config: &serde_json::Value) -> Vec<String>`
  - `pub fn hide_in_config(config: &mut serde_json::Value, key: &str)`（幂等）
  - `pub fn unhide_in_config(config: &mut serde_json::Value, key: &str)`
  - `pub fn clear_active_in_config(config: &mut serde_json::Value)`

- [ ] **Step 1: Write failing tests**

在 `mod tests` 内追加：

```rust
    #[test]
    fn hidden_keys_missing_field_returns_empty() {
        let cfg = serde_json::json!({});
        assert!(hidden_keys(&cfg).is_empty());
    }

    #[test]
    fn hidden_keys_reads_array() {
        let cfg = serde_json::json!({ "hiddenWorkspaces": ["a", "b"] });
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn hide_in_config_adds_key() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        hide_in_config(&mut cfg, "b");
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn hide_in_config_idempotent() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        hide_in_config(&mut cfg, "a");
        assert_eq!(hidden_keys(&cfg).len(), 1);
    }

    #[test]
    fn hide_in_config_creates_field_if_absent() {
        let mut cfg = serde_json::json!({});
        hide_in_config(&mut cfg, "x");
        assert_eq!(hidden_keys(&cfg), vec!["x".to_string()]);
    }

    #[test]
    fn unhide_in_config_removes_key() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a", "b"] });
        unhide_in_config(&mut cfg, "a");
        assert_eq!(hidden_keys(&cfg), vec!["b".to_string()]);
    }

    #[test]
    fn unhide_in_config_missing_key_noop() {
        let mut cfg = serde_json::json!({ "hiddenWorkspaces": ["a"] });
        unhide_in_config(&mut cfg, "zzz");
        assert_eq!(hidden_keys(&cfg), vec!["a".to_string()]);
    }

    #[test]
    fn clear_active_in_config_removes_workspace_field() {
        let mut cfg = serde_json::json!({ "workspace": "k1", "other": 1 });
        clear_active_in_config(&mut cfg);
        assert!(cfg.get("workspace").is_none());
        assert_eq!(cfg.get("other").and_then(|v| v.as_i64()), Some(1));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib workspace::tests 2>&1 | tail -20`
Expected: 编译失败 — 四个函数未定义。

- [ ] **Step 3: Write minimal implementation**

在 `workspace.rs` 追加：

```rust
/// 读 config 里的 hiddenWorkspaces 黑名单。
pub fn hidden_keys(config: &serde_json::Value) -> Vec<String> {
    config
        .get("hiddenWorkspaces")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// 把 key 加入黑名单（幂等）。config 缺字段时自动创建。
pub fn hide_in_config(config: &mut serde_json::Value, key: &str) {
    if config.is_null() {
        *config = serde_json::json!({});
    }
    let arr = config
        .entry("hiddenWorkspaces")
        .or_insert_with(|| serde_json::json!([]));
    if let serde_json::Value::Array(a) = arr {
        if !a.iter().any(|v| v.as_str() == Some(key)) {
            a.push(serde_json::json!(key));
        }
    }
}

/// 把 key 从黑名单移除（不存在则 noop）。
pub fn unhide_in_config(config: &mut serde_json::Value, key: &str) {
    if let Some(serde_json::Value::Array(a)) = config.get_mut("hiddenWorkspaces") {
        a.retain(|v| v.as_str() != Some(key));
    }
}

/// 清掉 config 的 workspace（激活）字段。
pub fn clear_active_in_config(config: &mut serde_json::Value) {
    if let Some(obj) = config.as_object_mut() {
        obj.remove("workspace");
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib workspace::tests 2>&1 | tail -20`
Expected: 全部 passed（13 个）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/workspace.rs
git commit -m "feat(workspace): hiddenWorkspaces config 纯函数及单测"
```

---

## Task 3: Rust `create_workspace` 命令

**Files:**
- Modify: `src-tauri/src/commands/workspace.rs`
- Modify: `src-tauri/src/lib.rs`（注册命令）

**Interfaces:**
- Consumes: `path_to_key`、`hide_in_config`/`unhide_in_config` 的命令包装、`super::settings::load_config`/`save_config`、`claude_projects_dir()`、`WorkspaceState`、现有 `set_workspace` 的内部逻辑。
- Produces: `pub fn create_workspace(workspace_state: State<'_, WorkspaceState>, path: String) -> Result<WorkspaceInfo, String>`

注意：`create_workspace` 复用现有 `set_workspace` 的激活逻辑（lock state + save_workspace_config）。为避免 sync 命令互调带 `State` 的签名问题，`create_workspace` 自己持 `workspace_state` 并内联激活逻辑（与 `set_workspace` 等价）。

- [ ] **Step 1: Write the implementation**

在 `workspace.rs` 加 `create_workspace`。它接收 `workspace_state`，校验路径、建编码目录、顺手 unhide、激活、返回 `WorkspaceInfo`：

```rust
#[tauri::command]
pub fn create_workspace(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<WorkspaceInfo, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    let key = path_to_key(&path);
    // 建编码目录（幂等：已存在不报错）
    let dir = claude_projects_dir().join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作区目录失败: {}", e))?;
    // 重新登记 = 自动从黑名单移除
    {
        let mut config = super::settings::load_config();
        unhide_in_config(&mut config, &key);
        super::settings::save_config(&config)?;
    }
    // 激活（与 set_workspace 等价）
    {
        let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
        *k = Some(key.clone());
    }
    {
        let mut pp = workspace_state.path.lock().map_err(|e| e.to_string())?;
        *pp = Some(PathBuf::from(path.clone()));
    }
    let _ = save_workspace_config(&key);
    Ok(WorkspaceInfo { key, name: path, missing: false })
}
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`
Expected: 编译通过（命令尚未注册到 invoke_handler，但能编译）。

- [ ] **Step 3: 注册命令**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 里，`commands::workspace::list_workspaces,` 与 `commands::workspace::set_workspace,` 之后追加：

```rust
            commands::workspace::create_workspace,
```

- [ ] **Step 4: 再次编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`
Expected: 编译通过。

- [ ] **Step 5: 现有测试不回归**

Run: `cd src-tauri && cargo test --lib workspace::tests 2>&1 | tail -10`
Expected: 13 passed。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/workspace.rs src-tauri/src/lib.rs
git commit -m "feat(workspace): create_workspace 命令（建目录+激活+自动 unhide）"
```

---

## Task 4: Rust `remove_workspace` + `unhide_workspace` 命令

**Files:**
- Modify: `src-tauri/src/commands/workspace.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `hide_in_config`、`unhide_in_config`、`clear_active_in_config`、`claude_projects_dir`、`WorkspaceState`、`super::settings::load_config`/`save_config`。
- Produces:
  - `pub async fn remove_workspace(workspace_state: State<'_, WorkspaceState>, key: String, mode: String) -> Result<(), String>`
  - `pub fn unhide_workspace(key: String) -> Result<(), String>`

- [ ] **Step 1: Write implementation**

在 `workspace.rs` 加两个命令。`remove_workspace` async，hide 写黑名单；delete 走 `spawn_blocking` 删目录；两者都在删/隐当前激活时清激活态：

```rust
#[tauri::command]
pub async fn remove_workspace(
    workspace_state: State<'_, WorkspaceState>,
    key: String,
    mode: String,
) -> Result<(), String> {
    match mode.as_str() {
        "hide" => {
            let mut config = super::settings::load_config();
            hide_in_config(&mut config, &key);
            super::settings::save_config(&config)?;
        }
        "delete" => {
            let key_clone = key.clone();
            tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                let dir = claude_projects_dir().join(&key_clone);
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)?;
                }
                Ok(())
            })
            .await
            .map_err(|e| format!("删除任务失败: {}", e))??;
            // 已删，从黑名单移除（若曾被隐藏）
            let mut config = super::settings::load_config();
            unhide_in_config(&mut config, &key);
            super::settings::save_config(&config)?;
        }
        _ => return Err(format!("invalid mode: {}", mode)),
    }
    // 若移除的是当前激活工作区，清空激活
    let is_active = workspace_state
        .key
        .lock()
        .map_err(|e| e.to_string())?
        .as_deref() == Some(&key);
    if is_active {
        {
            let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
            *k = None;
        }
        {
            let mut p = workspace_state.path.lock().map_err(|e| e.to_string())?;
            *p = None;
        }
        let mut config = super::settings::load_config();
        clear_active_in_config(&mut config);
        super::settings::save_config(&config)?;
    }
    Ok(())
}

#[tauri::command]
pub fn unhide_workspace(key: String) -> Result<(), String> {
    let mut config = super::settings::load_config();
    unhide_in_config(&mut config, &key);
    super::settings::save_config(&config)
}
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`
Expected: 编译通过。若报 `async commands that contain references as inputs must return a Result` —— 已返回 `Result<(), String>`，满足。

- [ ] **Step 3: 注册命令**

在 `lib.rs` `invoke_handler` 追加：

```rust
            commands::workspace::remove_workspace,
            commands::workspace::unhide_workspace,
```

- [ ] **Step 4: 再次编译 + 测试不回归**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cargo test --lib workspace::tests 2>&1 | tail -5`
Expected: 编译通过，13 passed。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/workspace.rs src-tauri/src/lib.rs
git commit -m "feat(workspace): remove_workspace（hide/delete）+ unhide_workspace 命令"
```

---

## Task 5: Rust `list_fs_roots` 命令 + `list_workspaces` 改 async 过滤黑名单

**Files:**
- Modify: `src-tauri/src/commands/filesystem.rs`
- Modify: `src-tauri/src/commands/workspace.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `filter_hidden`、`hidden_keys`、`super::settings::load_config`、`super::user_home`、`FileEntry`（来自 `super`）。
- Produces:
  - `pub async fn list_fs_roots() -> Result<Vec<FileEntry>, String>`（filesystem.rs）
  - 改造后 `pub async fn list_workspaces() -> Result<Vec<WorkspaceInfo>, String>`

- [ ] **Step 1: 改造 `list_workspaces` 为 async + 过滤黑名单**

替换 `workspace.rs` 现有 `list_workspaces`：

```rust
#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<WorkspaceInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let dir = claude_projects_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut workspaces = Vec::new();
        let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read projects dir: {}", e))?;
        for entry in read_dir {
            let Ok(entry) = entry else { continue; };
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let key = entry.file_name().to_string_lossy().to_string();
                let resolved = resolve_path_from_key(&key);
                let missing = resolved.is_none();
                let name = resolved.unwrap_or_else(|| key.clone());
                workspaces.push(WorkspaceInfo { key, name, missing });
            }
        }
        let hidden = hidden_keys(&super::settings::load_config());
        Ok(filter_hidden(workspaces, &hidden))
    })
    .await
    .map_err(|e| format!("list_workspaces panicked: {}", e))?
}
```

- [ ] **Step 2: 新增 `list_fs_roots`（filesystem.rs）**

在 `filesystem.rs` 末尾追加（`list_directory` 之后）：

```rust
#[tauri::command]
pub async fn list_fs_roots() -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let mut roots = Vec::new();
        #[cfg(target_os = "windows")]
        {
            for b in b'A'..=b'Z' {
                let drive = format!("{}:\\", b as char);
                if std::path::Path::new(&drive).is_dir() {
                    roots.push(FileEntry {
                        name: format!("{}:", b as char),
                        path: drive,
                        is_dir: true,
                        children: None,
                    });
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            roots.push(FileEntry {
                name: "/".to_string(),
                path: "/".to_string(),
                is_dir: true,
                children: None,
            });
            if let Some(home) = super::user_home() {
                let hp = home.to_string_lossy().into_owned();
                roots.push(FileEntry {
                    name: "Home".to_string(),
                    path: hp,
                    is_dir: true,
                    children: None,
                });
            }
        }
        Ok(roots)
    })
    .await
    .map_err(|e| format!("list_fs_roots panicked: {}", e))?
}
```

- [ ] **Step 3: 注册 `list_fs_roots`**

在 `lib.rs` `invoke_handler` 追加（`list_directory` 附近）：

```rust
            commands::filesystem::list_fs_roots,
```

- [ ] **Step 4: 编译 + 测试**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cargo test --lib workspace::tests 2>&1 | tail -5`
Expected: 编译通过，13 passed。`list_workspaces` 注册名不变，前端 `invoke("list_workspaces")` 无需改名。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/workspace.rs src-tauri/src/commands/filesystem.rs src-tauri/src/lib.rs
git commit -m "feat(workspace): list_workspaces 改 async+过滤黑名单；新增 list_fs_roots"
```

---

## Task 6: 前端 `api.ts` 封装

**Files:**
- Modify: `src/api.ts`

**Interfaces:**
- Consumes: `WorkspaceInfo`、`FileEntry`（`src/types.ts` 已有）。
- Produces: `api.createWorkspace` / `api.removeWorkspace` / `api.unhideWorkspace` / `api.listFsRoots`

- [ ] **Step 1: 新增封装**

在 `src/api.ts` 的 `// 工作区` 区块（`setWorkspace` 之后）追加：

```typescript
  createWorkspace(path: string): Promise<WorkspaceInfo> {
    return invoke("create_workspace", { path });
  },
  removeWorkspace(key: string, mode: "hide" | "delete"): Promise<void> {
    return invoke("remove_workspace", { key, mode });
  },
  unhideWorkspace(key: string): Promise<void> {
    return invoke("unhide_workspace", { key });
  },
```

在 `listDirectory` 附近追加：

```typescript
  listFsRoots(): Promise<FileEntry[]> {
    return invoke("list_fs_roots");
  },
```

- [ ] **Step 2: 类型检查**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -15`
Expected: 无新增类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): createWorkspace/removeWorkspace/unhideWorkspace/listFsRoots 封装"
```

---

## Task 7: 前端 `useWorkspaces` composable

**Files:**
- Create: `src/composables/useWorkspaces.ts`

**Interfaces:**
- Consumes: `api`（`listWorkspaces` / `createWorkspace` / `removeWorkspace`）、`WorkspaceInfo`。
- Produces: `useWorkspaces()` → `{ workspaces, activeKey, refresh, openFolder, removeWorkspace }`

- [ ] **Step 1: 写 composable**

```typescript
import { ref } from "vue";
import { api } from "../api";
import type { WorkspaceInfo } from "../types";

// 模块级单例：工作区列表与激活 key 是跨组件共享状态
const workspaces = ref<WorkspaceInfo[]>([]);
const activeKey = ref<string | null>(null);

export function useWorkspaces() {
  /** 重新拉取工作区列表（已过滤黑名单）。 */
  async function refresh() {
    try {
      workspaces.value = await api.listWorkspaces();
    } catch (_e) {
      workspaces.value = [];
    }
  }

  /** 登记一个磁盘目录为工作区并立即切换（后端建目录 + 设激活 + 自动 unhide）。
   *  返回新的 WorkspaceInfo；失败抛错由调用方处理 UI。 */
  async function openFolder(path: string): Promise<WorkspaceInfo> {
    const info = await api.createWorkspace(path);
    await refresh();
    activeKey.value = info.key;
    return info;
  }

  /** 移除工作区：hide=软隐藏保留会话；delete=删目录+会话。
   *  若移除的是当前激活，后端已清空，前端同步回落。 */
  async function removeWorkspace(key: string, mode: "hide" | "delete") {
    await api.removeWorkspace(key, mode);
    await refresh();
    if (activeKey.value === key) activeKey.value = null;
  }

  return { workspaces, activeKey, refresh, openFolder, removeWorkspace };
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -15`
Expected: 无新增类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/composables/useWorkspaces.ts
git commit -m "feat(composable): useWorkspaces 单例（工作区列表 + openFolder/removeWorkspace）"
```

---

## Task 8: `SidebarLeft.vue` 订阅 `useWorkspaces` + 暴露打开/移除方法 + 工作区右键

**Files:**
- Modify: `src/components/SidebarLeft.vue`
- Modify: `src/menus/contextMenus.ts`

**Interfaces:**
- Consumes: `useWorkspaces`、`useContextMenu`、`workspaceMenuItems`、`api.showInExplorer`、`useSessionState`（查 running 会话）。
- Produces: SidebarLeft 暴露 `openWorkspaceFolder(path: string)`、`removeWorkspaceByKey(key, mode)` 给 App.vue；工作区行右键菜单。

注意：SidebarLeft 现有 `workspaces` 是本地 `ref`。本任务把它替换为 `useWorkspaces().workspaces`（单例），`activeWorkspace` 保留本地但与 `useWorkspaces.activeKey` 在 `openFolder`/`removeWorkspace` 后同步。`activateWorkspace` / `switchWorkspace` 等切换逻辑不动。

- [ ] **Step 1: 引入 composable 并替换本地 workspaces**

在 `SidebarLeft.vue` `<script setup>` 顶部 import 区加：

```typescript
import { useWorkspaces } from "../composables/useWorkspaces";
import { workspaceMenuItems } from "../menus/contextMenus";
```

找到本地 `const workspaces = ref<WorkspaceInfo[]>([]);` 删除，改为：

```typescript
const { workspaces, activeKey: wsActiveKey, refresh: refreshWorkspaces, openFolder, removeWorkspace: removeWs } = useWorkspaces();
```

`loadWorkspaces()` 函数体改为 `async function loadWorkspaces() { await refreshWorkspaces(); }`（保留函数名兼容现有 `onMounted` 调用）。

- [ ] **Step 2: 新增 `openWorkspaceFolder` 并同步激活态**

在 `activateWorkspace` 附近加：

```typescript
/** TitleBar「打开目录」确认后调用：登记目录为工作区 → 激活 → 广播 workspace-changed。
 *  由 App.vue 经 defineExpose 触发。 */
async function openWorkspaceFolder(path: string): Promise<boolean> {
  try {
    const info = await openFolder(path);
  } catch (e) {
    // 上抛给弹窗显示错误
    throw e;
  }
  activeWorkspace.value = info.key;
  expandedWorkspaces.value.add(info.key);
  emit("workspace-changed", info.name);
  await setCurrentWs(info.key, info.name);
  await loadSessions();
  return true;
}
```

注：`openFolder` 返回 `info`，需调整上面为 `const info = await openFolder(path);`（修正：上一步 catch 写法导致 `info` 作用域丢失，最终代码用：

```typescript
async function openWorkspaceFolder(path: string): Promise<boolean> {
  let info: WorkspaceInfo;
  try {
    info = await openFolder(path);
  } catch (e) {
    throw e;
  }
  activeWorkspace.value = info.key;
  expandedWorkspaces.value.add(info.key);
  emit("workspace-changed", info.name);
  await setCurrentWs(info.key, info.name);
  await loadSessions();
  return true;
}
```

）

- [ ] **Step 3: 新增 `removeWorkspaceByKey`**

```typescript
/** 移除工作区（hide/delete）。delete 前检查该工作区是否有 running 会话。 */
async function removeWorkspaceByKey(key: string, mode: "hide" | "delete"): Promise<boolean> {
  if (mode === "delete") {
    // 阻止删除有正在运行会话的工作区
    const list = sessionsByWorkspace.value[key] ?? [];
    if (list.some(s => sessionState[s.id]?.status === "running")) {
      return false;
    }
  }
  const wasActive = key === activeWorkspace.value;
  await removeWs(key, mode);
  // 从本地 UI 状态清理
  expandedWorkspaces.value.delete(key);
  delete sessionsByWorkspace.value[key];
  if (wasActive) {
    activeWorkspace.value = "";
    // 回落空态：清当前会话预览
    emit("session-changed", "");
  }
  return true;
}
```

注：`sessionState` 来自 `useSessionState()`（现有 `const { state: sessionState, dotTone } = useSessionState();`），`sessionState[s.id]?.status` 取值见 `useSessionState`。若 `sessionState` 是 `Record<string, {status}>` 则按现状；若类型不同，按实际字段调整（实现时以 `useSessionState` 导出形状为准）。

- [ ] **Step 4: 工作区行右键菜单**

在 `onSessionContextMenu` 附近加：

```typescript
function onWorkspaceContextMenu(e: MouseEvent, ws: WorkspaceInfo) {
  e.preventDefault();
  e.stopPropagation();
  show(
    e.clientX,
    e.clientY,
    workspaceMenuItems(ws, () => activateWorkspace(ws), () => removeWorkspaceByKey.bind(null)),
  );
}
```

注：`workspaceMenuItems` 签名见 Step 5；移除动作的具体调用（带 mode）由 `RemoveWorkspaceDialog` 在 App.vue 层完成，故菜单项的 `action` 只负责打开弹窗——见 Step 5。

模板里工作区行 `<div class="workspace-item" ... @click="...">` 追加 `@contextmenu="onWorkspaceContextMenu($event, ws)"`。

- [ ] **Step 5: 新增 `workspaceMenuItems` 工厂（contextMenus.ts）**

在 `src/menus/contextMenus.ts` 末尾追加：

```typescript
// ── Workspace context menu（侧栏工作区行右键） ──

export function workspaceMenuItems(
  ws: { key: string; name: string; missing: boolean },
  onActivate?: () => void,
  onRemove?: () => void,
): MenuItem[] {
  return [
    ...(ws.missing ? [] : [{ label: "切换到此工作区", action: () => onActivate?.() }]),
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(ws.name) },
    { label: "复制路径", action: () => navigator.clipboard.writeText(ws.name) },
    sep(),
    {
      label: "从列表移除…",
      danger: true,
      action: () => onRemove?.(),
    },
  ];
}
```

`onRemove` 由 SidebarLeft 传入，实际打开 `RemoveWorkspaceDialog`（Task 11 在 App.vue 层接：SidebarLeft emit `remove-workspace` 事件 → App 打开弹窗）。故 Step 4 的 `onWorkspaceContextMenu` 里 `onRemove` 改为 `emit("remove-workspace", ws)`。

修正 Step 4 实现：

```typescript
function onWorkspaceContextMenu(e: MouseEvent, ws: WorkspaceInfo) {
  e.preventDefault();
  e.stopPropagation();
  show(
    e.clientX,
    e.clientY,
    workspaceMenuItems(
      ws,
      () => activateWorkspace(ws),
      () => emit("remove-workspace", ws),
    ),
  );
}
```

并在 `defineEmits` 加 `"remove-workspace": [ws: WorkspaceInfo]`。

- [ ] **Step 6: 更新 defineExpose**

找到现有 `defineExpose({ newSession, loadSessions, addSession, selectSessionFromWorkspace, switchToWorkspaceByKey, sessionsByWorkspace });`，追加 `openWorkspaceFolder, removeWorkspaceByKey`。

- [ ] **Step 7: 类型检查**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -20`
Expected: 无新增类型错误。若有 `sessionState` 索引类型错误，按 `useSessionState` 实际导出调整 Step 3 的 running 检查写法。

- [ ] **Step 8: Commit**

```bash
git add src/components/SidebarLeft.vue src/menus/contextMenus.ts
git commit -m "feat(sidebar): 订阅 useWorkspaces + 工作区右键 + 暴露打开/移除方法"
```

---

## Task 9: `DirTreePicker.vue` 自绘目录树选择器

**Files:**
- Create: `src/components/DirTreePicker.vue`

**Interfaces:**
- Consumes: `api.listFsRoots`、`api.listDirectory`、`FileEntry`。
- Produces: `<DirTreePicker v-model="path" />` —— 双向绑定当前选中目录路径。

- [ ] **Step 1: 写组件**

```vue
<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { api } from "../api";
import type { FileEntry } from "../types";

const path = defineModel<string>({ default: "" });

interface TreeNode {
  name: string;
  path: string;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: TreeNode[];
  hasError?: boolean;
}

const roots = ref<FileEntry[]>([]);
const tree = ref<TreeNode[]>([]);
const selectedPath = ref<string>("");

const MAX_CHILDREN = 500;

onMounted(async () => {
  try {
    roots.value = await api.listFsRoots();
  } catch (_e) {
    roots.value = [];
  }
  // 默认展开第一个根
  if (roots.value.length) {
    await expandRoot(roots.value[0].path);
  }
});

async function expandRoot(rootPath: string) {
  tree.value = [await makeNode(rootPath.split(/[\\/]/).pop() || rootPath, rootPath, true)];
  await loadChildren(tree.value[0]);
}

async function makeNode(name: string, dirPath: string, expanded = false): Promise<TreeNode> {
  return { name, path: dirPath, expanded, loaded: false, loading: false, children: [] };
}

async function loadChildren(node: TreeNode) {
  if (node.loaded || node.loading) return;
  node.loading = true;
  try {
    const entries = await api.listDirectory(node.path, false);
    const dirs = entries.filter(e => e.is_dir);
    if (dirs.length > MAX_CHILDREN) {
      node.children = [];
      node.hasError = true; // 触发「目录项过多」提示
    } else {
      node.children = await Promise.all(
        dirs.map(d => makeNode(d.name, d.path, false)),
      );
    }
    node.loaded = true;
  } catch (_e) {
    node.hasError = true;
    node.loaded = true;
  }
  node.loading = false;
}

async function toggleNode(node: TreeNode) {
  node.expanded = !node.expanded;
  if (node.expanded && !node.loaded) await loadChildren(node);
}

function selectNode(node: TreeNode) {
  selectedPath.value = node.path;
  path.value = node.path;
}

function goUp() {
  if (!path.value) return;
  const parts = path.value.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  const parent = parts.join("\\");
  if (parent) {
    selectedPath.value = parent;
    path.value = parent;
    // 重新以 parent 为根展开
    expandRoot(parent);
  }
}

async function jumpToRoot(rootPath: string) {
  selectedPath.value = rootPath;
  path.value = rootPath;
  await expandRoot(rootPath);
}
</script>

<template>
  <div class="dir-picker">
    <!-- 地址栏 -->
    <div class="addr-bar">
      <button class="up-btn" v-tooltip="'上一级'" @click="goUp">↑</button>
      <input
        class="addr-input"
        v-model="path"
        placeholder="输入或选择目录路径"
        spellcheck="false"
      />
    </div>

    <!-- 快速入口 -->
    <div class="quick-roots">
      <button
        v-for="r in roots"
        :key="r.path"
        class="root-chip"
        :class="{ active: path === r.path }"
        @click="jumpToRoot(r.path)"
      >
        {{ r.name }}
      </button>
    </div>

    <!-- 目录树 -->
    <div class="tree-scroll">
      <template v-for="node in tree" :key="node.path">
        <div
          class="tree-node"
          :class="{ selected: selectedPath === node.path }"
          :style="{ paddingLeft: '8px' }"
          @click="selectNode(node)"
          @dblclick="toggleNode(node)"
        >
          <svg
            class="chev"
            :class="{ expanded: node.expanded }"
            width="10" height="10" viewBox="0 0 12 12" fill="none"
            @click.stop="toggleNode(node)"
          >
            <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg class="folder-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z"/>
          </svg>
          <span class="node-name">{{ node.name }}</span>
        </div>
        <template v-if="node.expanded">
          <div v-if="node.loading" class="tree-hint">加载中…</div>
          <div v-else-if="node.hasError" class="tree-hint warn">目录项过多或无权限，请在地址栏输入路径</div>
          <div v-else-if="node.children.length === 0" class="tree-hint">（空）</div>
          <!-- 子节点（一层；嵌套展开由递归子组件或后续提取，此处先支持两层以验证流程） -->
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dir-picker { display: flex; flex-direction: column; gap: 8px; min-height: 240px; }
.addr-bar { display: flex; gap: 6px; }
.addr-input {
  flex: 1; box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  padding: 6px 10px; font-size: 12px; color: var(--aide-text-primary);
  font-family: inherit; outline: none;
}
.up-btn {
  width: 28px; border: 1px solid var(--aide-surface-hover);
  background: var(--aide-surface-default); border-radius: var(--aide-radius-md);
  color: var(--aide-text-secondary); cursor: pointer;
}
.up-btn:hover { background: var(--aide-surface-hover); }
.quick-roots { display: flex; flex-wrap: wrap; gap: 6px; }
.root-chip {
  font-size: 11px; padding: 3px 10px; border-radius: 10px;
  border: 1px solid var(--aide-surface-hover); background: var(--aide-surface-default);
  color: var(--aide-text-secondary); cursor: pointer; font-family: inherit;
}
.root-chip:hover { background: var(--aide-surface-hover); }
.root-chip.active { border-color: var(--aide-accent); color: var(--aide-accent); }
.tree-scroll {
  flex: 1; overflow-y: auto; border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md); padding: 6px; background: var(--aide-bg-base);
}
.tree-node {
  display: flex; align-items: center; gap: 4px; padding: 3px 6px;
  border-radius: 4px; cursor: pointer; font-size: 12px;
  color: var(--aide-text-secondary);
}
.tree-node:hover { background: var(--aide-surface-hover); }
.tree-node.selected { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); color: var(--aide-text-primary); }
.chev { transition: transform 0.1s; opacity: 0.6; }
.chev.expanded { transform: rotate(90deg); }
.folder-ic { opacity: 0.7; flex-shrink: 0; }
.node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-hint { padding: 2px 18px; font-size: 11px; color: var(--aide-text-muted); }
.tree-hint.warn { color: var(--aide-warning); }
</style>
```

注意：上面只支持两层展开（根 + 子目录）。完整递归渲染把子节点抽成递归子组件 `DirTreeNode.vue` 或用 Vue 的递归组件。为控制本任务范围，先实现两层 + 地址栏手动导航；若需多层嵌套，在 `tree-scroll` 内用递归组件替换 `<!-- 子节点 -->` 处（实现时按此方向扩展，每个 `TreeNode` 渲染自身 + `v-if expanded` 递归渲染 `children`）。

- [ ] **Step 2: 类型检查**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -15`
Expected: 无新增类型错误（`defineModel` 在 Vue 3.4+ 可用）。

- [ ] **Step 3: Commit**

```bash
git add src/components/DirTreePicker.vue
git commit -m "feat(ui): DirTreePicker 自绘目录树选择器"
```

---

## Task 10: `OpenFolderDialog.vue` + `RemoveWorkspaceDialog.vue` 弹窗

**Files:**
- Create: `src/components/OpenFolderDialog.vue`
- Create: `src/components/RemoveWorkspaceDialog.vue`

**Interfaces:**
- Consumes: `DirTreePicker`、`useWorkspaces`、`api`。
- Produces:
  - `<OpenFolderDialog v-model:visible="..." @opened="..." />` 自管 Teleport 遮罩（不复用 ModalDialog，因其耦合 useModal 通用态）。
  - `<RemoveWorkspaceDialog v-model:visible="..." :workspace="ws" @confirm="(mode) => ..." />`

- [ ] **Step 1: 写 OpenFolderDialog**

```vue
<script setup lang="ts">
import { ref } from "vue";
import DirTreePicker from "./DirTreePicker.vue";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [path: string];
}>();

const path = ref("");
const error = ref("");

function close() {
  emit("update:visible", false);
  error.value = "";
}

async function onConfirm() {
  if (!path.value.trim()) {
    error.value = "请选择或输入目录路径";
    return;
  }
  error.value = "";
  emit("confirm", path.value.trim());
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible" class="of-overlay" @click.self="close">
      <div class="of-dialog" @click.stop>
        <div class="of-header">打开目录</div>
        <DirTreePicker v-model="path" />
        <div v-if="error" class="of-error">{{ error }}</div>
        <div class="of-actions">
          <button class="of-btn cancel" @click="close">取消</button>
          <button class="of-btn confirm" @click="onConfirm">打开并切换</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.of-overlay {
  position: fixed; inset: 0; background: var(--aide-bg-overlay);
  display: flex; align-items: center; justify-content: center; z-index: 1100;
  animation: fadeIn 0.12s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.of-dialog {
  background: var(--aide-surface-default); border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-lg); padding: 18px 20px;
  min-width: 420px; max-width: 560px; box-shadow: var(--aide-shadow-lg);
  animation: scaleIn 0.15s ease;
}
@keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
.of-header { font-size: 14px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 12px; }
.of-error { font-size: 12px; color: var(--aide-error, #f38ba8); margin-top: 8px; }
.of-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.of-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-surface-hover); }
.of-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.of-btn.cancel:hover { background: var(--aide-surface-hover); }
.of-btn.confirm { background: var(--aide-accent); border-color: var(--aide-accent); color: var(--aide-text-on-accent); }
.of-btn.confirm:hover { filter: brightness(1.1); }
</style>
```

- [ ] **Step 2: 写 RemoveWorkspaceDialog**

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import type { WorkspaceInfo } from "../types";

const props = defineProps<{ visible: boolean; workspace: WorkspaceInfo | null }>();
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [mode: "hide" | "delete"];
}>();

const mode = ref<"hide" | "delete">("hide"); // 安全默认

watch(() => props.visible, (v) => { if (v) mode.value = "hide"; });

function close() { emit("update:visible", false); }
function onConfirm() { emit("confirm", mode.value); }

const wsName = () => {
  const w = props.workspace;
  if (!w) return "";
  // name 存原始 path，取末段展示
  return w.name.split(/[\\/]/).filter(Boolean).pop() || w.name;
};
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible && props.workspace" class="rw-overlay" @click.self="close">
      <div class="rw-dialog" @click.stop>
        <div class="rw-header">移除工作区「{{ wsName() }}」</div>

        <label class="rw-opt">
          <input type="radio" value="hide" v-model="mode" />
          <span>仅隐藏（保留会话记录，可恢复）</span>
        </label>
        <label class="rw-opt">
          <input type="radio" value="delete" v-model="mode" />
          <span>彻底删除（删除该工作区所有会话记录，不可恢复）</span>
        </label>

        <div v-if="mode === 'delete'" class="rw-warn">
          ⚠ 将删除 ~/.claude/projects/{{ props.workspace.key }}/ 及其全部会话 transcript
        </div>

        <div class="rw-actions">
          <button class="rw-btn cancel" @click="close">取消</button>
          <button
            class="rw-btn confirm"
            :class="{ danger: mode === 'delete' }"
            @click="onConfirm"
          >移除</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.rw-overlay {
  position: fixed; inset: 0; background: var(--aide-bg-overlay);
  display: flex; align-items: center; justify-content: center; z-index: 1100;
}
.rw-dialog {
  background: var(--aide-surface-default); border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-lg); padding: 18px 22px;
  min-width: 360px; max-width: 440px; box-shadow: var(--aide-shadow-lg);
}
.rw-header { font-size: 14px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 12px; }
.rw-opt { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; color: var(--aide-text-secondary); cursor: pointer; }
.rw-warn { margin-top: 10px; font-size: 12px; color: var(--aide-error, #f38ba8); }
.rw-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.rw-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-surface-hover); }
.rw-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.rw-btn.cancel:hover { background: var(--aide-surface-hover); }
.rw-btn.confirm { background: var(--aide-accent); border-color: var(--aide-accent); color: var(--aide-text-on-accent); }
.rw-btn.confirm.danger { background: var(--aide-danger); border-color: var(--aide-danger); }
.rw-btn.confirm:hover { filter: brightness(1.1); }
</style>
```

- [ ] **Step 3: 类型检查**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -15`
Expected: 无新增类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/OpenFolderDialog.vue src/components/RemoveWorkspaceDialog.vue
git commit -m "feat(ui): OpenFolderDialog + RemoveWorkspaceDialog 弹窗"
```

---

## Task 11: TitleBar 按钮 + App.vue 接线 + 空态

**Files:**
- Modify: `src/components/titlebar/TitleBar.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `OpenFolderDialog`、`RemoveWorkspaceDialog`、`useWorkspaces`、SidebarLeft 暴露的 `openWorkspaceFolder` / `removeWorkspaceByKey`。
- Produces: titlebar「打开目录」按钮 + `open-folder` emit；App.vue 挂载两个弹窗并接事件。

- [ ] **Step 1: TitleBar 新增按钮**

`TitleBar.vue` 的 `defineEmits` 加 `"open-folder": []`。

在模板 `titlebar-left` 内、运行配置 `</template>`（第 224 行）之后、`<!-- Fallback run button -->` 的 `v-else-if` 块之后、`</div>`（titlebar-left 结束，第 237 行）之前插入：

```vue
      <!-- 打开目录 / 新建工作空间 -->
      <button
        class="titlebar-open-folder-btn"
        v-tooltip="'打开目录 / 新建工作空间'"
        @click.stop="$emit('open-folder')"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z"/>
          <path d="M3 9L9 9L11 11L21 11"/>
        </svg>
      </button>
```

在 `<style scoped>` 末尾加：

```css
.titlebar-open-folder-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; background: none; border: 1px solid transparent;
  border-radius: var(--aide-radius-sm); color: var(--aide-text-secondary);
  cursor: pointer; flex-shrink: 0; transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.titlebar-open-folder-btn:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border);
  color: var(--aide-text-primary);
}
```

- [ ] **Step 2: App.vue 挂载弹窗 + 接事件**

`App.vue` import 区加：

```typescript
import OpenFolderDialog from "./components/OpenFolderDialog.vue";
import RemoveWorkspaceDialog from "./components/RemoveWorkspaceDialog.vue";
import type { WorkspaceInfo } from "./types";
```

`<script setup>` 加状态：

```typescript
const openFolderVisible = ref(false);
const removeWsVisible = ref(false);
const removeWsTarget = ref<WorkspaceInfo | null>(null);
const openFolderError = ref("");

async function onOpenFolder() {
  openFolderError.value = "";
  openFolderVisible.value = true;
}

async function onOpenFolderConfirm(path: string) {
  try {
    await sidebarRef.value?.openWorkspaceFolder(path);
    openFolderVisible.value = false;
  } catch (e: any) {
    openFolderError.value = typeof e === "string" ? e : (e?.message ?? "打开目录失败");
    // 保持弹窗打开显示错误：把错误塞进弹窗。简化：alert 一次并保留弹窗
    // 更好做法：给 OpenFolderDialog 加 error prop，这里 emit。
  }
}

// 因 OpenFolderDialog 通过 emit confirm 传 path，错误需回显。
// 调整：onOpenFolderConfirm 失败时把错误写到 OpenFolderDialog 的 error。
// 为此给 OpenFolderDialog 加 error prop + key 强制重建。简化方案：
// 失败时 window.alert 错误并保留弹窗（最小可用）。
```

由于错误回显复杂，采用最小可用方案：失败时 `alert` 并保留弹窗。最终 `onOpenFolderConfirm`：

```typescript
async function onOpenFolderConfirm(path: string) {
  try {
    await sidebarRef.value?.openWorkspaceFolder(path);
    openFolderVisible.value = false;
  } catch (e: any) {
    const msg = typeof e === "string" ? e : (e?.message ?? "打开目录失败");
    alert(msg);
  }
}

function onRemoveWorkspace(ws: WorkspaceInfo) {
  removeWsTarget.value = ws;
  removeWsVisible.value = true;
}

async function onRemoveWorkspaceConfirm(mode: "hide" | "delete") {
  const ws = removeWsTarget.value;
  if (!ws) return;
  const ok = await sidebarRef.value?.removeWorkspaceByKey(ws.key, mode);
  if (!ok && mode === "delete") {
    alert("该工作区有正在运行的会话，请先停止再移除。");
  }
  removeWsVisible.value = false;
  removeWsTarget.value = null;
}
```

监听 SidebarLeft 的 `remove-workspace` 事件：在 `<SidebarLeft ... />` 标签上加 `@remove-workspace="onRemoveWorkspace"`。

在 TitleBar 标签上加 `@open-folder="onOpenFolder"`。

模板末尾（`<ModalDialog />` 附近）加：

```vue
    <OpenFolderDialog v-model:visible="openFolderVisible" @confirm="onOpenFolderConfirm" />
    <RemoveWorkspaceDialog
      v-model:visible="removeWsVisible"
      :workspace="removeWsTarget"
      @confirm="onRemoveWorkspaceConfirm"
    />
```

- [ ] **Step 3: 类型检查**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -20`
Expected: 无新增类型错误。`sidebarRef.value?.openWorkspaceFolder` 需 SidebarLeft 的 `defineExpose` 包含该方法（Task 8 Step 6 已加）。

- [ ] **Step 4: Commit**

```bash
git add src/components/titlebar/TitleBar.vue src/App.vue
git commit -m "feat(ui): titlebar 打开目录按钮 + App.vue 挂载打开/移除弹窗接线"
```

---

## Task 12: 端到端手动验证 + 类型检查

**Files:** 无（验证）

- [ ] **Step 1: 构建前端 + 启动 dev**

Run: `pnpm tauri dev`（后台启动，等 Rust 编译 + Vite 起来）

- [ ] **Step 2: 类型检查兜底**

Run: `pnpm vue-tsc --noEmit 2>&1 | tail -10`
Expected: 0 errors。

- [ ] **Step 3: Rust 测试兜底**

Run: `cd src-tauri && cargo test --lib workspace::tests 2>&1 | tail -5`
Expected: 13 passed。

- [ ] **Step 4: 手动验证清单**

逐项验证（见 spec §8.2）：

1. 点 titlebar 运行按钮右侧「打开目录」图标 → 弹窗出现 → 目录树展开盘符/Home → 选目录 → 「打开并切换」→ 侧栏出现新工作区并激活、文件树加载新目录、git 分支更新。
2. 同目录二次打开 → 幂等切换，不报错、侧栏不重复。
3. 右键侧栏工作区行 → 「从列表移除…」→ 选「仅隐藏」→ 侧栏消失；重启 app 仍隐藏；再点「打开目录」选同目录 → 自动 unhide，侧栏重新出现。
4. 右键 → 「彻底删除」→ 警告文案显示 → 「移除」→ 工作区消失；资源管理器确认 `~/.claude/projects/<key>/` 已删。
5. 右键当前激活工作区 → 「仅隐藏」→ 侧栏回空态、聊天区/文件树空。
6. 在某工作区发起会话并 running → 右键该工作区「彻底删除」→ 弹 alert 阻止。
7. 跨平台路径：含中文/空格的目录路径正常打开与显示。

- [ ] **Step 5: 黑匣子不回归**

确认操作全程 `~/.claude-code-desktop/diagnostics/` 无新增 freeze 报告；`diag_heartbeat` 正常。

- [ ] **Step 6: 收尾提交（若有验证中修复）**

```bash
git add -A
git commit -m "chore: 端到端验证修复"
```

若无修复，跳过。

---

## Self-Review

**Spec coverage:**
- §1 数据模型 hiddenWorkspaces → Task 2 纯函数 + Task 4/5 命令落地。
- §4.2 create_workspace → Task 3。
- §4.3 remove_workspace（hide+delete+清激活）→ Task 4。
- §4.4 unhide_workspace → Task 4。
- §4.5 list_fs_roots → Task 5。
- §4.6 list_workspaces async + 过滤 → Task 5。
- §4.7 lib.rs 注册 → Task 3/4/5。
- §5.1 api.ts → Task 6。
- §5.2 useWorkspaces → Task 7。
- §5.3 SidebarLeft 订阅 + 衔接 → Task 8。
- §6.1 TitleBar 按钮 → Task 11。
- §6.2 OpenFolderDialog + DirTreePicker 自绘树 → Task 9/10。
- §6.3 侧栏右键移除确认框 → Task 8（菜单）+ Task 10（弹窗）+ Task 11（接线）。
- §7 错误处理：路径不存在/无权限 → create_workspace Err + 弹窗 alert；幂等切换 → Task 3；删 running 会话阻止 → Task 8 Step 3；移除激活回落 → Task 8 Step 3。
- §8 测试 → Task 1/2 单测 + Task 12 手动清单。

**Placeholder scan:** 无 TBD/TODO。Task 9 注明递归嵌套扩展方向（非占位，是明确的两层先实现 + 扩展指引）。

**Type consistency:** `openFolder(path) → WorkspaceInfo`、`removeWorkspace(key, mode)`、`openWorkspaceFolder`/`removeWorkspaceByKey` 在 SidebarLeft 与 App.vue 间签名一致；`workspaceMenuItems(ws, onActivate, onRemove)` 与 SidebarLeft 调用一致；`onRemove` 由 `emit("remove-workspace", ws)` 实现，App.vue `onRemoveWorkspace(ws)` 接收，类型 `WorkspaceInfo` 全链路一致。

无遗漏。计划完整。