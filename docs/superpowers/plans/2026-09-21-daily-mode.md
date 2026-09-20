# 日常模式 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 aide 一个「日常」模式 —— 新建对话页分「日常 / 工程」两段（默认日常），日常会话不属于任何项目、档位默认快速、右栏切进去即收起，侧栏顶部出现一栏「日常」直接列出这些会话。

**Architecture:** 日常背后是**一个真实的、对 UI 隐身的工作区**（`~/.aide/workspace`）。整个特性只有一个新概念：`isDailyKey(wsKey)`。会话归属、档位默认、右栏策略、侧栏分组全由这一条判定驱动，**零新增会话字段**（归属本来就是会话属性）。

**Tech Stack:** Tauri v2 (Rust) + Vue 3 `<script setup>` + TypeScript；测试 vitest（`pnpm test`，include 覆盖 `src/**`、`packages/**`、`agent-sidecar/src/**`）+ Rust `#[cfg(test)]`；共享逻辑落 `packages/aide-sdk`。

**Spec:** `docs/superpowers/specs/2026-09-20-daily-mode-design.md`（执行前通读；本计划的每个任务都从它的某一条推出来）

## Global Constraints

- **单一事实源**：日常归属判定与列表过滤只准有一份实现，落 `packages/aide-sdk`；业务代码禁止再写一份（CLAUDE.md「能力单一事实源」）。
- **跨平台**：路径拼接一律 `PathBuf`/`path.join`，不硬编码 `\\`；平台特有逻辑 `#[cfg(windows)]` 隔离。
- **禁止装饰性控件**：只有文案不同的模式不做（spec「模式表」）。两轴先做两条。
- **主题是配色的唯一来源**：任何颜色/圆角/边框走 `var(--aide-*)` 语义 token，禁止硬编码 hex（`src/themes/`）。
- **提交范围**：`git add` 只加本任务涉及的文件。执行本计划时 master 上可能存在无关的未提交改动（如 ohos/ 下的），**不许顺手裹进来**；`git commit` 前先 `git status` 确认。未经用户明确同意不 `push`。
- **TS 红线**：`any` 零容忍（用 `unknown` + 收窄）；禁空 catch；async 错误必处理。
- **组件 ≤ 40 行函数 / 嵌套 ≤ 3 层 / 单函数输入 ≤ 4**：本计划新增的纯函数都按这条设计（见各任务签名）。

---

## Phase 0：单文件 HTML 原型（先看后写）

目的：UI 形态先给用户过目再动代码（仓库既有惯例：界面/交互改动先交单文件 HTML 原型确认）。**本阶段不写任何产品代码。** 用户确认后才进 Phase 1，且原型里定下的文案会被后面直接采用。

### Task 1: 日常模式原型页

**Files:**
- Create: `docs/prototypes/daily-mode.html`
- Reference: `src/themes/glass.ts`（抄语义 token 值）、`src/components/ChatPanel/hero/VariantMorning.vue`（现状 hero 的视觉）、`src/components/SidebarLeft.vue:485-607`（侧栏分区树现状）

**Interfaces:**
- Consumes: 无
- Produces: 用户对 UI 形态的确认；被确认的文案串（Task 4/5 直接采用）

- [ ] **Step 1: 写原型文件**

单文件、零依赖、双击可开。`<style>` 里 `:root` 定义从 `src/themes/glass.ts` **抄来**的语义 token（`--aide-bg`、`--aide-surface`、`--aide-text-primary`、`--aide-text-secondary`、`--aide-text-muted`、`--aide-border`、`--aide-border-subtle`、`--aide-accent` 八个别漏），后面所有颜色只用 `var(--aide-*)`。

页面分左右两块：

**左：侧栏（宽 260px，复刻「会话」分区）**

```
「会话」                        ← 分区头，带 chevron + 计数
  ├ 日常                  3     ← 新增段：栏头（chevron + 名字 + 计数 + ⋯）
  │   ├ 今天想聊点什么…    2小时前
  │   ├ 帮我看看这段话      昨天
  │   └ 什么是向量数据库    3天前
  └ 📁 C:\Users\<user>\IdeaProjects\aide   2   ← 现有工作区行
      └ 确认AIDE桌面端与鸿…  10天前
「自动化」                      ← 分区头（灰态即可，示意这里还有一栏）
```

**右：新建对话页（hero + 输入盒）**

```
            ┌──────────────────────────┐
            │  日常  │  工程            │   ← 居中分段控件（日常选中：深底白字药丸）
            └──────────────────────────┘

        9月21日 · 星期一 · 14:32   下午好。
        今天想聊点什么？                        ← headline（48px）
        随便问，不用先想清楚要干什么。            ← body

        ────────────────────────

              ⚡ 快速                            ← 唯一的环境脚注：档位（无工作区！）

     ┌────────────────────────────────────────┐
     │ 今天想聊点什么？                          │   ← placeholder
     │                                        │
     │  +                          ⚡快速 ⌄  ➤ │
     └────────────────────────────────────────┘
```

- [ ] **Step 2: 让原型可交互（两个模式的真实差异要能摸到）**

点「日常 / 工程」切换，**右侧四处同时变**：

| 处 | 日常 | 工程 |
|---|---|---|
| headline / body | 日常文案池第 1 条 | `今天想从哪块代码开始？` / `发个目标、贴段报错，或直接指个文件——我先读代码再动手。` |
| 环境脚注 | `⚡ 快速` | `新会话位于  📁 aide ▾  ·  ⚡ 进阶` |
| placeholder | `今天想聊点什么？` | `你正在解决什么问题？` |

日常文案池（5 条，与工程池同构：headline = 行动邀请，body = 怎么开始）：

1. `今天想聊点什么？` / `随便问，不用先想清楚要干什么。`
2. `有什么想弄明白的？` / `概念、原理、一段看不懂的文字，贴过来就行。`
3. `要写点什么吗？` / `措辞、总结、翻译、换个口气 —— 说个大概，我来起草。`
4. `在琢磨什么事？` / `先把想法倒出来，我帮你理一理。`
5. `有什么要查的？` / `问一句就行，我整理好再给你。`

再加一个「换一条文案」按钮轮换池子，让用户看到不是只有一条。

- [ ] **Step 3: 打开给用户看**

Run: `start docs/prototypes/daily-mode.html`（Windows）
Expected: 浏览器打开原型；请用户点两个模式各看一遍

- [ ] **Step 4: 拿确认再往下走（硬门）**

把原型给用户，问：文案 / 布局 / 分段控件位置 / 日常的"没有工作区"是否成立。
**用户说改就改原型再问；用户确认前不许进 Phase 1。**

- [ ] **Step 5: 提交原型**

```bash
git add docs/prototypes/daily-mode.html
git commit -m "docs(prototype): 日常模式原型页（新建页两段切换 + 侧栏日常栏）"
```

---

## Phase 1：后端日常工作区（Rust）

一条判定 + 一个隐身注册条目 + 一个查询命令。**不改 cwd 解析链、不改 `list_sessions`、不激活它。**

### Task 2: 日常目录的创建、注册与隐身

**Files:**
- Create: `src-tauri/src/commands/workspace/daily.rs`
- Modify: `src-tauri/src/commands/workspace/mod.rs`（加 `mod daily;`、`list_workspaces` 过滤、导出命令）
- Modify: `src-tauri/src/lib.rs:74-91`（启动引导，紧跟在 `ensure_registry_migrated()` 之后）

**Interfaces:**
- Consumes: `workspace::normalize_registration_path`（`workspace/mod.rs`）、`registry::ensure_workspace_registered`（`registry.rs:247-269`）、`commands::our_config_dir()`（`commands/mod.rs:281-285`）、`workspace::path_to_key`（`workspace/mod.rs:34-41`）
- Produces:
  - `workspace::daily::daily_path_in(config_dir: &Path) -> PathBuf`
  - `workspace::daily::is_daily_path(daily_dir: &Path, path: &str) -> bool`
  - `workspace::daily::ensure_daily_workspace() -> Result<(), String>`
  - Tauri 命令 `daily_workspace() -> DailyWorkspace { key: String, path: String }`（纯计算，无 IO，故保持同步且无需 `trace_command`）

- [ ] **Step 1: 写失败测试**

`src-tauri/src/commands/workspace/daily.rs`：

```rust
//! 「日常」模式的底层工作区：一个真实目录，存在且已注册，但对所有工作区列表隐身。
//!
//! 为什么必须真目录：会话子进程必须有 cwd，且 key = path_to_key(path) 是信任 /
//! 记忆目录 / run configs / 会话归属的共同锚。
//! 为什么必须隐身：它是实现细节，不是用户要管理的项目（spec 2026-09-20）。

use std::path::{Path, PathBuf};

/// 日常目录 = `<配置目录>/workspace`。纯函数（配置目录由调用方给），便于测试。
pub fn daily_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join("workspace")
}

/// 是不是日常目录：按注册表同源的规范化路径比较（trim + 去尾部斜杠）。
pub fn is_daily_path(daily_dir: &Path, path: &str) -> bool {
    super::normalize_registration_path(&daily_dir.to_string_lossy())
        == super::normalize_registration_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_path_is_workspace_under_config_dir() {
        let p = daily_path_in(Path::new("C:/cfg"));
        assert_eq!(super::super::normalize_registration_path(&p.to_string_lossy()), "C:/cfg/workspace");
    }

    #[test]
    fn is_daily_path_matches_trailing_separator() {
        let daily = PathBuf::from(r"C:\cfg\workspace");
        assert!(is_daily_path(&daily, r"C:\cfg\workspace"));
        assert!(is_daily_path(&daily, r"C:\cfg\workspace\"));
    }

    #[test]
    fn is_daily_path_rejects_other_dirs() {
        let daily = PathBuf::from(r"C:\cfg\workspace");
        assert!(!is_daily_path(&daily, r"C:\cfg\other"));
        assert!(!is_daily_path(&daily, r"C:\cfg\workspace\sub"));
        assert!(!is_daily_path(&daily, ""));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib daily:: 2>&1 | tail -20`
Expected: 编译失败（`daily` 模块还没挂进 `workspace/mod.rs`）或 `assertion failed`

- [ ] **Step 3: 挂模块 + 加引导函数**

`workspace/mod.rs` 顶部模块声明处加 `pub mod daily;`（与既有 `pub mod registry;` 同批）。

`daily.rs` 追加引导（IO 部分与纯逻辑分开，纯逻辑已被 Step 1 覆盖）：

```rust
/// 启动引导：确保日常目录存在 + 已注册。**不激活**（活动工作区仍由用户/恢复链决定）。
///
/// 目录必须存在，不只是为了能当 cwd：`resolve_path_from_key` 的反解逐段校验
/// 存在性（workspace/mod.rs:1071-1089），目录不在则侧栏「日常」栏会整段列不出
/// 会话（spec「待验证」）。
pub fn ensure_daily_workspace() -> Result<(), String> {
    let dir = daily_path_in(&crate::commands::our_config_dir());
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    super::registry::ensure_workspace_registered(&dir)
}
```

`workspace/mod.rs` 里加查询命令（纯计算，无 IO）：

```rust
/// 日常模式的归属（key + path）。给前端做 isDailyKey 判定与落点绑定用。
/// 纯计算无 IO：路径由配置目录推出，key 与注册时同一条链（normalize → path_to_key）。
#[tauri::command]
pub fn daily_workspace() -> DailyWorkspace {
    let dir = daily::daily_path_in(&crate::commands::our_config_dir());
    let path = normalize_registration_path(&dir.to_string_lossy());
    let key = path_to_key(&path);
    DailyWorkspace { key, path }
}

#[derive(serde::Serialize)]
pub struct DailyWorkspace {
    pub key: String,
    pub path: String,
}
```

- [ ] **Step 4: 让日常条目在 list_workspaces 里隐身**

`workspace/mod.rs:391-400` 的 `list_workspaces` 改为：

```rust
#[tauri::command]
pub async fn list_workspaces() -> Result<Vec<WorkspaceInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let config = super::settings::load_state();
        let daily = daily::daily_path_in(&crate::commands::our_config_dir());
        let mut infos = infos_from_registry(&config, |p| std::path::Path::new(p).exists());
        // 日常目录存在且已注册（cwd / 信任 / 记忆的锚），但它不是用户要管理的项目：
        // 从所有工作区列表（侧栏分组、WorkspacePicker）里剔除（spec 2026-09-20）。
        infos.retain(|w| !daily::is_daily_path(&daily, &w.name));
        Ok(infos)
    })
    .await
    .map_err(|e| format!("list_workspaces panicked: {}", e))?
}
```

- [ ] **Step 5: 接启动引导 + 注册命令**

`src-tauri/src/lib.rs`：在 `ensure_registry_migrated()` 那段（`:76-78`）之后、`load_workspace_state()`（`:79`）之前插入：

```rust
    // 日常目录引导：建目录 + 幂等注册。**不激活**——活动工作区仍由下面的恢复链
    // 与用户操作决定（spec：不自动激活，否则会顶掉用户的当前项目）。
    if let Err(e) = commands::workspace::daily::ensure_daily_workspace() {
        eprintln!("[aide] daily workspace bootstrap failed: {e}");
    }
```

并在 `invoke_handler` 的命令清单里加上 `commands::workspace::daily_workspace`（与 `list_workspaces` 相邻）。

- [ ] **Step 6: 跑测试**

Run: `cd src-tauri && cargo test --lib daily:: 2>&1 | tail -20`
Expected: 3 个测试全 PASS

- [ ] **Step 7: 编译 + 冒烟验证命令真的通**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: 无 error

启动 dev 后手动验证（这一步是 spec「待验证」那条的前半）：

```bash
cat ~/.aide/state.json | grep -o '"[^"]*workspace[^"]*"' | head
ls ~/.aide/workspace   # 目录应存在
```

Expected: `registeredWorkspaces` 里有 `~/.aide/workspace` 条目；`list_workspaces` 的返回里**没有**它（用 dev 侧栏看：列表里不该多出一项）。

- [ ] **Step 8: 提交**

```bash
git add src-tauri/src/commands/workspace/daily.rs src-tauri/src/commands/workspace/mod.rs src-tauri/src/lib.rs
git commit -m "feat(workspace): 日常目录引导 + 隐身注册（存在、已注册、不出现在任何工作区列表）"
```

---

## Phase 2：SDK 单一判定 + 列表过滤

### Task 3: `dailyWorkspace` 模块（唯一判定来源）

**Files:**
- Create: `packages/aide-sdk/src/utils/dailyWorkspace.ts`
- Create: `packages/aide-sdk/src/utils/dailyWorkspace.test.ts`
- Modify: `packages/aide-sdk/src/api.ts`（加 `dailyWorkspace()` 绑定，与 `listWorkspaces()` 相邻）
- Modify: `src/composables/useWorkspaces.ts:13-19`（列表过滤）

**Interfaces:**
- Consumes: `api.dailyWorkspace()`（Rust 命令 `daily_workspace`）
- Produces:
  - `ensureDailyWorkspace(): Promise<boolean>`
  - `setDailyWorkspace(key: string, path: string): void`
  - `isDailyKey(key: string | null | undefined): boolean`
  - `dailyWorkspaceBind(): { wsKey: string; wsPath: string } | null`
  - `visibleWorkspaces(list: WorkspaceInfo[]): WorkspaceInfo[]`
  - `__resetDailyWorkspaceForTest(): void`

**设计要点（照抄的理由）**：纯策略与 IO 分开 —— 判定 / 过滤是纯函数（测试不碰 transport），只有 `ensureDailyWorkspace` 那 8 行碰 `api`。这是本仓库既有范式（`lsp_language_ids_of` 就是"拆出纯路径部分以便离开 AppHandle 也能测"）。

- [ ] **Step 1: 写失败测试**

`packages/aide-sdk/src/utils/dailyWorkspace.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  isDailyKey, dailyWorkspaceBind, visibleWorkspaces,
  setDailyWorkspace, __resetDailyWorkspaceForTest,
} from "./dailyWorkspace";
import type { WorkspaceInfo } from "../types";

const ws = (key: string, name: string): WorkspaceInfo => ({ key, name, missing: false });

describe("dailyWorkspace", () => {
  beforeEach(() => __resetDailyWorkspaceForTest());

  it("日常 key 未装载前，任何 key 都不是日常", () => {
    expect(isDailyKey("C--Users-heaven-.aide-workspace")).toBe(false);
    expect(isDailyKey(null)).toBe(false);
    expect(isDailyKey("")).toBe(false);
    expect(isDailyKey(undefined)).toBe(false);
  });

  it("只有日常那一个 key 判定为真", () => {
    setDailyWorkspace("C--cfg-workspace", "C:/cfg/workspace");
    expect(isDailyKey("C--cfg-workspace")).toBe(true);
    expect(isDailyKey("C--cfg-other")).toBe(false);
    expect(isDailyKey("")).toBe(false);
  });

  it("dailyWorkspaceBind 给出会话归属绑定（空白 tab / hero 落点用）", () => {
    expect(dailyWorkspaceBind()).toBeNull();
    setDailyWorkspace("C--cfg-workspace", "C:/cfg/workspace");
    expect(dailyWorkspaceBind()).toEqual({ wsKey: "C--cfg-workspace", wsPath: "C:/cfg/workspace" });
  });

  it("visibleWorkspaces 只剔除日常，其余顺序不动", () => {
    setDailyWorkspace("daily", "C:/cfg/workspace");
    const list = [ws("a", "A"), ws("daily", "D"), ws("b", "B")];
    expect(visibleWorkspaces(list).map((w) => w.key)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/aide-sdk/src/utils/dailyWorkspace.test.ts`
Expected: FAIL —— `Failed to resolve import "./dailyWorkspace"`

- [ ] **Step 3: 写实现**

`packages/aide-sdk/src/utils/dailyWorkspace.ts`：

```ts
/**
 * 「日常」模式的归属 —— 全项目唯一判定来源（桌面 + PWA 共用）。
 *
 * 日常背后是一个真实工作区（`<配置目录>/workspace`），它对 UI 隐身：不在
 * list_workspaces 里、不激活、WorkspacePicker 看不到。会话是不是"日常"，等价于
 * 它的 wsKey 是不是这一个。
 *
 * 纯策略（isDailyKey / visibleWorkspaces）与 IO（ensureDailyWorkspace）分开：
 * 前者可脱离 transport 测试。
 */
import { api } from "../api";
import type { WorkspaceInfo } from "../types";

let dailyKey: string | null = null;
let dailyPath = "";
let inflight: Promise<boolean> | null = null;
let unavailable = false;

/** 装载归属（ensureDailyWorkspace 内部用；测试可直接喂）。 */
export function setDailyWorkspace(key: string, path: string): void {
  dailyKey = key;
  dailyPath = path;
}

/** 懒加载一次并缓存；失败（如远程端没有这条命令）只 warn 一次并返回 false。 */
export async function ensureDailyWorkspace(): Promise<boolean> {
  if (dailyKey) return true;
  if (unavailable) return false;
  inflight ??= api
    .dailyWorkspace()
    .then((w) => {
      setDailyWorkspace(w.key, w.path);
      return true;
    })
    .catch((e: unknown) => {
      unavailable = true;
      console.warn("[daily] 日常归属不可用（远程端无此命令？）", e);
      return false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function isDailyKey(key: string | null | undefined): boolean {
  return !!key && key === dailyKey;
}

/** 日常会话的归属（空白 tab / hero 落点绑定用）；未装载时 null。 */
export function dailyWorkspaceBind(): { wsKey: string; wsPath: string } | null {
  return dailyKey ? { wsKey: dailyKey, wsPath: dailyPath } : null;
}

/** 从工作区列表里剔除日常条目（唯一过滤点，别在渲染期再滤一次）。 */
export function visibleWorkspaces(list: WorkspaceInfo[]): WorkspaceInfo[] {
  return list.filter((w) => !isDailyKey(w.key));
}

/** 仅测试用：清掉模块级缓存（同文件多个用例共享模块实例）。 */
export function __resetDailyWorkspaceForTest(): void {
  dailyKey = null;
  dailyPath = "";
  inflight = null;
  unavailable = false;
}
```

`packages/aide-sdk/src/api.ts` —— 在 `listWorkspaces` 之后加：

```ts
  /** 日常模式的归属（key + path）。桌面独有：远程注册表不含此命令，SDK 侧降级为 warn。 */
  dailyWorkspace(): Promise<{ key: string; path: string }> {
    return getTransport().invoke("daily_workspace");
  },
```

`src/composables/useWorkspaces.ts` —— `refresh()` 改一行：

```ts
  async function refresh() {
    try {
      // 日常目录对 UI 隐身：唯一过滤点在这里（SDK 的 visibleWorkspaces），
      // 侧栏与 WorkspacePicker 都经此列表，别在渲染期再滤一次。
      workspaces.value = visibleWorkspaces(await api.listWorkspaces());
    } catch (_e) {
      workspaces.value = [];
    }
  }
```

（顶部 import 加 `import { visibleWorkspaces } from "@aide/sdk/utils/dailyWorkspace";` —— 路径按该文件既有的 SDK 引用写法对齐。）

- [ ] **Step 4: 跑测试**

Run: `npx vitest run packages/aide-sdk/src/utils/dailyWorkspace.test.ts`
Expected: 4 个用例 PASS

- [ ] **Step 5: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | tail -5`
Expected: 无 error

- [ ] **Step 6: 提交**

```bash
git add packages/aide-sdk/src/utils/dailyWorkspace.ts packages/aide-sdk/src/utils/dailyWorkspace.test.ts packages/aide-sdk/src/api.ts src/composables/useWorkspaces.ts
git commit -m "feat(sdk): 日常归属单一判定 + 工作区列表过滤"
```

---

## Phase 3：新建对话页两段切换

### Task 4: 模式表 + 日常文案池（纯逻辑）

**Files:**
- Create: `src/components/ChatPanel/hero/modes.ts`
- Create: `src/components/ChatPanel/hero/modes.test.ts`
- Modify: `src/components/ChatPanel/hero/heroCopy.ts`（加日常池，签名带 mode）
- Modify: `src/components/ChatPanel/hero/heroCopy.test.ts`（跟着改）

**Interfaces:**
- Produces:
  - `type HeroMode = "daily" | "project"`
  - `HERO_MODES: readonly { id: HeroMode; label: string }[]`（`日常` / `工程`）
  - `DEFAULT_HERO_MODE: HeroMode`（`"daily"`）
  - `pickHeroCopy(mode: HeroMode, seed: number): HeroCopy`（**签名变更**：原来是 `pickHeroCopy(seed)`）
  - `heroCopyPool(mode: HeroMode): readonly HeroCopy[]`（测试用）

- [ ] **Step 1: 写失败测试**

`src/components/ChatPanel/hero/modes.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { HERO_MODES, DEFAULT_HERO_MODE } from "./modes";
import { pickHeroCopy, heroCopyPool } from "./heroCopy";

describe("hero 模式表", () => {
  it("默认是日常", () => {
    expect(DEFAULT_HERO_MODE).toBe("daily");
  });

  it("两个模式各有名字", () => {
    expect(HERO_MODES.map((m) => m.id)).toEqual(["daily", "project"]);
    expect(HERO_MODES.map((m) => m.label)).toEqual(["日常", "工程"]);
  });
});

describe("pickHeroCopy", () => {
  it("两个池子的文案不重叠（模式切换必须是看得见的）", () => {
    const daily = new Set(heroCopyPool("daily").map((c) => c.headline));
    const project = new Set(heroCopyPool("project").map((c) => c.headline));
    for (const h of daily) expect(project.has(h)).toBe(false);
  });

  it("每个模式只从自己的池子里取，负数与越界 seed 也落在池内", () => {
    for (const mode of ["daily", "project"] as const) {
      const pool = heroCopyPool(mode);
      expect(pool.length).toBeGreaterThan(0);
      for (const seed of [-7, -1, 0, 3, 9999]) {
        expect(pool).toContain(pickHeroCopy(mode, seed));
      }
    }
  });

  it("同 seed 同文案（纯函数，轮换不抖动）", () => {
    expect(pickHeroCopy("daily", 42)).toEqual(pickHeroCopy("daily", 42));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ChatPanel/hero/modes.test.ts`
Expected: FAIL —— `Failed to resolve import "./modes"`

- [ ] **Step 3: 写 modes.ts**

```ts
/** 新建对话页的两种模式。加第三种的前提是它有真实的行为差异（spec「模式表」）。 */
export type HeroMode = "daily" | "project";

export interface HeroModeSpec {
  readonly id: HeroMode;
  readonly label: string;
}

export const HERO_MODES: readonly HeroModeSpec[] = [
  { id: "daily", label: "日常" },
  { id: "project", label: "工程" },
];

export const DEFAULT_HERO_MODE: HeroMode = "daily";
```

- [ ] **Step 4: 改 heroCopy.ts**

把现有 `COPY_POOL` 改名为 `PROJECT_COPY_POOL`（内容一字不动），新增 `DAILY_COPY_POOL`（文案取自 Task 1 原型确认的池子），并把导出函数改成：

```ts
/** 轮换文案池：全部是「下一步做什么」的行动邀请，body 说明怎么开始。 */
const PROJECT_COPY_POOL: readonly HeroCopy[] = [
  // …原有 5 条，一字不动…
];

/** 日常池：不假设手上有代码，邀请"说点什么"而不是"推进什么"。 */
const DAILY_COPY_POOL: readonly HeroCopy[] = [
  { headline: "今天想聊点什么？", body: "随便问，不用先想清楚要干什么。" },
  { headline: "有什么想弄明白的？", body: "概念、原理、一段看不懂的文字，贴过来就行。" },
  { headline: "要写点什么吗？", body: "措辞、总结、翻译、换个口气 —— 说个大概，我来起草。" },
  { headline: "在琢磨什么事？", body: "先把想法倒出来，我帮你理一理。" },
  { headline: "有什么要查的？", body: "问一句就行，我整理好再给你。" },
];

export function heroCopyPool(mode: HeroMode): readonly HeroCopy[] {
  return mode === "daily" ? DAILY_COPY_POOL : PROJECT_COPY_POOL;
}

/**
 * seed 取模轮换：负数与越界 seed 都落到合法槽（数学模），同 seed 必同文案。
 * idx 经数学模恒 ∈ [0, n)，池为 readonly 非空元组——索引必命中，无兜底臂。
 */
export function pickHeroCopy(mode: HeroMode, seed: number): HeroCopy {
  const pool = heroCopyPool(mode);
  const n = pool.length;
  return pool[((seed % n) + n) % n];
}
```

（顶部 `import type { HeroMode } from "./modes";`）

- [ ] **Step 5: 改现有测试 + 跑全部相关测试**

`heroCopy.test.ts` 里所有 `pickHeroCopy(seed)` 调用改成 `pickHeroCopy("project", seed)`（该文件测的是确定性/轮换性质，断言不变）。

Run: `npx vitest run src/components/ChatPanel/hero/`
Expected: `heroCopy.test.ts` 与 `modes.test.ts` 全 PASS

- [ ] **Step 6: 提交**

```bash
git add src/components/ChatPanel/hero/modes.ts src/components/ChatPanel/hero/modes.test.ts src/components/ChatPanel/hero/heroCopy.ts src/components/ChatPanel/hero/heroCopy.test.ts
git commit -m "feat(hero): 模式表 + 日常文案池（pickHeroCopy 带上模式）"
```

### Task 5: hero 分段控件 + 落点双向写

**Files:**
- Modify: `src/components/ChatPanel/hero/VariantMorning.vue`（加分段控件；日常隐藏归属选择器）
- Modify: `src/components/ChatPanel/hero/types.ts`（`HeroViewProps` 加 `mode`）
- Modify: `src/components/ChatPanel/hero/HeroWelcome.vue`（mode 状态 + 换文案种子）
- Modify: `src/components/ChatPanel/hero/HeroWelcome.test.ts`
- Modify: `src/components/panelayout/PaneGroup.vue:79-155`（分发 mode、写 pendingWs/defaultWs）

**Interfaces:**
- Consumes: `HERO_MODES` / `DEFAULT_HERO_MODE` / `pickHeroCopy(mode, seed)`（Task 4）、`isDailyKey` / `dailyWorkspaceBind` / `ensureDailyWorkspace`（Task 3）
- Produces:
  - `HeroWelcome` props 加 `mode: HeroMode`、emit 加 `select-mode: [mode: HeroMode]`
  - `PaneGroup.onPickMode(mode: HeroMode): void`

**关键设计**：模式的选中态**从落点派生**，不给会话或 tab 加字段 —— 有 `pendingWs` 的空白 tab 看 `isDailyKey(tab.pendingWs?.wsKey)`，落点写回仍走既有 `pl.setTabPendingWs` / `pl.setDefaultWs`。

**⚠️ 执行期修正（2026-09-21，已落地）**：零 tab 欢迎态额外需要一个**布局层意图字段** `layout.heroMode`（`usePaneLayout.ts`，默认 `"daily"`，与 `defaultWs` 同生命周期、不落盘）。原计划的"零新增字段"在这里站不住：「工程 + 还没选工作区」与「日常」在数据上都是"无归属"，只看绑定分不开，而前者真实可达（全新安装）。详见 spec 的同名修正段。

- [ ] **Step 1: 写失败测试（组件测试）**

`HeroWelcome.test.ts` 加：

```ts
import { mount } from "@vue/test-utils";
import HeroWelcome from "./HeroWelcome.vue";

it("默认日常：文案取自日常池，且不显示归属选择器", async () => {
  const w = mount(HeroWelcome, { props: { mode: "daily", workspacePath: "", modelName: "" } });
  expect(w.text()).not.toContain("新会话位于");
  expect(w.find(".va-mode-btn.is-active").text()).toBe("日常");
});

it("点工程：emit 出模式，并显示归属选择器", async () => {
  const w = mount(HeroWelcome, { props: { mode: "project", workspacePath: "C:/p", modelName: "" } });
  expect(w.text()).toContain("新会话位于");
  await w.findAll(".va-mode-btn")[0].trigger("click");
  expect(w.emitted("select-mode")?.[0]).toEqual(["daily"]);
});
```

（若现有 `HeroWelcome.test.ts` 已有挂载脚手架，沿用它，别另起一套。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ChatPanel/hero/HeroWelcome.test.ts`
Expected: FAIL —— 找不到 `.va-mode-btn` / `新会话位于` 断言不成立

- [ ] **Step 3: 改 types.ts 与 VariantMorning.vue**

`types.ts`：

```ts
import type { HeroMode } from "./modes";

export interface HeroViewProps {
  readonly chime: Chime;
  readonly copy: HeroCopy;
  readonly mode: HeroMode;
  /** 当前归属工作区根路径（WorkspacePicker 的勾选高亮依据；日常不用） */
  readonly workspacePath: string;
  readonly modelName: string;
}
```

`VariantMorning.vue`：`defineEmits` 加 `"select-mode": [mode: HeroMode]`；模板在 `.va-greeting` 之前插入分段控件：

```html
    <!-- 模式切换：日常 / 工程（默认日常）。选中的判定来自归属，不由本组件持有 -->
    <div class="va-modes" role="tablist">
      <button
        v-for="m in HERO_MODES"
        :key="m.id"
        class="va-mode-btn"
        :class="{ 'is-active': m.id === mode }"
        role="tab"
        :aria-selected="m.id === mode"
        @click="emit('select-mode', m.id)"
      >{{ m.label }}</button>
    </div>
```

环境脚注分叉（日常**没有工作区**，这是本特性的核心表述）：

```html
    <div class="va-meta">
      <template v-if="mode === 'project'">
        <span class="va-meta-label">新会话位于</span>
        <WorkspacePicker :path="workspacePath" @select="(ws) => emit('select-workspace', ws)" />
        <span class="va-meta-sep">·</span>
      </template>
      <span class="va-meta-model">{{ modelName }}</span>
    </div>
```

样式：`.va-modes` 用 `var(--aide-surface)` 底 + `var(--aide-border-subtle)` 描边 + 圆角；`.is-active` 用 `var(--aide-accent)` 底 + `var(--aide-bg)` 字（沿用仓库现有药丸/分段控件的 token 用法，别新造色）。

- [ ] **Step 4: 改 HeroWelcome.vue（mode 由外部给，种子在切换时重掷）**

```ts
const props = defineProps<{ workspacePath: string; modelName: string; mode: HeroMode }>();
const emit = defineEmits<{ "select-workspace": [ws: WorkspaceInfo]; "select-mode": [mode: HeroMode] }>();

// ── 行动文案：进入欢迎页轮换一条；切模式重掷（否则切过去还是上一条的语义）──
const seed = ref(Math.floor(Math.random() * 10_000));
const copy = computed(() => pickHeroCopy(props.mode, seed.value));
watch(() => props.mode, () => { seed.value = Math.floor(Math.random() * 10_000); });

const viewProps = computed<HeroViewProps>(() => ({
  chime: chime.value,
  copy: copy.value,
  mode: props.mode,
  workspacePath: props.workspacePath,
  modelName: props.modelName || "默认模型",
}));
```

模板把 `@select-mode` 透传上去。

- [ ] **Step 5: 改 PaneGroup.vue（模式从落点派生 + 两个方向都能写）**

```ts
// 当前 tab 的模式：从落点派生，不新增 per-tab 字段（零 tab 看 defaultWs）
const currentMode = computed<HeroMode>(() => {
  const tab = activeTab.value;
  const wsKey = tab?.sessionId ? undefined : (tab?.pendingWs ?? pl.layout.defaultWs)?.wsKey;
  return isDailyKey(wsKey) ? "daily" : "project";
});

/** hero 模式切换：只写归属，不切活动工作区（同 onPickWorkspace 的范式）。 */
async function onPickMode(mode: HeroMode) {
  if (mode === "daily") {
    // 归属绑定需要日常 key/path：首用时懒加载一次
    if (!(await ensureDailyWorkspace())) return;
  }
  const bind = mode === "daily" ? dailyWorkspaceBind() : wsSnapshot() ?? null;
  const tab = activeTab.value;
  if (tab && !tab.sessionId) {
    if (bind) pl.setTabPendingWs(tab.id, bind);
  } else {
    pl.setDefaultWs(bind);
  }
}
```

`onNewTab()` 的默认落点改成日常（契约：新建对话页默认日常）：

```ts
function onNewTab() {
  pl.focusGroup(props.group.id);
  // 默认落在日常（新建对话页默认日常）；用户在 hero 上切到「工程」会改写 pendingWs
  const ws = pl.layout.defaultWs ?? dailyWorkspaceBind() ?? wsSnapshot();
  if (pl.layout.defaultWs) pl.setDefaultWs(null);
  pl.openBlankTab(`新会话 ${new Date().toLocaleTimeString()}`, ws);
}
```

模板里 hero 处传 `:mode="currentMode"` 并接 `@select-mode="onPickMode"`。

**注意**：模式只在**空白 tab / 欢迎态**可切；已有会话的 tab 不渲染 hero，天然没有切换入口（spec 非目标：不做会话改归属）。

- [ ] **Step 6: 跑测试**

Run: `npx vitest run src/components/ChatPanel/hero/ src/composables/usePaneLayout.test.ts`
Expected: 全 PASS

- [ ] **Step 7: 类型检查 + 提交**

Run: `npx vue-tsc --noEmit 2>&1 | tail -5`

```bash
git add src/components/ChatPanel/hero/ src/components/panelayout/PaneGroup.vue
git commit -m "feat(hero): 日常/工程两段切换（模式从落点派生，零新增字段）"
```

---

## Phase 4：输入框 placeholder 按模式

### Task 6: 抽出 placeholder 纯函数并接上日常

**Files:**
- Create: `src/components/ChatPanel/inputPlaceholder.ts`
- Create: `src/components/ChatPanel/inputPlaceholder.test.ts`
- Modify: `src/components/ChatPanel/ChatInputBox.vue:1210`（替换三层嵌套三元）

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `inputPlaceholder(state: { btw: boolean; busy: boolean; hero: boolean; daily: boolean }): string`

**为什么顺手改**：现状是三层嵌套三元写死（`btwMode ? … : (isBusy ? … : (isHero ? … : …))`），加日常就是第四层 —— 撞「嵌套 ≤ 3 层」红线。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { inputPlaceholder } from "./inputPlaceholder";

const base = { btw: false, busy: false, hero: false, daily: false };

describe("inputPlaceholder", () => {
  it("优先级 btw > busy > hero > 普通", () => {
    expect(inputPlaceholder({ ...base, btw: true, busy: true, hero: true, daily: true })).toBe("顺便问一下,不进入主对话…");
    expect(inputPlaceholder({ ...base, busy: true, hero: true, daily: true })).toBe("生成中，发送的消息将排队…");
  });

  it("hero 分模式：日常与工程文案不同", () => {
    expect(inputPlaceholder({ ...base, hero: true, daily: true })).toBe("今天想聊点什么？");
    expect(inputPlaceholder({ ...base, hero: true, daily: false })).toBe("你正在解决什么问题？");
  });

  it("非 hero 的模式差异不泄漏（对话中不按模式改文案）", () => {
    expect(inputPlaceholder({ ...base, daily: true })).toBe("输入消息…");
    expect(inputPlaceholder({ ...base, daily: false })).toBe("输入消息…");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ChatPanel/inputPlaceholder.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写实现**

```ts
/** 输入框 placeholder：优先级 btw > busy > hero(分模式) > 普通。纯函数，便于测。 */
export interface InputPlaceholderState {
  readonly btw: boolean;
  readonly busy: boolean;
  readonly hero: boolean;
  readonly daily: boolean;
}

export function inputPlaceholder(s: InputPlaceholderState): string {
  if (s.btw) return "顺便问一下,不进入主对话…";
  if (s.busy) return "生成中，发送的消息将排队…";
  if (s.hero) return s.daily ? "今天想聊点什么？" : "你正在解决什么问题？";
  return "输入消息…";
}
```

- [ ] **Step 4: 加 `daily` prop 并接进 placeholder（本任务own这个 prop）**

`ChatInputBox.vue` props 加 `daily: boolean`（默认 `false`），模板 `:placeholder` 改成：

```html
        :placeholder="inputPlaceholder({ btw: btwMode, busy: isBusy, hero: isHero, daily: props.daily })"
```

`ChatPanel.vue` props 加 `daily: boolean` 并透传给 `<ChatInputBox :daily="daily" …>`。

`PaneGroup.vue` —— 与 `effectiveWorkspacePath`（`:79-86`）**同源**算这个布尔量（判定函数在 SDK，别在这另写一份）：

```ts
/** 当前 tab 是不是日常：取 key 的通路与 effectiveWorkspacePath 同源。 */
const isDailyTab = computed(() => {
  const tab = activeTab.value;
  const wsKey = tab?.sessionId
    ? workspaceOf(tab.sessionId)?.wsKey
    : tab?.pendingWs?.wsKey ?? pl.layout.defaultWs?.wsKey;
  return isDailyKey(wsKey);
});
```

模板：`<ChatPanel :daily="isDailyTab" …>`。

（Task 8 直接复用这个 prop，不再重复加。）

- [ ] **Step 5: 跑测试 + 提交**

Run: `npx vitest run src/components/ChatPanel/inputPlaceholder.test.ts`

```bash
git add src/components/ChatPanel/inputPlaceholder.ts src/components/ChatPanel/inputPlaceholder.test.ts src/components/ChatPanel/ChatInputBox.vue
git commit -m "refactor(input): placeholder 抽成纯函数，日常模式用自己的文案"
```

---

## Phase 5：档位默认快速

### Task 7: 默认档位解析（纯函数）

**Files:**
- Create: `src/components/ChatPanel/effortDefault.ts`
- Create: `src/components/ChatPanel/effortDefault.test.ts`

**Interfaces:**
- Consumes: `normalizeEffortOption`（`@aide/sdk/utils/effort`）
- Produces: `defaultEffortFor(s: { remembered: string | null; daily: boolean; providerDefault: string }): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { defaultEffortFor } from "./effortDefault";

describe("defaultEffortFor", () => {
  it("用户显式改过的档位最优先（日常也压不过它）", () => {
    expect(defaultEffortFor({ remembered: "max", daily: true, providerDefault: "high" })).toBe("max");
    expect(defaultEffortFor({ remembered: "high", daily: false, providerDefault: "low" })).toBe("high");
  });

  it("日常默认快速，压过 provider 默认", () => {
    expect(defaultEffortFor({ remembered: null, daily: true, providerDefault: "max" })).toBe("low");
  });

  it("工程沿用 provider 默认（现状不变）", () => {
    expect(defaultEffortFor({ remembered: null, daily: false, providerDefault: "max" })).toBe("max");
  });

  it("记住的值走归一（历史 medium/xhigh 迁移）", () => {
    expect(defaultEffortFor({ remembered: "xhigh", daily: true, providerDefault: "high" })).toBe("max");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ChatPanel/effortDefault.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写实现**

```ts
import { normalizeEffortOption } from "@aide/sdk/utils/effort";

/** 日常会话的默认档位：快速（low）。**连带关掉思考**，见 spec 背景「档位」。 */
export const DAILY_DEFAULT_EFFORT = "low";

export interface EffortDefaultInput {
  /** 会话记住的档位（用户显式改过的）；读不到时 null */
  readonly remembered: string | null;
  /** 这个会话/空白 tab 是不是日常 */
  readonly daily: boolean;
  /** provider 配置的默认档位（已归一） */
  readonly providerDefault: string;
}

/**
 * 默认档位解析：记住的 > 日常快速 > provider 默认。
 * 日常排在 provider 之前是刻意的——日常的定位就是快（spec「档位默认快速」）。
 */
export function defaultEffortFor(s: EffortDefaultInput): string {
  if (s.remembered) return normalizeEffortOption(s.remembered);
  if (s.daily) return DAILY_DEFAULT_EFFORT;
  return s.providerDefault;
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/components/ChatPanel/effortDefault.test.ts`
Expected: 4 个用例 PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/ChatPanel/effortDefault.ts src/components/ChatPanel/effortDefault.test.ts
git commit -m "feat(effort): 默认档位解析抽成纯函数（日常默认快速）"
```

### Task 8: 接进 ChatInputBox（三处默认落点）

**Files:**
- Modify: `src/components/ChatPanel/ChatInputBox.vue:180`、`:278-283`、`:287-299`、`:306-310`

**Interfaces:**
- Consumes: `defaultEffortFor`（Task 7）、`ChatInputBox` 的 `daily` prop（Task 6 Step 4 已加）、`providerDefaultEffort()`（`ChatInputBox.vue:195-197` 既有）
- Produces: 无新导出（只改解析链）

- [ ] **Step 1: 确认 `daily` prop 已就位**

`ChatInputBox.vue` 的 `daily: boolean` prop 与 `PaneGroup.vue` 的 `isDailyTab` 已在 **Task 6 Step 4** 落地（placeholder 先用上了它）。本任务不再重复添加 —— 若执行顺序被调换，这里补上即可。

- [ ] **Step 2: ChatInputBox 三处默认落点改用纯函数**

`selectedEffort` 初值（`:180`）保持 `"high"`（组件挂载后立即被下面 watch 覆盖，改它没有意义）。

`:281`（无 sid 分支）：
```ts
      selectedEffort.value = defaultEffortFor({
        remembered: null, daily: props.daily, providerDefault: providerDefaultEffort(),
      });
```

`:293`（切会话、无 currentEffort）：
```ts
    selectedEffort.value = ce
      ? normalizeEffortOption(ce)
      : defaultEffortFor({ remembered: null, daily: props.daily, providerDefault: providerDefaultEffort() });
```

`:297-299`（异步读回 remembered）：
```ts
    selectedEffort.value = defaultEffortFor({
      remembered, daily: props.daily, providerDefault: providerDefaultEffort(),
    });
```

`:309`（provider 就绪兜底）同样改成 `defaultEffortFor` 调用。

- [ ] **Step 3: 加回归测试**

在 `src/components/ChatPanel/effortDefault.test.ts` 之外，给 ChatInputBox 的默认解析加一条组件级回归（若现有测试文件已有挂载脚手架就复用；没有则用 `defaultEffortFor` 的单测 + 手动冒烟兜住，并在提交信息里写明"组件级未自动化"）：

Run: `npx vitest run src/components/ChatPanel/`
Expected: PASS

- [ ] **Step 4: 手动冒烟（必做）**

`pnpm dev` 起 Tauri：

1. 新建对话页（默认日常）→ 输入框右下角档位药丸显示 **快速**
2. 切到「工程」→ 药丸回到 **进阶**（provider 默认）
3. 在日常会话里手动切到 **极致** → 发一条 → 重开该会话 → 仍是 **极致**（记忆优先）
4. 新开一个日常会话 → 又是 **快速**

- [ ] **Step 5: 提交**

```bash
git add src/components/ChatPanel/ChatInputBox.vue src/components/ChatPanel/ChatPanel.vue src/components/panelayout/PaneGroup.vue
git commit -m "feat(effort): 日常会话默认快速（记住的档位仍优先）"
```

---

## Phase 6：侧栏「日常」栏

### Task 9: 「日常」根分区

**Files:**
- Create: `src/components/sidebar/DailySessionsSection.vue`
- Create: `src/components/sidebar/DailySessionsSection.test.ts`
- Modify: `src/components/SidebarLeft.vue:485-607`（在「会话」分区内、工作区列表之前插入该段 + 加载日常会话）

**Interfaces:**
- Consumes: `ensureDailyWorkspace` / `dailyWorkspaceBind`（Task 3）、`api.listSessionsForWorkspace(key)`（既有）
- Produces: 组件 `DailySessionsSection`，props `{ sessions: Session[]; activeSessionId: string; collapsed: boolean }`，emits `{ toggle: []; select: [sid: string]; contextmenu: [payload: { event: MouseEvent; sid: string }]; newSession: [] }`

**为什么单独一个组件**：`SidebarLeft.vue` 已 700+ 行；新段独立成文件，才有一个可测的边界，同时**不碰**现有工作区行的渲染（零回归风险）。

- [ ] **Step 1: 写失败测试**

`src/components/sidebar/DailySessionsSection.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DailySessionsSection from "./DailySessionsSection.vue";
import type { Session } from "@/types";

const s = (id: string, name: string): Session =>
  ({ id, name, timestamp: Date.now(), messageCount: 1 } as unknown as Session);

describe("DailySessionsSection", () => {
  it("栏头写「日常」，计数等于会话数", () => {
    const w = mount(DailySessionsSection, {
      props: { sessions: [s("a", "甲"), s("b", "乙")], activeSessionId: "", collapsed: false },
    });
    expect(w.find(".daily-head").text()).toContain("日常");
    expect(w.find(".daily-count").text()).toBe("2");
  });

  it("零会话显示空态，不显示计数", () => {
    const w = mount(DailySessionsSection, {
      props: { sessions: [], activeSessionId: "", collapsed: false },
    });
    expect(w.text()).toContain("暂无会话");
    expect(w.find(".daily-count").exists()).toBe(false);
  });

  it("点会话行 emit select", async () => {
    const w = mount(DailySessionsSection, {
      props: { sessions: [s("a", "甲")], activeSessionId: "", collapsed: false },
    });
    await w.find(".session-row").trigger("click");
    expect(w.emitted("select")?.[0]).toEqual(["a"]);
  });

  it("折叠时不渲染会话行", () => {
    const w = mount(DailySessionsSection, {
      props: { sessions: [s("a", "甲")], activeSessionId: "", collapsed: true },
    });
    expect(w.find(".session-row").exists()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/sidebar/DailySessionsSection.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写组件**

`DailySessionsSection.vue`：结构照抄 `SidebarLeft.vue:485-601` 的会话行（`.session-row` / `.session-name` / `.session-time` / 左缘 tone 流光类）**与 `SidebarSectionHead` 的栏头范式**，但**去掉工作区行那一层** —— 日常不是工作区，不该有个"📁 路径"的头。

```
<div class="daily-section">
  <div class="daily-head" @click="emit('toggle')">         ← 复用 SidebarSectionHead 的视觉
    <chevron/> <span>日常</span> <span class="daily-count">N</span>
    <button class="row-dots" v-tooltip="'新建日常对话'" @click.stop="emit('newSession')">⋯</button>
  </div>
  <div v-if="!collapsed" class="session-anim-group">
    <div v-for="s in sessions" class="session-row" :class="{ on: s.id === activeSessionId }"
         @click="emit('select', s.id)"
         @contextmenu.prevent="emit('contextmenu', { event: $event, sid: s.id })">
      <span class="session-name">{{ s.name }}</span>
      <span class="session-time">{{ timeAgo(s.timestamp) }}</span>
    </div>
  </div>
</div>
```

props 超过 3 个就撞「单函数输入 ≤ 4」的边（3 个 props 可以），emits 用 `{ event, sid }` 对象化避免相邻同型参数。

- [ ] **Step 4: 接进 SidebarLeft.vue**

1. 模块顶部加 `const dailyKey = ref<string | null>(null);` 与 `const dailySessions = ref<Session[]>([]);`
2. `onMounted` 里（`loadSessions()` 之前）加：

```ts
// 日常栏：先确保归属可用（懒加载一次），再按 key 拉会话。
// 该 key 不出现在 workspaces 列表里（SDK 已过滤），所以这里显式拉一次。
if (await ensureDailyWorkspace()) {
  const bind = dailyWorkspaceBind();
  if (bind) dailySessions.value = await api.listSessionsForWorkspace(bind.wsKey);
}
```

3. 模板在**「会话」分区之外、`<AutomationSidebarSection />` 之前**（即根分区之间，`SidebarLeft.vue:603` 与 `:607` 之间）插入：

```html
      <!-- 日常分区：分区树的第一个根分区（用户 2026-09-21 定：与「会话」并级）。
           「会话」分区的子树渲染一字不动。 -->
      <DailySessionsSection
        :sessions="dailySessions"
        :active-session-id="props.activeSessionId"
        :collapsed="dailyCollapsed"
        @toggle="dailyCollapsed = !dailyCollapsed"
        @select="(sid) => emit('session-changed', sid)"
        @contextmenu="onDailySessionContextMenu"
        @new-session="newSession"
      />
```

**位置约束**：放在 `</div>`（`.session-list` 的会话分区块结束）之后 —— 不是 `.sec-subtree` 内部。并级结构天然不碰工作区循环，这是它的主要收益。

4. 打开日常会话**不需要新函数**：现有 `selectSessionFromWorkspace` 是 `emit("session-changed", sessionId)`（`SidebarLeft.vue:234-236`，wsKey 参数根本没用 —— 打开会话本来就不切活动工作区）。所以 `@select` 直接 emit。

5. `onDailySessionContextMenu({ event, sid })`：复用现有会话右键菜单项构造（`onSessionContextMenu`），工作区参数传 `dailyWorkspaceBind()?.wsKey ?? ""`（拉取时已 ensure 过，这里必然有值）。

6. `totalSessionCount`（`SidebarLeft.vue:60-62`）**不受影响**：日常会话存在独立的 `dailySessions` ref，不进 `sessionsByWorkspace` —— 所以原「会话」分区的计数自然只数项目会话，不用改。
7. 同一步里改分区名（用户 2026-09-21 定）：`SidebarLeft.vue:489` 的 `label="会话"` → `label="项目"`。全仓只有这一处引用这个分区名（`grep '"会话"' src/` 只剩 `App.vue:815` 的最近列表分组，与分区无关）。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run src/components/sidebar/`
Expected: 4 个用例 PASS

- [ ] **Step 6: 手动冒烟（必做）**

`pnpm dev`：
1. 侧栏出现三个根分区：**日常 / 项目 / 自动化**（原「会话」已改名「项目」，其子树一字未变）
2. 在新建页用默认（日常）发一句话 → 会话出现在「日常」分区下
3. 关掉 app 重开 → 会话还在「日常」段下（**这是 spec「待验证」那条的实测**）
4. 点它 → 打开会话；档位药丸是**快速**
5. 「日常」段里没有"未选择工作区"之类的怪状态；工作区列表里没有多出日常目录

- [ ] **Step 7: 提交**

```bash
git add src/components/sidebar/ src/components/SidebarLeft.vue
git commit -m "feat(sidebar): 「会话」分区新增「日常」栏"
```

---

## Phase 7：右栏收起

### Task 10: 切进日常即收起右栏

**Files:**
- Modify: `src/composables/usePaneLayout.ts:427-438`（加 `activeTabWsKey`）
- Modify: `src/composables/useRightPanel.ts`（加 `collapse()`）
- Modify: `src/composables/useRightPanel.test.ts`
- Modify: `src/App.vue`（watch 聚焦 tab 的归属 → 日常则收起）

**Interfaces:**
- Consumes: `isDailyKey`（Task 3）
- Produces:
  - `usePaneLayout().activeTabWsKey: ComputedRef<string>`（`""` = 无归属）
  - `useRightPanel().collapse(): void`

- [ ] **Step 1: 写失败测试**

`src/composables/useRightPanel.test.ts` 加：

```ts
it("collapse 幂等：已经收起再调不报错、不动 tab", () => {
  const rp = useRightPanel();
  rp.select("git");
  rp.collapse();
  expect(rp.collapsed.value).toBe(true);
  rp.collapse();
  expect(rp.collapsed.value).toBe(true);
  expect(rp.tab.value).toBe("git");   // 收起不动「上次看的是哪一栏」
});
```

`src/composables/usePaneLayout.test.ts` 加：

```ts
it("activeTabWsKey：无 tab 为空串，空白 tab 取 pendingWs（与 activeSessionId 同源）", () => {
  const pl = usePaneLayout();
  pl.reset();
  expect(pl.activeTabWsKey.value).toBe("");
  expect(pl.activeSessionId.value).toBe("");

  pl.openBlankTab("新会话", { wsKey: "daily", wsPath: "C:/cfg/workspace" });
  expect(pl.activeTabWsKey.value).toBe("daily");
  expect(pl.activeSessionId.value).toBe("");   // 空白 tab 无会话
});
```

（"有会话时取注册表"那一路要靠 `useSessionWorkspaces` 的注册表夹具，不由本用例覆盖 —— 它由 Task 10 的手动冒烟第 1 条兜住。若该测试文件没有 `reset` 或已有 fixture/teardown 惯例，沿用它。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/useRightPanel.test.ts src/composables/usePaneLayout.test.ts`
Expected: FAIL —— `collapse is not a function` / `activeTabWsKey` undefined

- [ ] **Step 3: 实现**

`useRightPanel.ts`：

```ts
/** 收起右栏（只留竖直 rail）。幂等；不动 tab —— "上次看的是哪一栏"是记着的。 */
function collapse() {
  collapsed.value = true;
}
```
并加进 `return { … }`。

`usePaneLayout.ts` —— 紧跟 `activeSessionId` 之后：

```ts
    /** 聚焦组激活 tab 的工作区归属 key（"" = 无归属/欢迎态）。右栏模式策略等下游用，
     *  与 activeSessionId 同源同源取值，别在别处重算。 */
    activeTabWsKey: computed(() => {
      const g = findGroup(layout.root, layout.focusedGroupId) ?? listGroups(layout.root)[0];
      const tab = g.tabs.find((t) => t.id === g.activeTabId);
      if (!tab) return "";
      if (tab.sessionId) return workspaceOf(tab.sessionId)?.wsKey ?? "";
      return tab.pendingWs?.wsKey ?? "";
    }),
```

（顶部确保 `workspaceOf` 从既有的 `useSessionWorkspaces()` 解构出来 —— 该文件已 import 该 composable，只是还没解构 `workspaceOf`。）

`App.vue`：

```ts
// 切进日常就收起右栏（用户 2026-09-20 定）。布局动作，不是归属变更：活动工作区
// 一动不动（「不跟随焦点」的既定决策）。切回工程不自动展开——避免反复开合。
watch(
  () => [paneLayout.activeSessionId.value, paneLayout.activeTabWsKey.value] as const,
  () => {
    if (isDailyKey(paneLayout.activeTabWsKey.value)) rightPanel.collapse();
  },
);
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/composables/`
Expected: PASS

- [ ] **Step 5: 手动冒烟**

`pnpm dev`：
1. 打开一个工程会话 → 点开右栏文件树 → 点进一个日常会话 → **右栏收起**
2. 点回工程会话 → 右栏**不自动展开**（仍收起），手动点能开
3. 在工程会话里打开右栏 → 新建一个日常对话（空白 tab）→ 右栏收起

- [ ] **Step 6: 提交**

```bash
git add src/composables/useRightPanel.ts src/composables/useRightPanel.test.ts src/composables/usePaneLayout.ts src/composables/usePaneLayout.test.ts src/App.vue
git commit -m "feat(right-panel): 切进日常会话即收起右栏"
```

---

## 收尾

- [ ] **全量测试**：`pnpm test`
- [ ] **类型 + 构建守卫**：`pnpm build`（含 `check:sync-io` / `check:overlay-layers` / `vue-tsc`）
- [ ] **Rust**：`cd src-tauri && cargo test --lib`
- [ ] **spec 复核**：逐条对照 `docs/superpowers/specs/2026-09-20-daily-mode-design.md` 的「目标」与「非目标」，确认没有漏做也没有越界（尤其：**没做**活动工作区跟随焦点、**没做**会话改归属、**没做**模式 chips）
- [ ] **把 spec 里「待验证」那条的实测结论回写进 spec**（侧栏能否列出日常会话：装置 = Step 6 的冒烟第 3 条）
