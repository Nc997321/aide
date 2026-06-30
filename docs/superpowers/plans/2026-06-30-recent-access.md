# 最近访问（Recent Access）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在命令面板默认页展示「最近打开的会话」与「最近打开的文件」，后端用 `recent.json` 持久化、按容量裁剪、失效自愈。

**Architecture:** Rust 新增 `recent.rs` 模块独占 `~/.claude-code-desktop/recent.json` 的读写、去重、裁剪与失效清理（纯函数可单测）；前端新增 `useRecent` 单例 composable，在两处用户主动访问的 chokepoint（`selectSessionFromWorkspace`、`useFileViewer.open`）埋点记录；`ACommandPalette` 增加 `recentFn`，空查询时渲染最近列表，非空查询沿用现有搜索。

**Tech Stack:** Tauri v2 (Rust + serde)、Vue 3 Composition API + TypeScript、vitest（前端单测）、cargo test（Rust 单测）。

## Global Constraints

- 容量上限由 `AppSettings.recent_limit`（默认 10）统一控制会话与文件两类；范围 1–50。
- 作用域：会话全局、文件按 `ws_key` 隔离。
- 时间戳单位为**毫秒**（`u64`/`number`），与现有 `Session.timestamp`、`timeAgo` 一致。
- Windows 下任何 `Command::new` 调用须加 `CREATE_NO_WINDOW`——本功能不 spawn 外部进程，无此需求。
- 频繁写隔离在独立 `recent.json`，不写主 `config.json`（容量值除外，走 `set_settings`）。
- Tauri 命令参数：JS 传 camelCase，Rust 收 snake_case（Tauri 自动转换）；返回结构体按 Rust 字段名（snake_case）序列化，前端类型须匹配。
- 所有 commit message 以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。

---

## File Structure

新增：
- `src-tauri/src/commands/recent.rs` — 后端 recent 状态、纯函数、持久化、5 个命令。
- `src/composables/useRecent.ts` — 前端 recent 单例 composable。
- `src/utils/time.ts` — 共享 `timeAgo`。
- `src/utils/time.test.ts` — `timeAgo` 单测。

修改：
- `src-tauri/src/commands/mod.rs` — `pub mod recent;`
- `src-tauri/src/lib.rs` — 注册 5 个 recent 命令。
- `src-tauri/src/commands/settings.rs` — `AppSettings` 新增 `recent_limit`。
- `src-tauri/src/commands/session.rs` — `delete_session` 调 `remove_recent_session`。
- `src/types.ts` — `RecentSession`/`RecentFile`/`RecentView` + `AppSettings.recentLimit`。
- `src/api.ts` — 5 个 recent 封装。
- `src/composables/useSettings.ts` — `load`/`update` 处理 `recentLimit`。
- `src/composables/useFileViewer.ts` — `open` 内埋点 `recordFile`。
- `src/components/SidebarLeft.vue` — `selectSessionFromWorkspace` 埋点 + `setCurrentWs` + `timeAgo` 改用共享 util。
- `src/components/SettingsPanel.vue` — `recent_limit` 输入。
- `src/ui/ACommandPalette.vue` — `recentFn` + 空查询默认页 + 空态。
- `src/App.vue` — 把 `recentFn` 接入面板。

---

### Task 1: 后端 recent.rs 结构体与纯函数（TDD）

**Files:**
- Create: `src-tauri/src/commands/recent.rs`
- Modify: `src-tauri/src/commands/mod.rs:1-15`（在 `pub mod file_assoc;` 后加 `pub mod recent;`）

**Interfaces:**
- Consumes: `super::our_config_dir`（来自 `commands/mod.rs`）、`super::find_session_jsonl_globally`（来自 `commands/mod.rs`）、`super::settings::load_config`（来自 `commands/settings.rs`）。
- Produces: 类型 `RecentSession`/`RecentFile`/`RecentState`/`RecentView`；纯函数 `push_session`、`push_file`、`prune_stale_with`、`prune_stale`；持久化函数 `load_recent_file`、`save_recent_file`；`static RECENT: Lazy<Mutex<RecentState>>`；`fn current_limit() -> usize`；`fn now_ms() -> u64`；`fn recent_path() -> PathBuf`。后续 Task 2 的命令依赖这些。

- [ ] **Step 1: 注册模块**

Edit `src-tauri/src/commands/mod.rs`，在第 14 行 `pub mod file_assoc;` 之后插入：

```rust
pub mod recent;
```

- [ ] **Step 2: 写失败的单测（纯函数）**

Create `src-tauri/src/commands/recent.rs`，先只放测试与最小骨架使其能编译并通过 `cargo test` 的失败路径：

```rust
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{find_session_jsonl_globally, our_config_dir};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RecentSession {
    pub ws_key: String,
    pub ws_name: String,
    pub session_id: String,
    pub name: String,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct RecentState {
    pub sessions: Vec<RecentSession>,
    pub files: HashMap<String, Vec<RecentFile>>,
}

#[derive(Serialize, Clone)]
pub struct RecentView {
    pub sessions: Vec<RecentSession>,
    pub files: Vec<RecentFile>,
}

// ── 纯函数（无 IO，可单测） ──

/// 把会话条目插入队首；按 session_id 去重；裁剪到 limit。
pub fn push_session(state: &mut RecentState, e: RecentSession, limit: usize) {
    state.sessions.retain(|s| s.session_id != e.session_id);
    state.sessions.insert(0, e);
    if state.sessions.len() > limit {
        state.sessions.truncate(limit);
    }
}

/// 在 ws_key 对应列表内插入队首；按 path 去重；裁剪到 limit。
pub fn push_file(state: &mut RecentState, ws_key: &str, e: RecentFile, limit: usize) {
    let list = state.files.entry(ws_key.to_string()).or_default();
    list.retain(|f| f.path != e.path);
    list.insert(0, e);
    if list.len() > limit {
        list.truncate(limit);
    }
}

/// 用外部提供的存活判定函数清理失效会话与当前 ws_key 的失效文件，返回是否有变化。
pub fn prune_stale_with(
    state: &mut RecentState,
    ws_key: &str,
    session_alive: impl Fn(&str) -> bool,
    file_alive: impl Fn(&str) -> bool,
) -> bool {
    let mut changed = false;
    let before = state.sessions.len();
    state.sessions.retain(|s| session_alive(&s.session_id));
    if state.sessions.len() != before {
        changed = true;
    }
    if let Some(list) = state.files.get_mut(ws_key) {
        let b = list.len();
        list.retain(|f| file_alive(&f.path));
        if list.len() != b {
            changed = true;
        }
    }
    changed
}

/// 生产环境清理：会话按 jsonl 是否存在判定，文件按路径 metadata 判定。
pub fn prune_stale(state: &mut RecentState, ws_key: &str) -> bool {
    prune_stale_with(
        state,
        ws_key,
        |id| !find_session_jsonl_globally(id).is_empty(),
        |p| Path::new(p).metadata().is_ok(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(id: &str, ts: u64) -> RecentSession {
        RecentSession {
            ws_key: "k".into(),
            ws_name: "n".into(),
            session_id: id.into(),
            name: id.into(),
            ts,
        }
    }
    fn file(path: &str, ts: u64) -> RecentFile {
        RecentFile { path: path.into(), name: path.into(), ts }
    }

    #[test]
    fn push_session_dedups_and_moves_to_front() {
        let mut st = RecentState::default();
        push_session(&mut st, sess("a", 1), 10);
        push_session(&mut st, sess("b", 2), 10);
        push_session(&mut st, sess("a", 3), 10);
        assert_eq!(st.sessions.len(), 2);
        assert_eq!(st.sessions[0].session_id, "a");
        assert_eq!(st.sessions[0].ts, 3);
    }

    #[test]
    fn push_session_caps_to_limit() {
        let mut st = RecentState::default();
        for i in 0..5 {
            push_session(&mut st, sess(&format!("s{i}"), i), 3);
        }
        assert_eq!(st.sessions.len(), 3);
        assert_eq!(st.sessions[0].session_id, "s4");
    }

    #[test]
    fn push_file_dedups_per_workspace_and_caps() {
        let mut st = RecentState::default();
        push_file(&mut st, "k", file("/a", 1), 2);
        push_file(&mut st, "k", file("/b", 2), 2);
        push_file(&mut st, "k", file("/a", 3), 2);
        let list = st.files.get("k").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "/a");
        assert_eq!(list[0].ts, 3);
    }

    #[test]
    fn push_file_isolates_workspaces() {
        let mut st = RecentState::default();
        push_file(&mut st, "k1", file("/a", 1), 10);
        push_file(&mut st, "k2", file("/b", 2), 10);
        assert_eq!(st.files.get("k1").unwrap().len(), 1);
        assert_eq!(st.files.get("k2").unwrap().len(), 1);
    }

    #[test]
    fn prune_stale_removes_dead_entries() {
        let mut st = RecentState::default();
        push_session(&mut st, sess("alive", 1), 10);
        push_session(&mut st, sess("dead", 2), 10);
        push_file(&mut st, "k", file("/exists", 1), 10);
        push_file(&mut st, "k", file("/gone", 2), 10);
        let changed = prune_stale_with(&mut st, "k", |id| id == "alive", |p| p == "/exists");
        assert!(changed);
        assert_eq!(st.sessions.len(), 1);
        assert_eq!(st.sessions[0].session_id, "alive");
        let list = st.files.get("k").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "/exists");
    }

    #[test]
    fn prune_stale_no_change_returns_false() {
        let mut st = RecentState::default();
        push_session(&mut st, sess("a", 1), 10);
        push_file(&mut st, "k", file("/a", 1), 10);
        let changed = prune_stale_with(&mut st, "k", |_| true, |_| true);
        assert!(!changed);
    }
}
```

- [ ] **Step 3: 运行单测，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml recent::`
Expected: PASS，6 个测试全过（`push_session_dedups_and_moves_to_front`、`push_session_caps_to_limit`、`push_file_dedups_per_workspace_and_caps`、`push_file_isolates_workspaces`、`prune_stale_removes_dead_entries`、`prune_stale_no_change_returns_false`）。

> 说明：本任务直接给出可编译的纯函数实现，测试与实现同时落地；若想严格 TDD，可先只写测试 + 空 `push_session` 等让测试失败再实现。这里因纯函数短小，合并为一步。

- [ ] **Step 4: 补齐持久化与辅助函数（非命令）**

在 `recent.rs` 顶部 import 区与 `prune_stale` 之间（`#[cfg(test)]` 之前）追加：

```rust
// ── 持久化 ──

pub fn recent_path() -> PathBuf {
    our_config_dir().join("recent.json")
}

/// 从磁盘加载；缺失或损坏返回 Default。
pub fn load_recent_file() -> RecentState {
    let p = recent_path();
    if p.exists() {
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<RecentState>(&content) {
                return v;
            }
        }
    }
    RecentState::default()
}

/// 原子写：先写 .tmp 再 rename，防半写入。
pub fn save_recent_file(state: &RecentState) -> Result<(), String> {
    let p = recent_path();
    let dir = p.parent().ok_or_else(|| "recent.json has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ── 内存缓存 ──

static RECENT: Lazy<Mutex<RecentState>> = Lazy::new(|| Mutex::new(load_recent_file()));

// ── 辅助 ──

/// 从主 config.json 读取 recent_limit，默认 10。
pub fn current_limit() -> usize {
    let cfg = super::settings::load_config();
    cfg.get("settings")
        .and_then(|s| s.get("recent_limit"))
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
```

- [ ] **Step 5: 编译检查**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过（可能有 unused 警告，因命令尚未使用 `RECENT`/`current_limit`/`save_recent_file`，下个任务会用掉）。

- [ ] **Step 6: 再次跑测试确认未破坏**

Run: `cargo test --manifest-path src-tauri/Cargo.toml recent::`
Expected: PASS，6 个测试全过。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/recent.rs src-tauri/src/commands/mod.rs
git commit -m "feat(recent): 后端 recent 状态结构与纯函数（去重/裁剪/失效清理）+ 持久化"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 后端 recent 命令 + delete_session 集成

**Files:**
- Modify: `src-tauri/src/commands/recent.rs`（追加 5 个 `#[tauri::command]`）
- Modify: `src-tauri/src/lib.rs:124-242`（在 `invoke_handler!` 列表注册 5 个命令）
- Modify: `src-tauri/src/commands/session.rs:151-197`（`delete_session` 末尾调 `remove_recent_session`）

**Interfaces:**
- Consumes: Task 1 的 `RECENT`、`push_session`、`push_file`、`prune_stale`、`save_recent_file`、`current_limit`、`now_ms`、`RecentView`。
- Produces: Tauri 命令 `record_recent_session(ws_key, ws_name, session_id, name)`、`record_recent_file(ws_key, path, name)`、`list_recent(ws_key) -> RecentView`、`remove_recent_session(session_id)`、`clear_recent(category: Option<String>)`。Task 4 的 `api.ts` 将按这些命令名封装。

- [ ] **Step 1: 追加 5 个命令**

在 `recent.rs` 的 `now_ms` 函数之后、`#[cfg(test)]` 之前追加：

```rust
// ── Tauri 命令 ──

#[tauri::command]
pub fn record_recent_session(
    ws_key: String,
    ws_name: String,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let entry = RecentSession { ws_key, ws_name, session_id, name, ts: now_ms() };
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    push_session(&mut guard, entry, current_limit());
    save_recent_file(&guard)
}

#[tauri::command]
pub fn record_recent_file(ws_key: String, path: String, name: String) -> Result<(), String> {
    let entry = RecentFile { path, name, ts: now_ms() };
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    push_file(&mut guard, &ws_key, entry, current_limit());
    save_recent_file(&guard)
}

#[tauri::command]
pub fn list_recent(ws_key: String) -> Result<RecentView, String> {
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    let limit = current_limit();
    let mut need_save = prune_stale(&mut guard, &ws_key);
    if guard.sessions.len() > limit {
        guard.sessions.truncate(limit);
        need_save = true;
    }
    if let Some(list) = guard.files.get_mut(&ws_key) {
        if list.len() > limit {
            list.truncate(limit);
            need_save = true;
        }
    }
    if need_save {
        save_recent_file(&guard)?;
    }
    let files = guard.files.get(&ws_key).cloned().unwrap_or_default();
    let sessions = guard.sessions.clone();
    Ok(RecentView { sessions, files })
}

#[tauri::command]
pub fn remove_recent_session(session_id: String) -> Result<(), String> {
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    let before = guard.sessions.len();
    guard.sessions.retain(|s| s.session_id != session_id);
    if guard.sessions.len() != before {
        save_recent_file(&guard)?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_recent(category: Option<String>) -> Result<(), String> {
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    match category.as_deref() {
        Some("sessions") => guard.sessions.clear(),
        Some("files") => guard.files.clear(),
        _ => {
            guard.sessions.clear();
            guard.files.clear();
        }
    }
    save_recent_file(&guard)
}
```

- [ ] **Step 2: 在 lib.rs 注册命令**

Edit `src-tauri/src/lib.rs`，在 `invoke_handler!` 列表的 `commands::clipboard::clipboard_read_image,`（第 241 行）之后、`]` 之前插入：

```rust
            // Recent access
            commands::recent::record_recent_session,
            commands::recent::record_recent_file,
            commands::recent::list_recent,
            commands::recent::remove_recent_session,
            commands::recent::clear_recent,
```

- [ ] **Step 3: delete_session 集成**

Edit `src-tauri/src/commands/session.rs`，在 `delete_session` 函数体的 `Ok(())`（第 196 行）之前插入：

```rust
    // 同步移除「最近访问」中已删会话（双保险，配合 list_recent 自愈）。
    let _ = super::recent::remove_recent_session(id);
```

- [ ] **Step 4: 编译检查**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过，无 unused 警告（`RECENT`/`save_recent_file`/`current_limit`/`now_ms` 均已被命令使用）。

- [ ] **Step 5: 跑测试确认未破坏**

Run: `cargo test --manifest-path src-tauri/Cargo.toml recent::`
Expected: PASS，6 个测试全过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/recent.rs src-tauri/src/lib.rs src-tauri/src/commands/session.rs
git commit -m "feat(recent): 注册 5 个 recent 命令 + delete_session 同步清理"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 后端 settings 新增 recent_limit 字段

**Files:**
- Modify: `src-tauri/src/commands/settings.rs:30-75`（`AppSettings` 结构体 + Default + default 函数）

**Interfaces:**
- Consumes: 无。
- Produces: `AppSettings.recent_limit: u32`（serde default 10）。Task 2 的 `current_limit()` 已从 `config.json` 的 `settings.recent_limit` 读取；本任务让该字段有正式定义与默认值。

- [ ] **Step 1: 给 AppSettings 加字段**

Edit `src-tauri/src/commands/settings.rs`，在 `AppSettings` 结构体里 `pub open_with_extensions: Vec<String>,`（第 51 行）之后加一行：

```rust
    /// 「最近访问」每类列表保留条数（会话与文件共用），默认 10。
    #[serde(default = "default_recent_limit")]
    pub recent_limit: u32,
```

- [ ] **Step 2: 加 default 函数**

在 `fn default_theme() -> String { "warm-dark".to_string() }`（第 59 行）之后加：

```rust
fn default_recent_limit() -> u32 { 10 }
```

- [ ] **Step 3: 更新 Default impl**

在 `impl Default for AppSettings` 的 `open_with_extensions: Vec::new(),`（第 72 行）之后加：

```rust
            recent_limit: default_recent_limit(),
```

- [ ] **Step 4: 编译 + 测试**

Run: `cargo build --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过，所有测试通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/settings.rs
git commit -m "feat(settings): 新增 recent_limit（默认 10）"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 前端 types + api.ts 封装

**Files:**
- Modify: `src/types.ts:57-67`（`AppSettings` 加 `recentLimit`）+ 末尾追加 recent 类型
- Modify: `src/api.ts:1-6`（import 加 `RecentView`）+ 末尾 `}` 前追加 5 个封装

**Interfaces:**
- Consumes: Task 2/3 的后端命令名与 `RecentView` 序列化结构。
- Produces: TS 类型 `RecentSession`/`RecentFile`/`RecentView`；`api.recordRecentSession/recordRecentFile/listRecent/removeRecentSession/clearRecent`；`AppSettings.recentLimit`。Task 5/7/8/11 依赖这些。

- [ ] **Step 1: types.ts 加 recent 类型与 recentLimit**

Edit `src/types.ts`，在 `AppSettings` 接口的 `openWithExtensions: string[];`（第 66 行）之后加：

```ts
  recentLimit: number;
```

在文件末尾追加：

```ts
// ── Recent access types ──
// 字段名与 Rust 序列化保持一致（snake_case）。

export interface RecentSession {
  ws_key: string;
  ws_name: string;
  session_id: string;
  name: string;
  ts: number;
}

export interface RecentFile {
  path: string;
  name: string;
  ts: number;
}

export interface RecentView {
  sessions: RecentSession[];
  files: RecentFile[];
}
```

- [ ] **Step 2: api.ts import 加 RecentView**

Edit `src/api.ts` 第 2-6 行的 import，把 `RunTarget,` 之后加 `RecentView,`：

```ts
import type {
  Session, WorkspaceInfo, FileEntry, ChatMessageItem,
  ProjectInfo, DiffEntry, LastEventInfo, ChangeRound, AppSettings,
  GrepMatch, ProviderConfig, RunConfig, RunTarget, RecentView,
} from "./types";
```

- [ ] **Step 3: api.ts 追加 5 个封装**

Edit `src/api.ts`，在 `setWorkspace(key: string, path: string): Promise<void> { ... }`（第 206-208 行）之后、最后的 `};`（第 209 行）之前插入：

```ts

  // 最近访问
  recordRecentSession(wsKey: string, wsName: string, sessionId: string, name: string): Promise<void> {
    return invoke("record_recent_session", { wsKey, wsName, sessionId, name });
  },
  recordRecentFile(wsKey: string, path: string, name: string): Promise<void> {
    return invoke("record_recent_file", { wsKey, path, name });
  },
  listRecent(wsKey: string): Promise<RecentView> {
    return invoke("list_recent", { wsKey });
  },
  removeRecentSession(sessionId: string): Promise<void> {
    return invoke("remove_recent_session", { sessionId });
  },
  clearRecent(category?: "sessions" | "files"): Promise<void> {
    return invoke("clear_recent", { category: category ?? null });
  },
```

- [ ] **Step 4: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/api.ts
git commit -m "feat(recent): 前端类型与 api 封装（5 个 recent 命令）"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 前端 useSettings 处理 recentLimit

**Files:**
- Modify: `src/composables/useSettings.ts:5-17`（defaults）+ `:26-39`（load）+ `:42-56`（update）

**Interfaces:**
- Consumes: Task 4 的 `AppSettings.recentLimit`。
- Produces: `settings.recentLimit` 响应式字段在 load 后填充、在 update 时持久化。Task 9 的 SettingsPanel 依赖。

- [ ] **Step 1: defaults 加 recentLimit**

Edit `src/composables/useSettings.ts`，在 `openWithExtensions: [],`（第 16 行）之后加：

```ts
  recentLimit: 10,
```

- [ ] **Step 2: load 加 recentLimit**

在 `load()` 的 `settings.openWithExtensions = s.openWithExtensions ?? defaults.openWithExtensions;`（第 35 行）之后加：

```ts
      settings.recentLimit = s.recentLimit ?? defaults.recentLimit;
```

- [ ] **Step 3: update 加 recentLimit**

在 `update()` 的 `if (partial.theme !== undefined) settings.theme = partial.theme;`（第 51 行）之后加：

```ts
    if (partial.recentLimit !== undefined) settings.recentLimit = partial.recentLimit;
```

- [ ] **Step 4: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/composables/useSettings.ts
git commit -m "feat(settings): useSettings 加载与持久化 recentLimit"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 共享 timeAgo 工具（TDD）+ SidebarLeft 复用

**Files:**
- Create: `src/utils/time.ts`
- Create: `src/utils/time.test.ts`
- Modify: `src/components/SidebarLeft.vue:2`（import）+ `:65-74`（删除本地 timeAgo）

**Interfaces:**
- Consumes: 无。
- Produces: `timeAgo(ts: number): string`。Task 8 的 SidebarLeft 与 Task 11 的 App.vue recentFn 依赖。

- [ ] **Step 1: 写失败测试**

Create `src/utils/time.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { timeAgo } from "./time";

describe("timeAgo", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("minutes ago", () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    expect(timeAgo(Date.now() - 5 * 60000)).toBe("5分钟前");
  });

  it("hours ago", () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    expect(timeAgo(Date.now() - 3 * 3600000)).toBe("3小时前");
  });

  it("days ago", () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    expect(timeAgo(Date.now() - 2 * 86400000)).toBe("2天前");
  });

  it("weeks ago", () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    expect(timeAgo(Date.now() - 14 * 86400000)).toBe("2周前");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/utils/time.test.ts`
Expected: FAIL，`timeAgo is not a function` 或模块不存在。

- [ ] **Step 3: 实现 timeAgo**

Create `src/utils/time.ts`：

```ts
/**
 * 把毫秒时间戳转为「x 分钟前 / x 小时前 / x 天前 / x 周前」中文相对时间。
 * 与原 SidebarLeft 中的实现一致，抽到共享 util 供侧栏与命令面板复用。
 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return `${Math.floor(days / 7)}周前`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/utils/time.test.ts`
Expected: PASS，4 个测试全过。

- [ ] **Step 5: SidebarLeft 改用共享 util**

Edit `src/components/SidebarLeft.vue` 第 2 行 import 行，在 `import { ref, computed, onMounted, onUnmounted } from "vue";` 之后加一行：

```ts
import { timeAgo } from "../utils/time";
```

删除本地 `timeAgo` 函数（第 65-74 行整段）：

```ts
function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return `${Math.floor(days / 7)}周前`;
}
```

- [ ] **Step 6: 全量前端测试 + 类型检查**

Run: `pnpm test && pnpm exec vue-tsc --noEmit`
Expected: 全部测试通过，类型无错误。

- [ ] **Step 7: Commit**

```bash
git add src/utils/time.ts src/utils/time.test.ts src/components/SidebarLeft.vue
git commit -m "refactor: 抽 timeAgo 到 utils/time 并复用（含单测）"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 前端 useRecent composable

**Files:**
- Create: `src/composables/useRecent.ts`

**Interfaces:**
- Consumes: Task 4 的 `api.listRecent/recordRecentSession/recordRecentFile/clearRecent` 与 `RecentSession/RecentFile` 类型。
- Produces: 模块级单例 `useRecent()`，返回 `{ sessions: Readonly<Ref<RecentSession[]>>, files: Readonly<Ref<RecentFile[]>>, currentWsKey, currentWsName, refresh, recordSession, recordFile, setCurrentWs, clear }`。Task 8 与 Task 11 依赖。

- [ ] **Step 1: 实现 useRecent**

Create `src/composables/useRecent.ts`：

```ts
import { ref, readonly } from "vue";
import { api } from "../api";
import type { RecentSession, RecentFile } from "../types";

// 模块级单例：会话全局、文件按当前工作区展示。
const sessions = ref<RecentSession[]>([]);
const files = ref<RecentFile[]>([]);
const currentWsKey = ref("");
const currentWsName = ref("");

export function useRecent() {
  async function refresh(): Promise<void> {
    if (!currentWsKey.value) {
      sessions.value = [];
      files.value = [];
      return;
    }
    try {
      const v = await api.listRecent(currentWsKey.value);
      sessions.value = v.sessions;
      files.value = v.files;
    } catch {
      // 保留旧值，不阻断 UI
    }
  }

  /** 记录最近会话（显式传 ws，支持跨工作区选择）。 */
  async function recordSession(
    wsKey: string,
    wsName: string,
    sessionId: string,
    name: string,
  ): Promise<void> {
    try {
      await api.recordRecentSession(wsKey, wsName, sessionId, name);
      await refresh();
    } catch {
      // best effort
    }
  }

  /** 记录最近文件（用当前工作区）。 */
  async function recordFile(path: string, name: string): Promise<void> {
    if (!currentWsKey.value) return;
    try {
      await api.recordRecentFile(currentWsKey.value, path, name);
      await refresh();
    } catch {
      // best effort
    }
  }

  /** 工作区切换时调用，刷新当前工作区的最近文件。 */
  async function setCurrentWs(wsKey: string, wsName: string): Promise<void> {
    currentWsKey.value = wsKey;
    currentWsName.value = wsName;
    await refresh();
  }

  async function clear(category?: "sessions" | "files"): Promise<void> {
    try {
      await api.clearRecent(category);
      await refresh();
    } catch {
      // best effort
    }
  }

  return {
    sessions: readonly(sessions),
    files: readonly(files),
    currentWsKey: readonly(currentWsKey),
    currentWsName: readonly(currentWsName),
    refresh,
    recordSession,
    recordFile,
    setCurrentWs,
    clear,
  };
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/composables/useRecent.ts
git commit -m "feat(recent): useRecent 单例 composable（记录/刷新/清空）"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 记录触发点 + 工作区同步（SidebarLeft / useFileViewer）

**Files:**
- Modify: `src/components/SidebarLeft.vue`（import useRecent；`switchWorkspace`、`selectSessionFromWorkspace`、`onMounted` 调 `setCurrentWs`；`selectSessionFromWorkspace` 调 `recordSession`）
- Modify: `src/composables/useFileViewer.ts:2-3`（import useRecent）+ `open` 内调 `recordFile`

**Interfaces:**
- Consumes: Task 7 的 `useRecent().setCurrentWs/recordSession/recordFile`。
- Produces: 用户切换会话/打开文件时自动记录；`useRecent.currentWsKey` 在工作区切换与初始加载时被设置（供 Task 11 的 recentFn 读取正确工作区的文件）。

- [ ] **Step 1: SidebarLeft 引入 useRecent**

Edit `src/components/SidebarLeft.vue` 的 import 区，在 `import { useProviders } from "../composables/useProviders";`（第 6 行）之后加：

```ts
import { useRecent } from "../composables/useRecent";
```

并在 `const { show } = useContextMenu();`（第 118 行附近，providers 解构之前或之后均可）之后加：

```ts
const { setCurrentWs, recordSession } = useRecent();
```

- [ ] **Step 2: selectSessionFromWorkspace 埋点 + setCurrentWs**

Edit `src/components/SidebarLeft.vue` 的 `selectSessionFromWorkspace`（第 151-168 行），整体替换为：

```ts
// Select a session from a potentially different workspace
async function selectSessionFromWorkspace(wsKey: string, sessionId: string) {
  let wsName = "";
  if (wsKey !== activeWorkspace.value) {
    // Switch to the workspace first
    const ws = workspaces.value.find(w => w.key === wsKey);
    if (ws) {
      try {
        await api.setWorkspace(ws.key, ws.name);
      } catch (_e) { return; }
      activeWorkspace.value = ws.key;
      emit("workspace-changed", ws.name);
      await setCurrentWs(ws.key, ws.name);
      // Load sessions for the new active workspace if not already loaded
      if (!sessionsByWorkspace.value[wsKey]) {
        await loadSessions();
      }
      wsName = ws.name;
    }
  } else {
    const ws = workspaces.value.find(w => w.key === wsKey);
    wsName = ws?.name ?? "";
  }
  emit("session-changed", sessionId);
  // 记录最近会话（用其所属工作区，而非当前工作区）
  const list = sessionsByWorkspace.value[wsKey] ?? [];
  const s = list.find(x => x.id === sessionId);
  if (wsName) {
    void recordSession(wsKey, wsName, sessionId, s?.name ?? sessionId);
  }
}
```

- [ ] **Step 3: switchWorkspace 调 setCurrentWs**

Edit `switchWorkspace`（第 174-196 行），在 `emit("workspace-changed", ws.name);`（第 194 行）之后、`await loadSessions();`（第 195 行）之前插入：

```ts
  await setCurrentWs(ws.key, ws.name);
```

- [ ] **Step 4: onMounted 初始 setCurrentWs**

Edit `onMounted`（第 233-253 行）中确定初始 active workspace 的循环。在 `expandedWorkspaces.value.add(ws.key);`（第 242 行）之后、`break;`（第 243 行）之前插入：

```ts
        await setCurrentWs(ws.key, ws.name);
```

> 说明：若初始未匹配到任何 workspace（`activeWorkspace` 保持空字符串），`setCurrentWs` 不被调用，`useRecent` 保持空列表——符合预期。

- [ ] **Step 5: useFileViewer.open 埋点 recordFile**

Edit `src/composables/useFileViewer.ts`，在第 2 行 `import { api } from "../api";` 之后加：

```ts
import { useRecent } from "./useRecent";
```

在 `open` 函数体内，`visible.value = true;`（第 66 行）之前插入：

```ts
    // 记录最近访问文件（best effort，绝不阻断打开主流程）
    const baseName = path.split(/[\\/]/).filter(Boolean).pop() || path;
    void useRecent().recordFile(path, baseName);
```

- [ ] **Step 6: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: 前端单测全过**

Run: `pnpm test`
Expected: 全部通过。

- [ ] **Step 8: Commit**

```bash
git add src/components/SidebarLeft.vue src/composables/useFileViewer.ts
git commit -m "feat(recent): 会话切换/文件打开埋点记录 + 工作区同步 useRecent"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: SettingsPanel recent_limit 输入

**Files:**
- Modify: `src/components/SettingsPanel.vue:27-38`（local ref + watch）+ 通用 Tab 模板（第 267-276 行附近）

**Interfaces:**
- Consumes: Task 5 的 `settings.recentLimit` 与 `update`。
- Produces: 用户可在设置通用页调整「最近访问保留条数」（1–50），改动即时持久化。

- [ ] **Step 1: 加 local ref**

Edit `src/components/SettingsPanel.vue`，在 `const searchOpenLocal = ref(settings.keybindings.searchOpen);`（第 32 行）之后加：

```ts
const recentLimitLocal = ref(settings.recentLimit);
```

- [ ] **Step 2: 加 watch**

在 `watch(shellPathLocal, (v) => { settings.shellPath = v; update({ shellPath: v }); });`（第 38 行）之后加：

```ts
watch(recentLimitLocal, (v) => {
  const clamped = Math.max(1, Math.min(50, Math.floor(v) || 10));
  recentLimitLocal.value = clamped;
  settings.recentLimit = clamped;
  update({ recentLimit: clamped });
});
```

- [ ] **Step 3: 加 UI 字段**

Edit 通用 Tab 模板，在「桌面通知」字段 `</div>`（第 276 行，即 `notificationsEnabled` 那个 `settings-field` 的闭合）之后插入：

```html
              <div class="settings-field">
                <label class="field-label">最近访问保留条数</label>
                <div class="field-control">
                  <input
                    v-model.number="recentLimitLocal"
                    type="number"
                    min="1"
                    max="50"
                    class="text-input"
                    style="width: 80px"
                  />
                  <span class="field-hint">会话与文件各保留的最近条数（1–50）</span>
                </div>
              </div>
```

- [ ] **Step 4: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.vue
git commit -m "feat(settings): 通用页加「最近访问保留条数」输入"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: ACommandPalette recentFn + 空查询默认页 + 空态

**Files:**
- Modify: `src/ui/ACommandPalette.vue`（`recentFn` 状态 + `setRecentFn` + `watch(query)` + `watch(open)` + 模板空态 + `defineExpose`）

**Interfaces:**
- Consumes: 无（接收外部注入的 `recentFn`）。
- Produces: `setRecentFn(fn: () => Promise<PaletteResult[]>)`；面板打开且查询为空时调用 `recentFn` 填充结果；空态文案随查询是否为空切换。Task 11 注入实际 recentFn。

- [ ] **Step 1: 加 recentFn 状态与 setRecentFn**

Edit `src/ui/ACommandPalette.vue`，在 `let searchFn: ... = null;`（第 32 行）之后加：

```ts
let recentFn: (() => Promise<PaletteResult[]>) | null = null;

function setRecentFn(fn: () => Promise<PaletteResult[]>) {
  recentFn = fn;
}
```

- [ ] **Step 2: 加 emptyHint 计算属性**

在 `const grouped = computed(...)`（第 38-45 行）之后加：

```ts
const emptyHint = computed(() =>
  query.value.trim() ? "无匹配结果" : "暂无最近访问",
);
```

- [ ] **Step 3: 改 watch(query)：空查询走 recentFn**

替换 `watch(query, (q) => { ... })`（第 49-61 行）整体为：

```ts
watch(query, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!q.trim()) {
    // 空查询：展示最近访问
    if (recentFn) {
      recentFn()
        .then((r) => {
          results.value = r;
          selectedIndex.value = 0;
        })
        .catch(() => {
          results.value = [];
          selectedIndex.value = 0;
        });
    } else {
      results.value = [];
      selectedIndex.value = 0;
    }
    return;
  }
  debounceTimer = setTimeout(async () => {
    if (!searchFn) return;
    results.value = await searchFn(q.trim(), 8);
    selectedIndex.value = 0;
  }, 150);
});
```

- [ ] **Step 4: 改 watch(open)：打开时立即拉最近**

替换 `watch(() => props.open, async (v) => { ... })`（第 63-74 行）整体为：

```ts
watch(
  () => props.open,
  async (v) => {
    if (v) {
      query.value = "";
      results.value = [];
      selectedIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
      if (recentFn) {
        try {
          results.value = await recentFn();
          selectedIndex.value = 0;
        } catch {
          results.value = [];
        }
      }
    }
  },
);
```

- [ ] **Step 5: 模板加空态**

Edit 模板，把 `<div v-if="results.length > 0" class="a-palette-results">` 那一段后面、`.a-palette-box` 闭合 `</div>` 之前补一个 `v-else` 空态。即在 `</div>`（`a-palette-results` 的闭合，第 142 行）之后插入：

```html
          <div v-else class="a-palette-empty">{{ emptyHint }}</div>
```

- [ ] **Step 6: 加空态样式**

在 `<style>` 块的 `.a-palette-results { ... }`（第 200-203 行）之后加：

```css
.a-palette-empty {
  padding: 18px;
  text-align: center;
  color: var(--aide-text-muted);
  font-size: 12px;
}
```

- [ ] **Step 7: defineExpose 暴露 setRecentFn**

把 `defineExpose({ setSearchFn });`（第 106 行）改为：

```ts
defineExpose({ setSearchFn, setRecentFn });
```

- [ ] **Step 8: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 9: Commit**

```bash
git add src/ui/ACommandPalette.vue
git commit -m "feat(palette): 空查询展示最近访问 + 空态文案"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: App.vue 把 recentFn 接入面板

**Files:**
- Modify: `src/App.vue`（import useRecent、timeAgo、PaletteResult 类型；`onMounted` 内 `setRecentFn`）

**Interfaces:**
- Consumes: Task 7 的 `useRecent().sessions/files`；Task 6 的 `timeAgo`；Task 10 的 `paletteRef.setRecentFn`；`SidebarLeft.selectSessionFromWorkspace`（已存在）；`useFileViewer().open`（已存在）。
- Produces: 命令面板空查询时显示「最近会话」「最近文件」两组，点击跳转。

- [ ] **Step 1: import**

Edit `src/App.vue`，在 `import { useFileViewer } from "./composables/useFileViewer";`（第 37 行）之后加：

```ts
import { useRecent } from "./composables/useRecent";
import { timeAgo } from "./utils/time";
import type { PaletteResult } from "./ui/ACommandPalette.vue";
```

- [ ] **Step 2: 加 relPath 辅助**

在 `onMounted` 之前（例如 `async function onSidebarWsChanged` 函数之后，第 228 行之后）加一个小工具函数：

```ts
/** 把绝对路径转成相对当前工作区的展示路径；不在工作区内则原样返回。 */
function relPath(p: string): string {
  const root = workspacePath.value;
  if (root && p.toLowerCase().startsWith(root.toLowerCase())) {
    return p.slice(root.length).replace(/^[\\/]+/, "");
  }
  return p;
}
```

- [ ] **Step 3: onMounted 内 setRecentFn**

Edit `onMounted`，在现有 `nextTick(() => { paletteRef.value?.setSearchFn(...) });`（第 351-359 行）之后追加一个 `nextTick`：

```ts
  // 把「最近访问」注入面板：空查询时展示最近会话 + 最近文件
  nextTick(() => {
    paletteRef.value?.setRecentFn(async (): Promise<PaletteResult[]> => {
      const { sessions, files } = useRecent();
      const out: PaletteResult[] = [];
      for (const s of sessions.value) {
        out.push({
          id: "rs-" + s.session_id,
          label: s.name,
          description: `${s.ws_name} · ${timeAgo(s.ts)}`,
          icon: "\u{1F4DD}",
          group: "最近会话",
          action: () => {
            sidebarRef.value?.selectSessionFromWorkspace(s.ws_key, s.session_id);
          },
        });
      }
      for (const f of files.value) {
        out.push({
          id: "rf-" + f.path,
          label: f.name,
          description: `${relPath(f.path)} · ${timeAgo(f.ts)}`,
          icon: "\u{1F4C4}",
          group: "最近文件",
          action: () => {
            useFileViewer().open(f.path);
          },
        });
      }
      return out;
    });
  });
```

- [ ] **Step 4: 类型检查 + 前端测试**

Run: `pnpm exec vue-tsc --noEmit && pnpm test`
Expected: 无类型错误，全部测试通过。

- [ ] **Step 5: Commit**

```bash
git add src/App.vue
git commit -m "feat(recent): 命令面板默认页接入最近会话/文件"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: 手动验证

**Files:** 无（仅运行验证）

**Interfaces:**
- Consumes: Task 1-11 全部成果。
- Produces: 确认功能可用、持久化、自愈、设置生效。

- [ ] **Step 1: 启动应用**

Run: `pnpm tauri dev`
Expected: 应用窗口正常启动，无编译/运行错误。

- [ ] **Step 2: 空态**

按 `Ctrl+P` 打开命令面板（不输入任何内容）。
Expected: 显示空态「暂无最近访问」。

- [ ] **Step 3: 记录会话与文件**

在侧栏切换一个会话；在右栏文件树打开一个文件；再次 `Ctrl+P`。
Expected: 「最近会话」「最近文件」两组各显示对应条目，最新在最上，副描述含工作区名/相对路径 + 相对时间。

- [ ] **Step 4: 置顶与去重**

再次切换同一会话 / 打开同一文件；再开面板。
Expected: 该条目移到队首，不重复。

- [ ] **Step 5: 点击跳转**

在面板里点一个最近会话项。
Expected: 面板关闭，切换到对应会话（若属另一工作区则自动切工作区）。
点一个最近文件项。
Expected: 面板关闭，文件查看器打开该文件。

- [ ] **Step 6: 持久化**

关闭应用后重新 `pnpm tauri dev`，`Ctrl+P`。
Expected: 最近列表保留（来自 `recent.json`）。

- [ ] **Step 7: 容量设置生效**

打开「设置 → 通用 → 最近访问保留条数」，改为 2；切换 3 个不同会话；再开面板。
Expected: 最近会话只显示 2 条。
改回 10。

- [ ] **Step 8: 失效自愈**

在 `~/.claude/projects/` 下删除某会话的 `.jsonl`（或删除一个最近文件）；再开面板。
Expected: 对应条目消失（`list_recent` 的 `prune_stale` 清理并写回）。

- [ ] **Step 9: 跨工作区会话**

若存在多个工作区：在面板点一个属于另一工作区的最近会话。
Expected: 工作区切换到该会话所属工作区并选中该会话；该会话置顶。

- [ ] **Step 10: 记录验证结果**

把每步实际结果记在本任务评论或回执里；如有偏差回到对应 Task 修复并重跑。

---

## Self-Review 结果

- **Spec 覆盖**：spec 各节均映射到任务——数据模型/存储 → T1；命令/裁剪/失效/delete 集成 → T2；设置项 → T3/T5/T9；composable 与触发点 → T7/T8；命令面板默认页 → T10/T11；测试与验证 → T1/T6/T12。无遗漏。
- **占位符扫描**：无 TBD/TODO；每步含完整代码或确切命令。
- **类型一致性**：`RecentSession`/`RecentFile`/`RecentView` 字段名（snake_case）在 Rust 与 TS 一致；命令名与 `api.ts` 封装、`lib.rs` 注册一致；`recentLimit`（TS）/`recent_limit`（Rust）通过 Tauri camelCase↔snake_case 转换对接；`useRecent` 方法名在 T7 定义、T8/T11 调用一致；`setRecentFn` 在 T10 定义、T11 调用一致。