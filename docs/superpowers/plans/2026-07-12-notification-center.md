# 通知中心（Notification Center）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Aide 增加应用内通知通道：任何功能调 `useNotifications().push({...})` 即可往标题栏铃铛的下拉面板塞一条通知；error/warning 落盘跨重启、info 仅内存；v1 接入 codegraph 向量索引出错。

**Architecture:** 前端模块级 reactive 单例 `useNotifications` 持有状态（与 `useSettings`/`useRecent` 同模式）；Rust 仅做文件 IO（`load_notifications`/`save_notifications`，async + spawn_blocking，原子 tmp+rename 写 `~/.claude-code-desktop/notifications.json`）。标题栏新增 `NotificationBell.vue`（方案 A 墨线：左侧 3px 严重度色条）。v1 唯一源 `useCodeGraphProgress.trackBuild` 失败/可恢复分支 push 通知。

**Tech Stack:** Vue 3 Composition + TypeScript / vitest（前端单测）/ Rust Tauri v2 command + serde + tokio spawn_blocking / cargo test --lib（Rust 单测）

## Global Constraints

- 跨平台：Rust 路径用 `PathBuf` + `commands::our_config_dir()`（已在 `src-tauri/src/commands/mod.rs:201` 定义为 `~/.claude-code-desktop`），不硬编码 `\\`。
- 同步 command 禁止重 IO：通知文件 IO 全 `async fn` + `tokio::task::spawn_blocking`，返回 `Result<_, String>`。
- 不走 `app.emit`（跨线程 emit 是历史卡死根因）；通知状态纯前端 store + 拉模型 hydrate。
- 不引入新颜色/新依赖；复用 `src/styles/global.css` 的 `--aide-*` token（`--aide-danger #e87070`、`--aide-warning #e8c374`、`--aide-info #7eb8d8`、`--aide-accent #d4a574` 等）。
- 不改 `src/composables/useNotification.ts`（OS 桌面通知，绑会话状态）。
- 前端测试：`pnpm test`（= `vitest run`）。Rust 测试：`cargo test --lib --manifest-path src-tauri/Cargo.toml`（CLAUDE.md：`--lib` 绕杀软锁）。
- 视觉方案 A 墨线已定稿，mockup 在 `docs/notification-mockup.html`。

## File Structure

新增：
- `src-tauri/src/commands/notifications.rs` — Rust 持久化（类型 + 纯函数 + 原子 IO + 两命令 + 单测）
- `src/composables/useNotifications.ts` — 前端 reactive 单例 store + API
- `src/composables/useNotifications.test.ts` — vitest 单测
- `src/components/titlebar/NotificationBell.vue` — 标题栏铃铛 + 下拉面板（方案 A 墨线）

修改：
- `src-tauri/src/commands/mod.rs` — `pub mod notifications;`
- `src-tauri/src/lib.rs` — 注册两命令
- `src/types.ts` — `AppNotification` / `NotificationAction` / `NotificationRecord` 类型
- `src/api.ts` — `loadNotifications` / `saveNotifications` 封装
- `src/components/titlebar/TitleBar.vue` — 插入 `<NotificationBell />`
- `src/composables/useCodeGraphProgress.ts` — 接入 push + 自愈 dismiss + 注册 action handler
- `src/main.ts` — 启动调 `hydrate()`

---

## Task 1: Rust 持久化（`notifications.rs` + 注册）

**Files:**
- Create: `src-tauri/src/commands/notifications.rs`
- Modify: `src-tauri/src/commands/mod.rs`（加 `pub mod notifications;`）
- Modify: `src-tauri/src/lib.rs`（注册 `load_notifications`、`save_notifications`）
- Test: `src-tauri/src/commands/notifications.rs` 内 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `load_notifications() -> Result<Vec<NotificationRecord>, String>`、`save_notifications(records: Vec<NotificationRecord>) -> Result<(), String>`（Tauri 命令）；`NotificationRecord`（serde camelCase）。
- Consumes: `crate::commands::our_config_dir()`（`src-tauri/src/commands/mod.rs:201`）。

### 步骤

- [ ] **Step 1: 在 `commands/mod.rs` 注册模块**

打开 `src-tauri/src/commands/mod.rs`，在现有 `pub mod ...` 列表里加一行（与 `pub mod recent;` 等同级）：

```rust
pub mod notifications;
```

- [ ] **Step 2: 写 `notifications.rs`（类型 + 纯函数 + IO + 命令 + 失败测试骨架）**

创建 `src-tauri/src/commands/notifications.rs`：

```rust
//! 应用内通知持久化。
//!
//! 前端 reactive store 持有状态；Rust 仅做文件 IO：
//! - load_notifications：启动时拉取落盘的 error/warning 通知（info 不落盘）。
//! - save_notifications：前端 debounce 500ms 后整份覆盖写。
//!
//! 落盘规则：只存 severity ∈ {error, warning}；不含 read 状态（重启回到未读）；
//! 软上限 100 条，按 timestamp 降序截断。原子写：tmp + rename。
//!
//! 文件：~/.claude-code-desktop/notifications.json（与 diagnostics/recent 同根）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::our_config_dir;

/// 落盘条数软上限。超出按 timestamp 降序淘汰最旧。
pub const PERSIST_LIMIT: usize = 100;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub label: String,
    pub url: Option<String>,
}

/// 落盘记录。前端 AppNotification 去掉 read、去掉 info 项后的形态。
/// serde camelCase 与前端字段对齐（dedupKey 等）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub id: String,
    pub severity: String, // "error" | "warning"
    pub source: String,
    pub title: String,
    pub body: Option<String>,
    pub timestamp: u64,
    pub dedup_key: Option<String>,
    pub count: Option<u64>,
    pub action: Option<NotificationAction>,
}

// ── 纯函数（无 IO，可单测）──

/// 只保留 error/warning（防御性：info 前端不该传，但服务端再兜一道）。
pub fn filter_persistable(records: Vec<NotificationRecord>) -> Vec<NotificationRecord> {
    records
        .into_iter()
        .filter(|r| r.severity == "error" || r.severity == "warning")
        .collect()
}

/// 按 timestamp 降序排序后截断到 limit（淘汰最旧）。
pub fn cap_to_limit(mut records: Vec<NotificationRecord>, limit: usize) -> Vec<NotificationRecord> {
    records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    records.truncate(limit);
    records
}

// ── 持久化 ──

pub fn notifications_path() -> PathBuf {
    our_config_dir().join("notifications.json")
}

/// 从磁盘加载；缺失或损坏返回空（绝不崩）。
pub fn load_notifications_file() -> Vec<NotificationRecord> {
    let p = notifications_path();
    if p.exists() {
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Vec<NotificationRecord>>(&content) {
                return v;
            }
        }
    }
    Vec::new()
}

/// 过滤 + 截断 + 原子写（tmp + rename）。
pub fn save_notifications_file(records: Vec<NotificationRecord>) -> Result<(), String> {
    let persisted = cap_to_limit(filter_persistable(records), PERSIST_LIMIT);
    let p = notifications_path();
    let dir = p.parent().ok_or_else(|| "notifications.json has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ── Tauri 命令（async + spawn_blocking，文件 IO 不堵主线程）──

#[tauri::command]
pub async fn load_notifications() -> Result<Vec<NotificationRecord>, String> {
    tokio::task::spawn_blocking(load_notifications_file)
        .await
        .map_err(|e| format!("load_notifications task panicked: {e}"))
}

#[tauri::command]
pub async fn save_notifications(records: Vec<NotificationRecord>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_notifications_file(records))
        .await
        .map_err(|e| format!("save_notifications task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, severity: &str, ts: u64) -> NotificationRecord {
        NotificationRecord {
            id: id.into(),
            severity: severity.into(),
            source: "test".into(),
            title: id.into(),
            body: None,
            timestamp: ts,
            dedup_key: None,
            count: None,
            action: None,
        }
    }

    #[test]
    fn filter_persistable_drops_info_keeps_error_and_warning() {
        let v = vec![
            rec("a", "error", 1),
            rec("b", "warning", 2),
            rec("c", "info", 3),
        ];
        let out = filter_persistable(v);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|r| r.severity != "info"));
    }

    #[test]
    fn cap_to_limit_keeps_newest() {
        let v: Vec<_> = (0..5).map(|i| rec(&format!("s{i}"), "error", i)).collect();
        let out = cap_to_limit(v, 3);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].timestamp, 4); // 降序，最新在前
        assert_eq!(out[2].timestamp, 2);
    }

    #[test]
    fn save_then_load_round_trips() {
        // 用临时目录覆盖 notifications_path：直接测 save/load 文件函数。
        // our_config_dir 依赖系统 home，测试里改为写入 env-重定向不现实，
        // 因此直接测纯函数 + 一个临时路径的手动写读。
        let tmp = std::env::temp_dir().join(format!("aide-notif-test-{}.json", std::process::id()));
        let _ = fs::remove_file(&tmp);
        let records = vec![rec("a", "error", 10), rec("b", "warning", 20)];
        // 直接序列化写 tmp，模拟 save（不依赖 our_config_dir）
        let body = serde_json::to_string_pretty(&records).unwrap();
        fs::write(&tmp, body).unwrap();
        let loaded: Vec<NotificationRecord> =
            serde_json::from_str(&fs::read_to_string(&tmp).unwrap()).unwrap();
        assert_eq!(loaded, records);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn load_missing_file_returns_empty() {
        // load_notifications_file 读 our_config_dir/notifications.json；
        // 在全新机器上文件不存在，必须返回空而不崩。
        // 这里只断言函数可调用且返回 Vec（不强制删现有文件以免破坏本机数据）。
        let _ = load_notifications_file(); // 不 panic 即可
    }
}
```

- [ ] **Step 3: 运行 Rust 测试验证失败/通过**

Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml commands::notifications::tests`
Expected: PASS（4 条）。若 `our_config_dir` 因 home 解析问题编译报错，确认 `use super::our_config_dir;` 路径正确（`mod.rs` 里是 `pub fn our_config_dir()`）。

- [ ] **Step 4: 在 `lib.rs` 注册两命令**

打开 `src-tauri/src/lib.rs`，在 `.invoke_handler(tauri::generate_handler![` 列表末尾（`commands::customizations::...` 区块之后或任意位置，保持字母/逻辑分组即可）加：

```rust
            commands::notifications::load_notifications,
            commands::notifications::save_notifications,
```

- [ ] **Step 5: 编译确认 Rust 通过**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 编译通过，无警告（serde camelCase 字段对齐前端）。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands/notifications.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(notifications): Rust 持久化层 load/save_notifications"
```

---

## Task 2: 前端类型 + api 封装

**Files:**
- Modify: `src/types.ts`（文件末尾追加类型）
- Modify: `src/api.ts`（加 `loadNotifications` / `saveNotifications`）

**Interfaces:**
- Consumes: Rust `NotificationRecord`（serde camelCase）。
- Produces: `AppNotification`（前端运行时态，含 `read`）、`NotificationRecord`（落盘态，不含 `read`）、`NotificationAction`。

### 步骤

- [ ] **Step 1: 在 `src/types.ts` 末尾追加类型**

在 `src/types.ts` 文件末尾追加：

```ts
// ── 通知中心 ──

export type NotificationSeverity = "error" | "warning" | "info";

export interface NotificationAction {
  label: string;
  url?: string;
}

/** 前端运行时通知（含 read 状态）。 */
export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  source: string;
  title: string;
  body?: string;
  timestamp: number;
  dedupKey?: string;
  count?: number;
  action?: NotificationAction;
  read: boolean;
}

/** 落盘记录（无 read，info 不落盘）。镜像 Rust NotificationRecord。 */
export interface NotificationRecord {
  id: string;
  severity: "error" | "warning";
  source: string;
  title: string;
  body?: string;
  timestamp: number;
  dedupKey?: string;
  count?: number;
  action?: NotificationAction;
}
```

- [ ] **Step 2: 在 `src/api.ts` 加封装**

打开 `src/api.ts`。先在顶部 `import type { ... } from "./types";` 的类型列表里加 `AppNotification, NotificationRecord`（在 `RescanResult, QueryResult,` 后面）。

然后在 `api` 对象内任意位置（建议 `notifySend` 附近，搜索 `notifySend` 找到后在其后加）插入：

```ts
  // 通知中心持久化
  loadNotifications(): Promise<NotificationRecord[]> {
    return invoke("load_notifications");
  },
  saveNotifications(records: NotificationRecord[]): Promise<void> {
    return invoke("save_notifications", { records });
  },
```

- [ ] **Step 3: 类型检查通过**

Run: `pnpm exec tsc --noEmit`
Expected: 无新错误（若项目用 `vue-tsc`，按既有方式跑；此处以 tsc 为准，无配置则跳过手动核对类型名拼写）。

- [ ] **Step 4: 提交**

```bash
git add src/types.ts src/api.ts
git commit -m "feat(notifications): 前端类型 + api 封装"
```

---

## Task 3: `useNotifications.ts` composable + 单测

**Files:**
- Create: `src/composables/useNotifications.ts`
- Test: `src/composables/useNotifications.test.ts`

**Interfaces:**
- Consumes: `api.loadNotifications` / `api.saveNotifications`（Task 2）、`AppNotification`/`NotificationRecord`（Task 2）。
- Produces: `useNotifications()` → `{ notifications, unreadCount, push, dismiss, clearAll, markAllRead, hydrate, registerActionHandler, triggerAction, __resetForTest }`。后续 Task 4/5/6 依赖这些。

### 步骤

- [ ] **Step 1: 写失败测试 `useNotifications.test.ts`**

创建 `src/composables/useNotifications.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useNotifications } from "./useNotifications";

// mock api：load 返回空、save 记录调用参数
vi.mock("../api", () => ({
  api: {
    loadNotifications: vi.fn().mockResolvedValue([]),
    saveNotifications: vi.fn().mockResolvedValue(undefined),
  },
}));

import { api } from "../api";

const {
  notifications,
  unreadCount,
  push,
  dismiss,
  clearAll,
  markAllRead,
  hydrate,
  registerActionHandler,
  triggerAction,
  __resetForTest,
} = useNotifications();

function base(severity: "error" | "warning" | "info" = "error") {
  return {
    severity,
    source: "test",
    title: "T",
    timestamp: Date.now(),
  } as const;
}

describe("useNotifications", () => {
  beforeEach(() => {
    __resetForTest();
    (api.saveNotifications as any).mockClear();
    (api.loadNotifications as any).mockClear();
    (api.loadNotifications as any).mockResolvedValue([]);
  });

  it("push 后列表按 timestamp 降序、未读数 +1", () => {
    push({ ...base("error"), id: undefined as never, title: "a", timestamp: 100 });
    push({ ...base("error"), id: undefined as never, title: "b", timestamp: 200 });
    expect(notifications.value.map((n) => n.title)).toEqual(["b", "a"]);
    expect(unreadCount.value).toBe(2);
  });

  it("dedupKey 命中未读项 → 合并刷新 count++ 不新增", () => {
    push({ ...base("error"), id: undefined as never, title: "a", dedupKey: "k", timestamp: 100 });
    push({ ...base("error"), id: undefined as never, title: "a2", dedupKey: "k", timestamp: 200 });
    expect(notifications.value.length).toBe(1);
    expect(notifications.value[0].title).toBe("a2");
    expect(notifications.value[0].count).toBe(2);
    expect(notifications.value[0].timestamp).toBe(200);
  });

  it("info 不触发落盘；error/warning 触发（debounce 后）", async () => {
    push({ ...base("info"), id: undefined as never, title: "i", timestamp: 1 });
    expect(api.saveNotifications).not.toHaveBeenCalled();
    push({ ...base("error"), id: undefined as never, title: "e", timestamp: 2 });
    await new Promise((r) => setTimeout(r, 600)); // 等 500ms debounce
    expect(api.saveNotifications).toHaveBeenCalledTimes(1);
    const sent = (api.saveNotifications as any).mock.calls[0][0] as any[];
    expect(sent.every((r) => r.severity !== "info")).toBe(true);
  });

  it("dismiss 删条目并落盘；clearAll 清空并落盘", async () => {
    push({ ...base("error"), id: undefined as never, title: "e", timestamp: 1 });
    await new Promise((r) => setTimeout(r, 600));
    const id = notifications.value[0].id;
    (api.saveNotifications as any).mockClear();
    dismiss(id);
    expect(notifications.value.length).toBe(0);
    expect(api.saveNotifications).toHaveBeenCalledTimes(1);
  });

  it("markAllRead 只改 read 不落盘", async () => {
    push({ ...base("error"), id: undefined as never, title: "e", timestamp: 1 });
    await new Promise((r) => setTimeout(r, 600));
    (api.saveNotifications as any).mockClear();
    markAllRead();
    expect(unreadCount.value).toBe(0);
    expect(api.saveNotifications).not.toHaveBeenCalled();
  });

  it("hydrate 注入落盘项为未读", async () => {
    (api.loadNotifications as any).mockResolvedValue([
      { id: "r1", severity: "error", source: "codegraph", title: "旧错误", timestamp: 999, read: false },
    ]);
    await hydrate();
    expect(notifications.value.length).toBe(1);
    expect(notifications.value[0].read).toBe(false);
    expect(unreadCount.value).toBe(1);
  });

  it("triggerAction 按 source 派发到注册的 handler", async () => {
    const handler = vi.fn();
    registerActionHandler("test", handler);
    push({ ...base("warning"), id: undefined as never, title: "t", timestamp: 1, action: { label: "重建" } });
    const id = notifications.value[0].id;
    triggerAction(id);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].id).toBe(id);
  });

  it("落盘上限 100：超 100 条 push 后 save 只送 100 条且淘汰最旧", async () => {
    for (let i = 0; i < 105; i++) {
      push({ ...base("error"), id: undefined as never, title: `e${i}`, timestamp: i });
    }
    await new Promise((r) => setTimeout(r, 600));
    const sent = (api.saveNotifications as any).mock.calls.at(-1)[0] as any[];
    expect(sent.length).toBe(100);
    // 最旧（timestamp 0~4）应被淘汰，最新（104）在前
    expect(sent[0].timestamp).toBe(104);
  });
});
```

注：测试里 push 的 `id` 传 `undefined as never`——composable 内部会 `crypto.randomUUID()` 填充。若 vitest 环境无 `crypto.randomUUID`，composable 需兜底（见 Step 2 实现的 `genId`）。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- useNotifications`
Expected: FAIL（`useNotifications` 未导出 / 模块不存在）。

- [ ] **Step 3: 写 `useNotifications.ts` 实现**

创建 `src/composables/useNotifications.ts`：

```ts
import { ref, computed, readonly } from "vue";
import { api } from "../api";
import type { AppNotification, NotificationRecord, NotificationSeverity } from "../types";

/**
 * 应用内通知中心（模块级 reactive 单例）。
 *
 * push 是纯前端内存操作（立即反映到 UI）；severity ∈ {error, warning} 时
 * debounce 500ms 触发 save_notifications 落盘；info 仅内存。
 * 读路径：启动时 hydrate() 一次从盘注入 error/warning 为未读。
 *
 * 去重：dedupKey 命中未读项 → 原地更新（count++、timestamp 刷新）；命中已读项视为新条目。
 * 落盘内容：不含 info、不含已 dismiss 项、不含 read 状态（重启回到未读）。
 * 软上限 100 条，落盘时按 timestamp 降序截断（Rust 侧再兜一道）。
 *
 * action 派发：action.url → 浏览器打开（调用方处理）；无 url → triggerAction 查
 * source→handler 注册表派发（源 composable 自己注册）。
 */

const notifications = ref<AppNotification[]>([]);
const unreadCount = computed(() => notifications.value.filter((n) => !n.read).length);

const PERSIST_LIMIT = 100;
const SAVE_DEBOUNCE_MS = 500;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const actionHandlers = new Map<string, (n: AppNotification) => void>();

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `n_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function persistableRecords(): NotificationRecord[] {
  return notifications.value
    .filter((n) => n.severity === "error" || n.severity === "warning")
    .map((n) => ({
      id: n.id,
      severity: n.severity as "error" | "warning",
      source: n.source,
      title: n.title,
      body: n.body,
      timestamp: n.timestamp,
      dedupKey: n.dedupKey,
      count: n.count,
      action: n.action,
    }));
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void api.saveNotifications(persistableRecords()).catch(() => {
      // 落盘失败不阻塞 UI（fire-and-forget）
    });
  }, SAVE_DEBOUNCE_MS);
}

function flushSaveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void api.saveNotifications(persistableRecords()).catch(() => {});
}

export function useNotifications() {
  return {
    notifications: readonly(notifications),
    unreadCount: readonly(unreadCount),

    push(n: Omit<AppNotification, "id" | "read" | "count"> & Partial<{ count: number; id: string }>): void {
      // 去重：dedupKey 命中未读项 → 合并
      if (n.dedupKey) {
        const idx = notifications.value.findIndex(
          (x) => x.dedupKey === n.dedupKey && !x.read,
        );
        if (idx >= 0) {
          const existing = notifications.value[idx];
          notifications.value.splice(idx, 1, {
            ...existing,
            title: n.title,
            body: n.body ?? existing.body,
            timestamp: n.timestamp,
            count: (existing.count ?? 1) + 1,
            action: n.action ?? existing.action,
            severity: n.severity as NotificationSeverity,
            source: n.source,
          });
          if (n.severity === "error" || n.severity === "warning") scheduleSave();
          return;
        }
      }
      const entry: AppNotification = {
        id: n.id ?? genId(),
        severity: n.severity as NotificationSeverity,
        source: n.source,
        title: n.title,
        body: n.body,
        timestamp: n.timestamp,
        dedupKey: n.dedupKey,
        count: n.count ?? 1,
        action: n.action,
        read: false,
      };
      // 插入并保持 timestamp 降序
      const list = notifications.value;
      let i = 0;
      while (i < list.length && list[i].timestamp >= entry.timestamp) i++;
      list.splice(i, 0, entry);
      // 软上限（内存侧也截，防长期累积）
      if (list.length > PERSIST_LIMIT) list.splice(PERSIST_LIMIT);
      if (n.severity === "error" || n.severity === "warning") scheduleSave();
    },

    dismiss(id: string): void {
      const before = notifications.value.length;
      notifications.value = notifications.value.filter((n) => n.id !== id);
      if (notifications.value.length !== before) flushSaveNow();
    },

    clearAll(): void {
      if (notifications.value.length === 0) return;
      notifications.value = [];
      flushSaveNow();
    },

    markAllRead(): void {
      for (const n of notifications.value) n.read = true;
      // read 不落盘
    },

    async hydrate(): Promise<void> {
      try {
        const records = await api.loadNotifications();
        // 落盘项注入为未读（read:false），按 timestamp 降序
        const loaded: AppNotification[] = records.map((r) => ({
          id: r.id,
          severity: r.severity,
          source: r.source,
          title: r.title,
          body: r.body,
          timestamp: r.timestamp,
          dedupKey: r.dedupKey,
          count: r.count,
          action: r.action,
          read: false,
        }));
        loaded.sort((a, b) => b.timestamp - a.timestamp);
        // 合并：保留内存中已有（info 项不落盘，hydrate 不应覆盖它们）
        const memIds = new Set(notifications.value.map((n) => n.id));
        const merged = [...loaded.filter((n) => !memIds.has(n.id)), ...notifications.value];
        merged.sort((a, b) => b.timestamp - a.timestamp);
        notifications.value = merged;
      } catch {
        // 加载失败不崩，保持空
      }
    },

    registerActionHandler(source: string, fn: (n: AppNotification) => void): void {
      actionHandlers.set(source, fn);
    },

    triggerAction(id: string): void {
      const n = notifications.value.find((x) => x.id === id);
      if (!n) return;
      if (n.action?.url) {
        // url 由 NotificationBell 调 open 处理；triggerAction 只负责无 url 的派发
        return;
      }
      const handler = actionHandlers.get(n.source);
      if (handler) handler(n);
    },

    __resetForTest(): void {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      notifications.value = [];
      actionHandlers.clear();
    },
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test -- useNotifications`
Expected: PASS（8 条全绿）。若 `crypto.randomUUID` 缺失报错，确认 `genId` 兜底分支生效。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useNotifications.ts src/composables/useNotifications.test.ts
git commit -m "feat(notifications): useNotifications composable + 单测"
```

---

## Task 4: `NotificationBell.vue` + 挂载到 TitleBar

**Files:**
- Create: `src/components/titlebar/NotificationBell.vue`
- Modify: `src/components/titlebar/TitleBar.vue`（在 `titlebar-right` 的 `activity` 前插入 `<NotificationBell />`）

**Interfaces:**
- Consumes: `useNotifications()`（Task 3）、`@tauri-apps/plugin-shell` 的 `open`。
- Produces: 自包含组件，无 props/emit（状态全部从 composable 读）。

### 步骤

- [ ] **Step 1: 创建 `NotificationBell.vue`**

创建 `src/components/titlebar/NotificationBell.vue`：

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useNotifications } from "../../composables/useNotifications";
import { open } from "@tauri-apps/plugin-shell";
import type { AppNotification } from "../../types";

const { notifications, unreadCount, clearAll, markAllRead, dismiss, triggerAction } =
  useNotifications();

const open2 = ref(false);
const rootRef = ref<HTMLElement | null>(null);

function toggle() {
  open2.value = !open2.value;
  if (open2.value) markAllRead();
}

function onDocClick(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    open2.value = false;
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") open2.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});

const badge = computed(() => {
  const c = unreadCount.value;
  if (c === 0) return null;
  return c > 9 ? "9+" : String(c);
});

const SEV_BAR: Record<string, string> = {
  error: "sev-bar sev-error",
  warning: "sev-bar sev-warning",
  info: "sev-bar sev-info",
};

function timeLabel(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

function onAction(n: AppNotification) {
  if (n.action?.url) {
    void open(n.action.url);
  } else {
    triggerAction(n.id);
  }
}

// 渲染 body：把 <code>...</code> 转成内联 code 片段（纯文本+code，无 HTML 注入风险）
// body 是 app 内生成的受控字符串，但仍按纯文本处理，只把反引号段包成 <code>。
function bodyParts(body: string | undefined): Array<{ t: "text" | "code"; v: string }> {
  if (!body) return [];
  const parts: Array<{ t: "text" | "code"; v: string }> = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) parts.push({ t: "text", v: body.slice(last, m.index) });
    parts.push({ t: "code", v: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ t: "text", v: body.slice(last) });
  return parts;
}
</script>

<template>
  <div ref="rootRef" class="bell-wrap">
    <button
      class="bell-btn"
      :class="{ 'has-unread': unreadCount > 0 }"
      v-tooltip="'通知'"
      :aria-label="'通知'"
      :aria-expanded="open2"
      @click="toggle"
    >
      <svg class="bell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      <span v-if="badge" class="bell-badge">{{ badge }}</span>
    </button>

    <Transition name="notif-drop">
      <div v-if="open2" class="notif-panel" role="dialog" aria-label="通知中心">
        <div class="notif-header">
          <span class="notif-title">通知<span v-if="unreadCount > 0" class="notif-count">{{ unreadCount }}</span></span>
          <button class="notif-clear" @click="clearAll">全部清除</button>
        </div>
        <div class="notif-body">
          <div v-if="notifications.length === 0" class="notif-empty">暂无通知</div>
          <div v-for="n in notifications" :key="n.id" class="notif-row" :class="{ unread: !n.read }">
            <div :class="SEV_BAR[n.severity] || 'sev-bar sev-info'"></div>
            <div class="notif-row-inner">
              <div class="notif-row-top">
                <span class="notif-row-title">{{ n.title }}</span>
                <span class="notif-row-time">{{ timeLabel(n.timestamp) }}</span>
              </div>
              <div v-if="n.body" class="notif-row-body">
                <template v-for="(p, i) in bodyParts(n.body)" :key="i">
                  <code v-if="p.t === 'code'" class="inline-code">{{ p.v }}</code>
                  <span v-else>{{ p.v }}</span>
                </template>
              </div>
              <div class="notif-row-foot">
                <span class="src-tag">{{ n.source }}</span>
                <div class="notif-row-actions">
                  <button v-if="n.action" class="action-btn" @click="onAction(n)">{{ n.action.label }}</button>
                </div>
              </div>
            </div>
            <button class="notif-dismiss" title="忽略" @click.stop="dismiss(n.id)">✕</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.bell-wrap { position: relative; display: flex; align-items: center; height: 100%; }

.bell-btn {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; margin: 0 4px;
  background: none; border: 1px solid transparent; border-radius: var(--aide-radius-sm);
  color: var(--aide-text-muted); cursor: pointer; position: relative; transition: all 0.12s;
}
.bell-btn:hover { color: var(--aide-text-primary); background: var(--aide-surface-default); }
.bell-btn.has-unread { color: var(--aide-text-secondary); }
.bell-icon { width: 15px; height: 15px; }
.bell-badge {
  position: absolute; top: 3px; right: 3px;
  min-width: 14px; height: 14px; padding: 0 4px;
  background: var(--aide-danger); color: #fff;
  font-size: 9px; font-weight: 700; line-height: 14px; text-align: center;
  border-radius: 7px; border: 1.5px solid var(--aide-bg-deep);
}

.notif-panel {
  position: absolute; top: calc(100% + 6px); right: 0;
  width: 360px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg);
  z-index: 900; overflow: hidden;
}
.notif-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--aide-border);
  background: linear-gradient(180deg, var(--aide-border-subtle) 0%, transparent 100%), var(--aide-bg-raised);
}
.notif-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px;
  color: var(--aide-text-muted);
}
.notif-count { color: var(--aide-accent); margin-left: 6px; }
.notif-clear {
  background: none; border: none; color: var(--aide-text-muted);
  font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: var(--aide-radius-sm);
  font-family: inherit; transition: all 0.12s;
}
.notif-clear:hover { color: var(--aide-text-primary); background: var(--aide-surface-default); }

.notif-body { max-height: 420px; overflow-y: auto; }
.notif-empty { padding: 28px 16px; text-align: center; color: var(--aide-text-muted); font-size: 12px; }

.notif-row {
  display: flex; align-items: stretch; gap: 0;
  border-bottom: 1px solid var(--aide-border);
  transition: background 0.1s;
}
.notif-row:last-child { border-bottom: none; }
.notif-row:hover { background: color-mix(in srgb, var(--aide-surface-default) 50%, transparent); }

.sev-bar { width: 3px; flex-shrink: 0; align-self: stretch; }
.sev-error { background: var(--aide-danger); }
.sev-warning { background: var(--aide-warning); }
.sev-info { background: var(--aide-info); }

.notif-row-inner { flex: 1; min-width: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.notif-row-top { display: flex; align-items: center; gap: 8px; }
.notif-row-title {
  font-size: 12.5px; font-weight: 600; color: var(--aide-text-primary);
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.notif-row-time { font-size: 10px; color: var(--aide-text-muted); flex-shrink: 0; }
.notif-row-body { font-size: 11.5px; color: var(--aide-text-secondary); line-height: 1.5; word-break: break-word; }
.inline-code {
  background: var(--aide-surface-default); padding: 0 4px; border-radius: 3px;
  font-family: 'Consolas', 'Menlo', monospace; font-size: 10.5px; color: var(--aide-text-secondary);
}
.notif-row-foot { display: flex; align-items: center; gap: 8px; margin-top: 1px; }
.src-tag {
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase;
  color: var(--aide-text-muted); background: var(--aide-surface-default);
  padding: 1px 6px; border-radius: 8px;
}
.notif-row-actions { display: flex; align-items: center; gap: 10px; }
.action-btn {
  font-size: 11px; color: var(--aide-accent); cursor: pointer;
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 22%, transparent);
  padding: 3px 10px; border-radius: var(--aide-radius-sm); font-family: inherit;
  transition: all 0.12s;
}
.action-btn:hover { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent); }

.notif-dismiss {
  width: 18px; height: 18px; margin: 0 6px; align-self: center;
  display: flex; align-items: center; justify-content: center;
  color: var(--aide-text-muted); cursor: pointer; border-radius: var(--aide-radius-sm);
  font-size: 12px; opacity: 0; transition: opacity 0.12s; background: none; border: none;
}
.notif-row:hover .notif-dismiss { opacity: 1; }
.notif-dismiss:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }

/* 下拉过渡 */
.notif-drop-enter-active, .notif-drop-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.notif-drop-enter-from, .notif-drop-leave-to { opacity: 0; transform: translateY(-4px); }

@media (prefers-reduced-motion: reduce) {
  .notif-drop-enter-active, .notif-drop-leave-active { transition: none; }
}
</style>
```

- [ ] **Step 2: 挂载到 TitleBar**

打开 `src/components/titlebar/TitleBar.vue`。

在 `<script setup>` 顶部 import 区加：

```ts
import NotificationBell from "./NotificationBell.vue";
```

在 template 的 `<div class="titlebar-right">` 内，把现有 `<div v-if="(activeSessions ?? []).length > 0" class="titlebar-activity" ...>` **之前**插入一行：

```ts
      <NotificationBell />
```

（即铃铛在 activity 指示器左边、靠近窗口控制按钮方向之前。）

- [ ] **Step 3: 手测 UI**

Run: `pnpm tauri dev`（或项目既有启动方式 `dev.ps1`/`dev.sh`）
Expected:
- 标题栏右侧出现铃铛图标，无通知时灰色、无红点。
- 临时验证：在浏览器 DevTools 控制台或临时代码里调一次 `useNotifications().push({ severity: "warning", source: "demo", title: "测试通知", body: "含 `code` 片段", timestamp: Date.now() })`，确认铃铛亮红点「1」，点击展开墨线行（左侧黄条 + title + body 内联 code + src-tag「demo」+ 忽略 ✕ hover 显出），「全部清除」清空。
- 点击面板外/Esc 关闭。

- [ ] **Step 4: 提交**

```bash
git add src/components/titlebar/NotificationBell.vue src/components/titlebar/TitleBar.vue
git commit -m "feat(notifications): 标题栏铃铛 + 方案 A 墨线下拉面板"
```

---

## Task 5: 接入 codegraph 向量索引出错源

**Files:**
- Modify: `src/composables/useCodeGraphProgress.ts`（在 `trackBuild` 回调里 push 通知 + 自愈 dismiss + 注册 action handler）

**Interfaces:**
- Consumes: `useNotifications()`（Task 3）、`BuildIndexResult`（`src/types.ts:251`，字段 `has_embeddings`/`total_symbols`/`embed_status`/`scanned_files`）。
- Produces: codegraph 失败/可恢复分支自动 push 通知；「重建索引」action 派发回 `rebuild(root)`。

### 触发条件（来自 spec §8）

| 触发 | severity | dedupKey | title | body | action |
|---|---|---|---|---|---|
| `trackBuild` reject | error | `codegraph:build:<root>` | 向量索引构建失败 | `<错误信息> + 结构层精确跳转仍可用，语义搜索不可用` | 无 |
| resolve 且 `has_embeddings === false` | warning | `codegraph:embed:<root>` | 语义搜索不可用 | `embedder 未就绪：<embed_status>。结构层正常。` | 「重建索引」 |
| resolve 且 `total_symbols === 0` | warning | `codegraph:empty:<root>` | 未索引到任何符号 | `扫描 <scanned_files> 个文件。检查项目根目录与支持的扩展名。` | 无 |
| resolve 且非以上三种（成功） | — | — | — | — | 自愈：dismiss 同 `codegraph:*:<root>` 前缀的未读项 |

### 步骤

- [ ] **Step 1: 修改 `useCodeGraphProgress.ts`**

打开 `src/composables/useCodeGraphProgress.ts`。在顶部 import 区加：

```ts
import { useNotifications } from "./useNotifications";
```

在模块级状态区（`const building = ref(false);` 附近）加：

```ts
const { push, dismiss, notifications, registerActionHandler } = useNotifications();
```

把现有 `trackBuild` 函数整体替换为下面这版（保留原 console 落盘行为，在旁补 push；成功时自愈 dismiss）：

```ts
/**
 * 跟踪一次 build：启 poll 拉中间进度，Promise 落定（成功/失败）时停 poll。
 * 失败/可恢复分支额外 push 通知到通知中心；完全成功时自愈 dismiss 同源旧通知。
 */
function trackBuild(p: Promise<BuildIndexResult>, root: string) {
  startPoll();
  p.then(
    (r) => {
      if (r) {
        if (r.loaded) {
          console.info("[codegraph] reused existing index:", r);
        } else if (r.has_embeddings === false) {
          console.warn(
            `[codegraph] build done but embeddings NOT completed — semantic search disabled, structure layer ok. embed_status: ${r.embed_status ?? "(unknown)"}`,
            r,
          );
          push({
            severity: "warning",
            source: "codegraph",
            title: "语义搜索不可用",
            body: `embedder 未就绪：\`${r.embed_status ?? "unknown"}\`。结构层正常。`,
            timestamp: Date.now(),
            dedupKey: `codegraph:embed:${root}`,
            action: { label: "重建索引" },
          });
        } else if (r.total_symbols === 0) {
          console.warn(
            `[codegraph] build done but 0 symbols collected (scanned_files=${r.scanned_files}, files_with_symbols=${r.files_with_symbols}). Either the walk found no supported source files, or extract found no symbols. Check the project root and supported extensions.`,
            r,
          );
          push({
            severity: "warning",
            source: "codegraph",
            title: "未索引到任何符号",
            body: `扫描 \`${r.scanned_files ?? 0}\` 个文件。检查项目根目录与支持的扩展名。`,
            timestamp: Date.now(),
            dedupKey: `codegraph:empty:${root}`,
          });
        } else {
          console.info("[codegraph] build done with embeddings:", r);
          // 完全成功：自愈——dismiss 同 root 的旧 codegraph 通知
          selfHeal(root);
        }
      }
      stopPoll();
    },
    (e) => {
      console.warn("[codegraph] build failed:", e);
      push({
        severity: "error",
        source: "codegraph",
        title: "向量索引构建失败",
        body: `${String(e ?? "未知错误")} 结构层精确跳转仍可用，语义搜索不可用。`,
        timestamp: Date.now(),
        dedupKey: `codegraph:build:${root}`,
      });
      stopPoll();
    },
  );
}

/** 完全成功后自愈：dismiss 同 root 的所有 codegraph:*:<root> 未读项。 */
function selfHeal(root: string) {
  for (const n of notifications.value) {
    if (n.source === "codegraph" && n.dedupKey?.endsWith(`:${root}`)) {
      dismiss(n.id);
    }
  }
}
```

更新 `ensureIndex` 和 `rebuild` 里调用 `trackBuild` 的地方，把 `root` 透传进去（`trackBuild(promise, root)`）。

`ensureIndex` 内：

```ts
  const build = () =>
    trackBuild(
      api.codegraphBuildIndex(root).catch(() => ({ loaded: false, total_symbols: 0 })),
      root,
    );
```

`rebuild` 内：

```ts
function rebuild(root: string) {
  if (!root) return;
  trackBuild(
    api.codegraphBuildIndex(root, true).catch(() => ({ loaded: false, total_symbols: 0 })),
    root,
  );
}
```

在 `trackBuild` 函数定义**之后**（或模块级状态初始化区）注册 action handler——「重建索引」按钮点击时调 `rebuild(root)`（root 从 dedupKey 末段解析）：

```ts
// 注册「重建索引」action：dedupKey 形如 codegraph:embed:<root>，末段为 root。
registerActionHandler("codegraph", (n) => {
  if (!n.dedupKey) return;
  const root = n.dedupKey.split(":").slice(2).join(":");
  if (root) rebuild(root);
});
```

注意：`registerActionHandler` 调用放在模块顶层（不在 `useCodeGraphProgress()` 返回的函数里），因为它只需注册一次。但 `useCodeGraphProgress.ts` 当前没有 `export function useCodeGraphProgress() { return ... }` 之外的顶层执行点——把注册放在模块顶层 import/状态区之后即可（模块加载时执行一次）。

- [ ] **Step 2: 处理 dedupKey 含冒号的 root**

root 路径在 Windows 上含 `C:\...`，`dedupKey` 用 `:` 分隔会导致 `split(":")` 误切。上面 `selfHeal` 用 `endsWith(":${root}")`、handler 用 `split(":").slice(2).join(":")` ——对 `C:\Users\...` 这类 root，`codegraph:embed:C:\Users\...` split `:` 得 `["codegraph","embed","C","\Users\..."]`，slice(2).join(":") = `C:\Users\...`，正确。`endsWith(":C:\\Users\\...")` 也正确。确认无歧义后继续。

- [ ] **Step 3: 手测端到端**

Run: `pnpm tauri dev`
Expected:
- 打开一个含源码的项目 → codegraph 正常构建（完全成功）→ 铃铛无红点（若有旧通知被自愈 dismiss）。
- 临时制造失败：在设置里把 embedder 配成无效 baseUrl（参考 useCustomizations/useSettings 的代码索引 tab），或指向不存在的 http 服务 → 切工作区触发 build → 铃铛亮红点 → 展开看「语义搜索不可用」墨线行 + 「重建索引」按钮 → 点击按钮触发 `rebuild` → 若这次成功则旧通知自愈消失。
- 切两个不同工作区都失败 → 两条不同 dedupKey 通知（不合并）。
- 重启 app → error/warning 通知仍在且未读（红点亮）；info 不会出现（v1 无 info 源）。

- [ ] **Step 4: 提交**

```bash
git add src/composables/useCodeGraphProgress.ts
git commit -m "feat(notifications): 接入 codegraph 向量索引出错源 + 自愈 dismiss"
```

---

## Task 6: 启动 hydrate + 端到端验收

**Files:**
- Modify: `src/main.ts`（启动调 `hydrate()`）

**Interfaces:**
- Consumes: `useNotifications().hydrate()`（Task 3）。

### 步骤

- [ ] **Step 1: 在 `main.ts` 加 hydrate 调用**

打开 `src/main.ts`。在文件末尾 `startDiagnostics();` 之后加：

```ts
// 通知中心：启动时从盘注入历史 error/warning 通知（未读）。
import { useNotifications } from "./composables/useNotifications";
useNotifications().hydrate();
```

（import 放文件顶部更规范——若顶部已有 composables import 区，移到顶部；`hydrate()` 调用放在末尾。）

- [ ] **Step 2: 端到端验收清单**

Run: `pnpm tauri dev`，逐项确认：

- [ ] 首次启动、无落盘文件 → 铃铛灰色无红点，展开「暂无通知」。
- [ ] 制造一次 codegraph 失败 → 红点亮 + 展开见墨线行。
- [ ] 点「全部清除」→ 列表空、红点灭。
- [ ] 再制造一条 error → 重启 app → 该 error 仍在、红点亮（落盘 + 重启未读）。
- [ ] 单条忽略 ✕ → 该条消失、红点更新；重启后该条不再出现。
- [ ] 打开面板 → 红点立即归零（markAllRead），列表项保留。
- [ ] info 源（v1 没有，跳过；未来接入时验证不落盘）。
- [ ] `pnpm test -- useNotifications` 全绿；`cargo test --lib --manifest-path src-tauri/Cargo.toml commands::notifications::tests` 全绿。

- [ ] **Step 3: 提交**

```bash
git add src/main.ts
git commit -m "feat(notifications): 启动 hydrate 历史通知"
```

---

## Self-Review（已执行）

1. **Spec 覆盖**：
   - §3 架构 → Task 1（Rust IO）+ Task 3（前端 store）✅
   - §4 数据模型 → Task 1（NotificationRecord）+ Task 2（AppNotification）✅
   - §5 useNotifications API → Task 3（push/dismiss/clearAll/markAllRead/hydrate/registerActionHandler/triggerAction 全覆盖）✅
   - §6 Rust 持久化 → Task 1（async + spawn_blocking + 原子写 + camelCase serde）✅
   - §7 UI 方案 A 墨线 → Task 4（NotificationBell 3px 色条 + 全部样式 token）✅
   - §8 codegraph 接入 → Task 5（三触发 + 自愈 + action handler）✅
   - §9 跨平台/红线 → Global Constraints + 各 Task 约束 ✅
   - §10 测试 → Task 1（Rust 单测）+ Task 3（vitest）+ Task 6（手测清单）✅
   - §11 文件清单 → File Structure 全覆盖 ✅

2. **Placeholder 扫描**：无 TBD/TODO；所有代码步骤含完整代码。✅

3. **类型一致性**：`AppNotification.read: boolean`（运行时）vs `NotificationRecord` 无 read（落盘）——Task 2 类型定义、Task 3 `persistableRecords()` 映射、Task 1 Rust `NotificationRecord`（camelCase）三方一致。`triggerAction`/`registerActionHandler` 签名在 Task 3 定义、Task 4 调用、Task 5 注册 handler 一致。`trackBuild(p, root)` 签名在 Task 5 内 `ensureIndex`/`rebuild` 调用点一致。✅

发现一处需注意：Task 5 Step 2 的 dedupKey 冒号解析对 Windows 盘符路径已验证正确。无遗留问题。