# /btw 支线子对话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主对话跑大任务时,用户经发送按钮下拉切"顺便问一下",fork 主对话当前状态开独立 sidecar 进程跑支线——不污染主上下文、不阻塞、阅后即弃、默认轻量省 token,跑完以页边批注回插主对话。

**Architecture:** 复用"一会话一 sidecar 进程"模型 + SDK 原生 `forkSession`。btw = 新 sidecar 进程,首条 `send` 带 `session_id=<主sid>` + `btw:true`(触发 fork) + `lightweight`(禁工具)。事件按 session_id 路由到独立 `useBtwSession` store,渲染到右侧浮层抽屉;`message_stop` 时把结论组装成 `ActionBlock`(`actionId:'btw'`,可折叠)回插主对话 store(前端可见、不进主 SDK resume 上下文)。Claude 专属逻辑(forkSession/persistSession/tools)只落 sidecar;Rust/前端走中性协议。

**Tech Stack:** Tauri v2 (Rust async command) / Vue 3 Composition / TypeScript / Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

## Global Constraints

- **跨平台**:spawn 子进程必须 `#[cfg(windows)] cmd.creation_flags(0x08000000)`(`CREATE_NO_WINDOW`);传给 node 的资源路径必须 `dunce::simplified()` 剥 `\\?\` 前缀——复用 `SidecarManager::spawn` 即自动满足,不要自起 spawn。
- **async 命令坑点**:Rust async command 带 `State<'_, T>` 引用参数时 Tauri v2 强制返回 `Result`;`State<T>` 不能跨 `spawn_blocking`,需要的状态注册成 `Arc<T>`(`lib.rs` 已是 `Arc` 模式),命令内 `state.inner().clone()` 再 move。新增 `start_btw_session` 必须 `async fn` + 返回 `Result<(), String>`。
- **事件出口过 delta 合并层**:btw sidecar 的 stdout 事件经 `DeltaCoalescer`,禁止绕过(复用 sidecar 现有 emit 链,不要新写出入口)。
- **主题**:所有颜色用 `var(--aide-*)`,禁止硬编码 hex;三角箭头统一 14px。
- **禁止原生 UI**:tooltip 用 `v-tooltip`,弹窗用 `useModal`,不用 `title=`/`alert/confirm`。
- **Provider 抽象**:用户已确认后续只支持 Claude Agent SDK,但"Claude 专属只在 sidecar、前端/Rust 走中性协议"的分层必须保持——Rust 不感知 `forkSession`,只发 `btw:true` 语义标记。
- **测试命令**:Rust `cargo test --lib`(绕杀软锁,见仓库怪癖);前端 `pnpm vitest run`;sidecar 构建后提交 dist(见仓库怪癖)。
- **spec 偏差说明**:spec §5.1 写了 `fork_from` 字段,实现时**折叠进现有 `session_id` 字段**(session_id 本就是 resume 目标,fork_from 与之重复)。新增 sidecar `send` 字段为 `btw?: boolean` + `lightweight?: boolean`。

---

## File Structure

**Create:**
- `agent-sidecar/src/btwOptions.ts` — 纯函数:由 btwMode/lightweightMode 构造 query options 增量 + fork 选项。可单测。
- `src/composables/useBtwSession.ts` — btw 独立 store + 事件路由 + 结论组装 + 清理。单例。
- `src/components/BtwDrawer.vue` — 右侧浮层抽屉组件。

**Modify:**
- `agent-sidecar/src/types.ts` — `send` 命令加 `btw?`/`lightweight?` 字段。
- `agent-sidecar/src/index.ts` — 消费 btw 字段:设 `btwMode`/`lightweightMode` 模块标志;startLoop query options 接入 `btwOptions`;fork 时 btw 不发"已切换供应商"通知。
- `src-tauri/src/commands/chat.rs` — 新增 `start_btw_session` async 命令 + `build_btw_send_cmd` 纯函数 + 抽 `build_sidecar_env_vars` 共享 helper(送 send_message 复用以 DRY)。
- `src-tauri/src/lib.rs` — 注册 `start_btw_session`。
- `src/types/chat.ts` — `ActionBlock` 扩展 `foldable?`/`body?`/`hint?`。
- `src/composables/useChatSession.ts` — `sendMessage` 旁路检测 btw 事件路由到 `useBtwSession`;新增 `sendBtw()`。
- `src/components/ChatSendButton.vue` — 菜单支持"开关型"项(btw toggle,带选中态)。
- `src/components/ChatPanel.vue` — btw 模式状态、横幅、placeholder、发送走 `sendBtw`、发送后回弹视觉。
- `src/components/ChatMessage.vue` — `actionId==='btw'` 渲染为可折叠页边批注(非药丸)。

---

### Task 1: sidecar — 纯函数 `btwOptions`(TDD)

**Files:**
- Create: `agent-sidecar/src/btwOptions.ts`
- Test: `agent-sidecar/src/btwOptions.test.ts`

**Interfaces:**
- Produces: `btwQueryOverrides(btwMode: boolean, lightweight: boolean): { persistSession?: false; tools?: never[]; allowedTools?: never[] }`、`forkResumeOptions(sessionId: string, shouldFork: boolean): { resume: string; forkSession?: true } | {}`

- [ ] **Step 1: Write the failing test**

```ts
// agent-sidecar/src/btwOptions.test.ts
import { describe, it, expect } from "vitest";
import { btwQueryOverrides, forkResumeOptions } from "./btwOptions.js";

describe("btwQueryOverrides", () => {
  it("non-btw: no overrides", () => {
    expect(btwQueryOverrides(false, false)).toEqual({});
  });
  it("btw full: persistSession false only", () => {
    expect(btwQueryOverrides(true, false)).toEqual({ persistSession: false });
  });
  it("btw lightweight: persistSession false + no tools", () => {
    expect(btwQueryOverrides(true, true)).toEqual({
      persistSession: false,
      tools: [],
      allowedTools: [],
    });
  });
});

describe("forkResumeOptions", () => {
  it("no fork: plain resume", () => {
    expect(forkResumeOptions("s1", false)).toEqual({ resume: "s1" });
  });
  it("fork: resume + forkSession", () => {
    expect(forkResumeOptions("s1", true)).toEqual({ resume: "s1", forkSession: true });
  });
  it("no session id: empty", () => {
    expect(forkResumeOptions("", true)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-sidecar && pnpm vitest run src/btwOptions.test.ts`
Expected: FAIL — `Cannot find module './btwOptions.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// agent-sidecar/src/btwOptions.ts

/** 由 btwMode / lightweightMode 构造 query() options 的增量部分(纯函数,可单测)。
 *  - 非 btw:无增量(主对话路径不受影响)
 *  - btw 完整:persistSession:false(阅后即弃,不落盘)
 *  - btw 轻量:再加 tools:[] + allowedTools:[](禁用所有工具 → 纯问答 + 省 token) */
export function btwQueryOverrides(btwMode: boolean, lightweight: boolean): {
  persistSession?: false;
  tools?: never[];
  allowedTools?: never[];
} {
  if (!btwMode) return {};
  if (lightweight) return { persistSession: false, tools: [], allowedTools: [] };
  return { persistSession: false };
}

/** 构造 resume/fork 选项。shouldFork=true 时 fork 到新 session id(主会话 JSONL
 *  不被改动)。无 session id(全新会话)返回空对象。 */
export function forkResumeOptions(
  sessionId: string,
  shouldFork: boolean,
): { resume: string; forkSession?: true } | Record<string, never> {
  if (!sessionId) return {};
  return shouldFork ? { resume: sessionId, forkSession: true } : { resume: sessionId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-sidecar && pnpm vitest run src/btwOptions.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/btwOptions.ts agent-sidecar/src/btwOptions.test.ts
git commit -m "feat(btw): pure query-option builders for sidecar btw mode"
```

---

### Task 2: sidecar — `send` 命令扩展 + index.ts 接入

**Files:**
- Modify: `agent-sidecar/src/types.ts:111-128`(`send` 命令)
- Modify: `agent-sidecar/src/index.ts`(模块标志 + startLoop options + 首条 send 处理)
- Test: 手动/集成(sidecar 整体需 spawn 真实 CLI,无单测;纯函数已在 Task 1 覆盖)

**Interfaces:**
- Consumes: `btwQueryOverrides`/`forkResumeOptions` from Task 1
- Produces: sidecar 识别 `send` 命令的 `btw`/`lightweight` 字段,fork 出新 session、persistSession:false、轻量则禁工具

- [ ] **Step 1: 扩展 `send` 命令类型**

`agent-sidecar/src/types.ts` 的 `send` 分支(112-128 行)末尾 `jump_queue?: boolean;` 后追加两个可选字段:

```ts
      jump_queue?: boolean;
      // btw 支线对话:命中 → 下一次建 query() 时 resume session_id + forkSession:true
      // (fork 出带主上下文副本的新 session,主会话 JSONL 不被改动)。同时 persistSession
      // :false(阅后即弃,不落盘)。lightweight=true → 禁用所有工具(纯问答、省 token)。
      // 这是 Claude SDK 专属能力,但字段语义中性:未来 provider 各自在 sidecar 实现 fork。
      btw?: boolean;
      lightweight?: boolean;
```

- [ ] **Step 2: 在 index.ts 加模块标志**

`agent-sidecar/src/index.ts` 第 106 行 `let turnActive = false;` 后追加:

```ts
// btw 支线模式:首条 send 带 btw:true 时置真,整个进程生命周期有效(bt w 进程是一次性
// 的,跑完即被前端 kill,无需复位)。fork 用 shouldForkNextConnect 复用既有机制,但
// btw 走 fork 时不发"已切换供应商"通知(用 btwMode 抑制 pendingFork)。
let btwMode = false;
let lightweightMode = false;
```

- [ ] **Step 3: 首条 send 命中 btw 时设标志**

`agent-sidecar/src/index.ts` 第 394-412 行 `if (cmd.cmd === "send")` 分支内,`if (cmd.provider_switched) shouldForkNextConnect = true;`(398 行)之后追加:

```ts
    if (cmd.provider_switched) shouldForkNextConnect = true;
    // btw:fork 主会话(复用 shouldForkNextConnect 机制) + 记 lightweight 供 startLoop 用
    if (cmd.btw) {
      shouldForkNextConnect = true;
      btwMode = true;
      lightweightMode = !!cmd.lightweight;
    }
```

- [ ] **Step 4: startLoop query options 接入 btwOptions**

`agent-sidecar/src/index.ts` 顶部 import 区追加:

```ts
import { btwQueryOverrides, forkResumeOptions } from "./btwOptions.js";
```

修改 startLoop 内 query options(228-271 行)。把现有的 `allowedTools: ["Agent","Task"]`(240 行)与 fork 三元(264-268 行)替换为接 btwOptions 的版本。整段 options 改为:

```ts
        const q = query({
          prompt: queue[Symbol.asyncIterator](),
          options: {
            permissionMode: currentPermissionMode as any,
            allowDangerouslySkipPermissions: true,
            canUseTool: permMgr.makeCallback(emit, subagentTracker) as any,
            settingSources: ["project", "user"],
            // 轻量 btw:禁工具;其余情况(主对话/btw 完整)保持 Agent/Task 自动批准
            ...(lightweightMode
              ? { allowedTools: [] as string[] }
              : { allowedTools: ["Agent", "Task"] }),
            skills: "all",
            plugins: buildPluginsOption(),
            includePartialMessages: false,
            ...(currentModel ? { model: currentModel } : {}),
            ...(cwd ? { cwd } : {}),
            ...(process.env.AIDE_CLAUDE_EXE
              ? { pathToClaudeCodeExecutable: process.env.AIDE_CLAUDE_EXE }
              : {}),
            // fork:btw 与供应商切换都走 fork;btw 时抑制"已切换供应商"通知
            // (pendingFork 只在非 btw 时置真)。
            ...(sessionId
              ? shouldForkNextConnect
                ? (btwMode ? {} : (pendingFork = true, {}), { resume: sessionId, forkSession: true })
                : { resume: sessionId }
              : {}),
            ...btwQueryOverrides(btwMode, lightweightMode),
            env: cliEnv,
          },
        });
```

> 注:`(btwMode ? {} : (pendingFork = true, {}))` 是逗号表达式——非 btw 时设 pendingFork 触发供应商切换通知,btw 时不设(安静 fork)。`btwQueryOverrides` 在 fork 之后展开,`persistSession:false` 生效。

- [ ] **Step 5: 构建并验证编译**

Run: `cd agent-sidecar && pnpm build`
Expected: esbuild 成功生成 `dist/sidecar.js`,无 TS 报错。

- [ ] **Step 6: 提交 dist(仓库怪癖:sidecar dist 需重建提交)**

```bash
git add agent-sidecar/src/types.ts agent-sidecar/src/index.ts agent-sidecar/dist/sidecar.js
git commit -m "feat(btw): sidecar fork+lightweight via send cmd btw/lightweight fields"
```

---

### Task 3: Rust — `start_btw_session` 命令 + env helper(TDD)

**Files:**
- Modify: `src-tauri/src/commands/chat.rs`(新命令 + 两个 helper + send_message 复用 helper)
- Modify: `src-tauri/src/lib.rs:279`(注册命令)
- Test: `src-tauri/src/commands/chat.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Produces: Tauri 命令 `start_btw_session(btw_id, fork_from, prompt, cwd, lightweight, permission_mode, app_handle) -> Result<(), String>`;纯函数 `build_btw_send_cmd(fork_from, prompt, cwd, lightweight, permission_mode) -> serde_json::Value`、`build_sidecar_env_vars() -> HashMap<String,String>`(也被 send_message 复用)

- [ ] **Step 1: Write failing tests for `build_btw_send_cmd`**

在 `src-tauri/src/commands/chat.rs` 末尾 `mod tests`(292 行起)内追加:

```rust
    // btw:fork 主会话的 send 命令必须带 session_id(主 sid)+ btw:true + lightweight,
    // 且 cwd/prompt 透传。permission_mode 仅非空时带。
    #[test]
    fn btw_send_cmd_forks_from_main_session() {
        let cmd = build_btw_send_cmd("main-sid", "顺便问下 X", "/repo", true, &None);
        assert_eq!(cmd["cmd"], "send");
        assert_eq!(cmd["session_id"], "main-sid");
        assert_eq!(cmd["btw"], true);
        assert_eq!(cmd["lightweight"], true);
        assert_eq!(cmd["prompt"], "顺便问下 X");
        assert_eq!(cmd["cwd"], "/repo");
        assert!(cmd.get("permission_mode").is_none());
    }

    #[test]
    fn btw_send_cmd_full_mode_carries_permission_mode() {
        let cmd = build_btw_send_cmd("main-sid", "q", "/repo", false, &Some("default".to_string()));
        assert_eq!(cmd["lightweight"], false);
        assert_eq!(cmd["permission_mode"], "default");
    }

    #[test]
    fn btw_send_cmd_empty_permission_mode_omitted() {
        let cmd = build_btw_send_cmd("main-sid", "q", "/repo", true, &Some(String::new()));
        assert!(cmd.get("permission_mode").is_none());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib build_btw_send_cmd`
Expected: FAIL — `cannot find function build_btw_send_cmd`

- [ ] **Step 3: 抽 `build_sidecar_env_vars` helper 并实现 `build_btw_send_cmd`**

在 `chat.rs` 把 `send_message` 内 42-99 行的 env 构建逻辑抽成函数(放在 `send_message` 之前):

```rust
/// 构造 sidecar spawn 用的 env:active provider 的连接参数 + 系统 env 兜底 +
/// settings 代理。send_message 与 start_btw_session 共用,保证 btw 进程与主
/// sidecar 用同一套 provider 配置(否则 fork 出来的支线会打到错误 endpoint)。
fn build_sidecar_env_vars() -> HashMap<String, String> {
    let active_provider = load_active_provider();
    let mut env_vars: HashMap<String, String> = if let Some(ref provider) = active_provider {
        provider_to_env_vars(provider)
    } else {
        system_default_mappings_to_env()
    };

    let fallback_keys: &[&str] = if active_provider.is_some() {
        &["CLAUDE_CONFIG_DIR", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]
    } else {
        &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR",
          "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]
    };
    for var in fallback_keys {
        if !env_vars.contains_key(*var) {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() {
                    env_vars.insert(var.to_string(), val);
                }
            }
        }
    }
    if let Ok(s) = get_settings() {
        if !s.proxy.is_empty() {
            env_vars.insert("HTTP_PROXY".to_string(), s.proxy.clone());
            env_vars.insert("HTTPS_PROXY".to_string(), s.proxy.clone());
            env_vars.insert("http_proxy".to_string(), s.proxy.clone());
            env_vars.insert("https_proxy".to_string(), s.proxy);
        }
    }
    env_vars
}

/// btw 首条 send 命令:fork 主会话(session_id=主 sid)+ btw:true + lightweight。
/// Rust 不感知 forkSession 语义,只透传 btw 标记,由 sidecar 解释(见 agent-sidecar
/// /src/index.ts)。cwd/permission_mode 原样透传,空 permission_mode 不带键。
fn build_btw_send_cmd(
    fork_from: &str,
    prompt: &str,
    cwd: &str,
    lightweight: bool,
    permission_mode: &Option<String>,
) -> serde_json::Value {
    let mut cmd = json!({
        "cmd": "send",
        "prompt": prompt,
        "cwd": cwd,
        "session_id": fork_from,
        "btw": true,
        "lightweight": lightweight,
    });
    if let Some(mode) = permission_mode {
        if !mode.is_empty() {
            cmd["permission_mode"] = json!(mode);
        }
    }
    cmd
}
```

并把 `send_message` 内 42-99 行的 env 构建替换为 `let mut env_vars = build_sidecar_env_vars();`(删掉原内联块,保留其后的 `apply_initial_model_override` 与 spawn 调用)。`active_provider` 在 send_message 里原用于 `connection_drifted`?检查:105 行 `let provider_switched = sidecar_mgr.connection_drifted(&session_id, &env_vars);` 用的是 env_vars,不是 active_provider 变量本身。所以 send_message 不再需要 `active_provider` 局部变量(它在内联块里只用了一次,用于选 fallback_keys)。抽走后 send_message 删掉对 active_provider 的引用即可。`provider_switched` 用 `env_vars`(已构造)。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test --lib build_btw_send_cmd`
Expected: PASS (3 tests)。再跑全量:`cargo test --lib` 确保 send_message 重构没破坏(原有 6 个 chat test 仍绿)。

- [ ] **Step 5: 实现 `start_btw_session` 命令**

在 `chat.rs` `stop_chat_session`(201 行)之后追加:

```rust
/// 启动一个 btw 支线 sidecar 进程:fork 主会话(fork_from)当前状态,跑一个隔离
/// 的"顺便问一下"支线。btw_id 由前端生成(纯内存临时 key,落 pendingSids,不进
/// 侧栏/不写元数据)。spawn 复用 SidecarManager::spawn(CREATE_NO_WINDOW /
/// dunce::simplified 等跨平台约束自动满足),再发首条带 btw:true 的 send 命令。
/// 主会话必须存活(has_session),否则报错——fork 依赖主会话的持久化状态。
#[tauri::command]
pub async fn start_btw_session(
    btw_id: String,
    fork_from: String,
    prompt: String,
    cwd: String,
    lightweight: bool,
    permission_mode: Option<String>,
    app_handle: tauri::AppHandle,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    if !sidecar_mgr.has_session(&fork_from) {
        return Err(format!("主对话未就绪,无法顺便问(fork_from 未存活): {fork_from}"));
    }
    let env_vars = build_sidecar_env_vars();
    sidecar_mgr.spawn(btw_id.clone(), PathBuf::from(&cwd), env_vars, app_handle)?;
    let cmd = build_btw_send_cmd(&fork_from, &prompt, &cwd, lightweight, &permission_mode);
    sidecar_mgr.send(&btw_id, &cmd).await
}
```

- [ ] **Step 6: 注册命令**

`src-tauri/src/lib.rs` 第 279 行 `commands::chat::rename_sidecar_session,` 后追加:

```rust
            commands::chat::start_btw_session,
```

- [ ] **Step 7: 编译验证**

Run: `cd src-tauri && cargo build`
Expected: 成功(确认 State/SidecarManager import 已在 chat.rs 顶部,无需新 import)。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands/chat.rs src-tauri/src/lib.rs
git commit -m "feat(btw): Rust start_btw_session command + shared env builder"
```

---

### Task 4: 前端类型 — `ActionBlock` 扩展

**Files:**
- Modify: `src/types/chat.ts`(`ActionBlock` 定义)

**Interfaces:**
- Produces: `ActionBlock` 新增可选 `foldable`/`body`/`hint`;仅 `actionId==='btw'` 用,其余 action 不受影响

- [ ] **Step 1: 定位并扩展 ActionBlock**

`src/types/chat.ts` 中 `ActionBlock` 定义(参考 sidecar types 注释:前端独有,用于 /compact /clear 胶囊)。改为:

```ts
export interface ActionBlock {
  type: "action";
  actionId: string; // "compact" | "clear" | "btw" | ...
  label: string; // 胶囊/批注显示文本
  icon?: string; // 胶囊前缀图标(字符),btw 用 "↳"
  // btw 批注扩展(仅 actionId==='btw' 使用):可折叠页边批注,展开看结论全文。
  // 其余 action(/compact /clear)忽略这些字段,仍走原药丸胶囊渲染。
  foldable?: boolean;
  body?: string; // 结论全文
  hint?: string; // 折叠头尾部提示,如"不进上下文"
}
```

> 若 `ActionBlock` 当前没有 `icon?` 字段(只有 actionId/label),补上 `icon?`(原型与 useChatSession dispatchSend 已用 `item.action.icon`)。如已有则不重复。

- [ ] **Step 2: 类型检查**

Run: `pnpm vue-tsc --noEmit`(或项目的类型检查命令)
Expected: 无新增报错。

- [ ] **Step 3: Commit**

```bash
git add src/types/chat.ts
git commit -m "feat(btw): extend ActionBlock with foldable/body/hint for btw note"
```

---

### Task 5: `useBtwSession` composable(TDD)

**Files:**
- Create: `src/composables/useBtwSession.ts`
- Create: `src/composables/useBtwSession.test.ts`

**Interfaces:**
- Consumes: `ActionBlock` from Task 4;`invoke` from `@tauri-apps/api/core`
- Produces: `useBtwSession()` 返回 `{ store, isBtwSid, startBtw, handleBtwEvent, cleanup, setOnDone }`;`isBtwSid(raw)` 供 useChatSession 路由判断;`startBtw(tempId, forkFrom, prompt, opts)` 调 `start_btw_session`;`handleBtwEvent(e)` 处理 btw 事件;`cleanup()` kill 进程

- [ ] **Step 1: Write failing tests**

```ts
// src/composables/useBtwSession.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useBtwSession, __resetBtwForTest } from "./useBtwSession";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  __resetBtwForTest();
  (vi.mocked(require("@tauri-apps/api/core").invoke) as any).mockClear();
});

describe("useBtwSession routing", () => {
  it("isBtwSid false before start", () => {
    expect(useBtwSession().isBtwSid("any")).toBe(false);
  });

  it("startBtw registers temp id; events route to store", async () => {
    const { startBtw, handleBtwEvent, store } = useBtwSession();
    await startBtw({ tempId: "t1", forkFrom: "main", prompt: "q", cwd: "/r", lightweight: true });
    expect(useBtwSession().isBtwSid("t1")).toBe(true);
    handleBtwEvent({ session_id: "t1", type: "text_delta", delta: "hello" });
    expect(store.value.messages.join("")).toBe("hello");
  });

  it("message_stop assembles conclusion + calls onDone, sets done", async () => {
    const { startBtw, handleBtwEvent, store, setOnDone } = useBtwSession();
    const done = vi.fn();
    setOnDone(done);
    await startBtw({ tempId: "t2", forkFrom: "main", prompt: "why", cwd: "/r", lightweight: false });
    handleBtwEvent({ session_id: "t2", type: "text_delta", delta: "answer" });
    handleBtwEvent({ session_id: "t2", type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null });
    expect(store.value.done).toBe(true);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ actionId: "btw", body: "answer" }));
  });

  it("startBtw replaces existing btw (single instance)", async () => {
    const { startBtw, isBtwSid } = useBtwSession();
    await startBtw({ tempId: "a", forkFrom: "main", prompt: "1", cwd: "/r", lightweight: true });
    await startBtw({ tempId: "b", forkFrom: "main", prompt: "2", cwd: "/r", lightweight: true });
    expect(isBtwSid("a")).toBe(false);
    expect(isBtwSid("b")).toBe(true);
  });

  it("cleanup kills process and clears id", async () => {
    const { startBtw, cleanup, isBtwSid } = useBtwSession();
    await startBtw({ tempId: "c", forkFrom: "main", prompt: "1", cwd: "/r", lightweight: true });
    await cleanup();
    expect(isBtwSid("c")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/composables/useBtwSession.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useBtwSession`**

```ts
// src/composables/useBtwSession.ts
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ActionBlock } from "../types/chat";

/** btw 支线对话的轻量 store——单例:同一时间只一个 btw(v1)。 */
interface BtwState {
  messages: string[]; // 累积的 assistant 文本(纯展示)
  isBusy: boolean;
  done: boolean;
  error: string | null;
  question: string;
}

const state = ref<BtwState>({ messages: [], isBusy: false, done: false, error: null, question: "" });
let btwTempId: string | null = null;
let btwRealId: string | null = null; // session_init 后的 fork id
let onDoneCb: ((block: ActionBlock) => void) | null = null;

function resetState(question: string) {
  state.value = { messages: [], isBusy: true, done: false, error: null, question };
}

/** useChatSession.handleChatEvent 调:判断事件是否属于当前 btw。 */
function isBtwSid(raw: string): boolean {
  return !!btwTempId && (raw === btwTempId || (btwRealId !== null && raw === btwRealId));
}

interface StartBtwOpts { tempId: string; forkFrom: string; prompt: string; cwd: string; lightweight: boolean; permissionMode?: string; }

async function startBtw(opts: StartBtwOpts) {
  // 单实例:新开先清掉旧的(kill 进程、丢 store)
  if (btwTempId) await cleanup();
  btwTempId = opts.tempId;
  btwRealId = null;
  resetState(opts.prompt);
  await invoke("start_btw_session", {
    btwId: opts.tempId,
    forkFrom: opts.forkFrom,
    prompt: opts.prompt,
    cwd: opts.cwd,
    lightweight: opts.lightweight,
    permissionMode: opts.permissionMode ?? null,
  });
}

function setOnDone(cb: (block: ActionBlock) => void) {
  onDoneCb = cb;
}

function handleBtwEvent(e: Record<string, unknown>) {
  switch (e["type"]) {
    case "session_init": {
      const sdkSid = e["sdk_session_id"] as string | undefined;
      if (sdkSid && btwTempId && sdkSid !== btwTempId) {
        btwRealId = sdkSid;
        // Rust 侧 rename 注册表:之后事件携带 fork id(内存态,无 IO)
        invoke("rename_sidecar_session", { oldId: btwTempId, newId: sdkSid }).catch(() => {});
        // 注意:btw 不触发 onSessionCreated(不写元数据/不进侧栏)——与主对话 finalizeSession 的区别
      }
      break;
    }
    case "text_delta": {
      state.value.messages.push(e["delta"] as string);
      break;
    }
    case "message_stop": {
      state.value.isBusy = false;
      state.value.done = true;
      const conclusion = state.value.messages.join("");
      if (onDoneCb && conclusion) {
        const block: ActionBlock = {
          type: "action",
          actionId: "btw",
          label: state.value.question,
          icon: "↳",
          foldable: true,
          body: conclusion,
          hint: "不进上下文",
        };
        onDoneCb(block);
      }
      break;
    }
    case "error": {
      state.value.isBusy = false;
      state.value.error = e["message"] as string;
      break;
    }
    case "session_dead": {
      state.value.isBusy = false;
      state.value.error = "支线进程已退出";
      break;
    }
  }
}

async function cleanup() {
  if (!btwTempId) return;
  const killId = btwRealId ?? btwTempId;
  try { await invoke("stop_chat_session", { sessionId: killId }); } catch {}
  btwTempId = null;
  btwRealId = null;
}

export function useBtwSession() {
  return {
    store: computed(() => state.value),
    isBtwSid,
    startBtw,
    handleBtwEvent,
    cleanup,
    setOnDone,
  };
}

export function __resetBtwForTest() {
  state.value = { messages: [], isBusy: false, done: false, error: null, question: "" };
  btwTempId = null;
  btwRealId = null;
  onDoneCb = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/composables/useBtwSession.test.ts`
Expected: PASS (5 tests)。

- [ ] **Step 5: Commit**

```bash
git add src/composables/useBtwSession.ts src/composables/useBtwSession.test.ts
git commit -m "feat(btw): useBtwSession composable (isolated store + routing + cleanup)"
```

---

### Task 6: `useChatSession` — btw 旁路路由 + `sendBtw`

**Files:**
- Modify: `src/composables/useChatSession.ts`(handleChatEvent 路由 + 新增 sendBtw + export)

**Interfaces:**
- Consumes: `useBtwSession` from Task 5
- Produces: `useChatSession` 返回新增 `sendBtw(prompt, opts)`;handleChatEvent 把 btw 事件转给 useBtwSession

- [ ] **Step 1: import + 路由 btw 事件**

`useChatSession.ts` 顶部 import 区追加:

```ts
import { useBtwSession } from "./useBtwSession";
```

在 `handleChatEvent`(353 行)函数体最前,`const sid = resolveSid(raw);`(356 行)之前插入路由:

```ts
function handleChatEvent(e: Record<string, unknown>) {
  const raw = e["session_id"] as string | undefined;
  if (!raw) return;
  // btw 事件路由到独立 store,不进主对话 store(隔离红线)
  const btw = useBtwSession();
  if (btw.isBtwSid(raw)) {
    btw.handleBtwEvent(e);
    return;
  }
  const sid = resolveSid(raw);
  const store = getStore(sid);
  // …原 switch 不变
```

- [ ] **Step 2: 新增 `sendBtw` 并接入 onDone 回插主对话**

在 `useChatSession` 的 `return`(873 行)之前定义 `sendBtw`,并在 return 里导出。`sendBtw` 用当前 session 作 fork_from,onDone 把 ActionBlock 推进主 store:

```ts
  /** 顺便问一下:fork 当前主会话开一个隔离子对话。一次性——发送后由 ChatPanel
   *  负责复位 btw 模式视觉。结论以 ActionBlock(actionId:'btw')回插本会话 store
   *  末尾(前端可见、不进 SDK resume 上下文,见 ChatMessage 渲染)。 */
  async function sendBtw(prompt: string, opts: { lightweight: boolean; permissionMode?: string } = { lightweight: true }) {
    const sid = sessionId.value;
    if (!sid) {
      console.warn("sendBtw 需要一个存活的主会话作为 fork 源");
      return;
    }
    const btwId = crypto.randomUUID();
    pendingSids.add(btwId);
    const sessionWs = useSessionWorkspaces().workspaceOf(sid);
    const cwd = sessionWs?.wsPath || "";
    const store = getStore(sid);
    const btw = useBtwSession();
    btw.setOnDone((block) => {
      // 结论回插主对话:作为一条只含 ActionBlock 的用户消息(与 /compact /clear 同形),
      // ChatMessage 检测 actionId==='btw' 渲染为页边批注。
      store.messages.push({
        id: crypto.randomUUID(),
        role: "user",
        blocks: [block],
        timestamp: Date.now(),
      });
    });
    await btw.startBtw({ tempId: btwId, forkFrom: sid, prompt, cwd, lightweight: opts.lightweight, permissionMode: opts.permissionMode });
  }
```

在 return 对象(873-909 行)追加:

```ts
    sendBtw,
```

- [ ] **Step 3: 类型检查**

Run: `pnpm vue-tsc --noEmit`
Expected: 无报错。

- [ ] **Step 4: Commit**

```bash
git add src/composables/useChatSession.ts
git commit -m "feat(btw): route btw events to useBtwSession + add sendBtw"
```

---

### Task 7: `ChatSendButton` — 菜单支持开关型 btw 项

**Files:**
- Modify: `src/components/ChatSendButton.vue`

**Interfaces:**
- Produces: 新 prop `btwActive: boolean`;菜单在 actions 之上渲染一个"顺便问一下"开关项,emit `toggle-btw`;btwActive 时该项高亮带 ✓

- [ ] **Step 1: 加 prop + emit + 菜单项**

`ChatSendButton.vue` script props(16-26 行)追加 `btwActive?: boolean`(default false)。emits(28-31 行)追加 `(e: "toggle-btw"): void;`。

模板菜单(146-157 行)在 `v-for="a in actions"` 之前插入开关项:

```html
          <button
            type="button"
            class="chat-send-menu-item"
            :class="{ 'is-on': props.btwActive }"
            role="menuitemcheckbox"
            :aria-checked="props.btwActive"
            @click="emit('toggle-btw'); open = false"
          >
            <span class="chat-send-menu-icon">↳</span>
            <span class="chat-send-menu-label">顺便问一下</span>
            <span v-if="props.btwActive" class="chat-send-menu-check">✓</span>
          </button>
          <div v-if="actions.length" class="chat-send-menu-sep"></div>
```

- [ ] **Step 2: 加样式**

`<style scoped>` 末尾追加:

```css
.chat-send-menu-item.is-on {
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
}
.chat-send-menu-check {
  margin-left: auto;
  font-size: 12px;
}
.chat-send-menu-sep {
  height: 1px;
  background: var(--aide-border);
  margin: 4px 2px;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatSendButton.vue
git commit -m "feat(btw): ChatSendButton menu toggle item for btw mode"
```

---

### Task 8: `ChatPanel` — btw 模式 UI + 发送旁路 + 回弹视觉

**Files:**
- Modify: `src/components/ChatPanel.vue`

**Interfaces:**
- Consumes: `sendBtw` from `useChatSession`(经 App.vue props/emit 链或直接注入——按现有 emit("send") 走);ChatSendButton 的 `toggle-btw`/`btwActive`

> 实现注:ChatPanel 现有发送走 `emit("send", prompt, opts)`,由 App.vue 调 `useChatSession.sendMessage`。btw 走不同路径(`sendBtw`)。最简方式:ChatPanel 持有 `btwMode` ref,`handleSend` 检测 `btwMode` 时调一个新的 `emit("send-btw", text, {lightweight})`(App.vue 接到后调 `sendBtw`),而非 `emit("send")`。这样不破坏现有 emit 链。`lightweight` 状态来自一个本地 ref(默认 true,与抽屉的轻量/完整联动见 Task 9)。

- [ ] **Step 1: 加 btw 模式状态 + 横幅**

script 顶部加:

```ts
const btwMode = ref(false);
const btwLightweight = ref(true); // 默认轻量(省 token);与 BtwDrawer 切换联动
```

模板输入框(`.chat-input-box`,581 行附近)内、`<textarea>` 之前插入横幅:

```html
        <Transition name="btw-banner">
          <div v-if="btwMode" class="btw-mode-banner">
            <span class="btw-banner-glyph">↳</span>
            <span class="btw-banner-text"><b>顺便问一下</b> · 不进入主对话 · 阅后即弃</span>
            <button type="button" class="btw-banner-x" @click="btwMode = false" v-tooltip="'退出 btw 模式'">×</button>
          </div>
        </Transition>
```

给 `.chat-input-box` 加 `:class="{ 'btw-mode': btwMode }"`。

- [ ] **Step 2: ChatSendButton 接 toggle + btwActive**

ChatPanel 模板里的 `<ChatSendButton`(648 行)加 `:btw-active="btwMode" @toggle-btw="btwMode = !btwMode"`。

- [ ] **Step 3: handleSend 走 btw 旁路 + 回弹**

`handleSend`(441 行)开头,btwMode 时走旁路并发后复位:

```ts
async function handleSend(jumpQueue = false) {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  if (!text && !hasImages) return;

  if (btwMode.value) {
    // btw 一次性:发完自动切回主对话输入,视觉突出(回弹)
    emit("send-btw", text, { lightweight: btwLightweight.value });
    inputText.value = "";
    pendingImages.value = [];
    const box = rootEl.value?.querySelector(".chat-input-box") as HTMLElement | null;
    btwMode.value = false; // 横幅收起、按钮复原
    if (box) {
      box.classList.remove("btw-revert-flash");
      void box.offsetWidth; // 重启动画
      box.classList.add("btw-revert-flash");
      setTimeout(() => box.classList.remove("btw-revert-flash"), 800);
    }
    showBtwRevertToast();
    return;
  }

  // …原 handleSend 逻辑不变
```

加 toast(简单 ref 控制的浮层):

```ts
const btwRevertToast = ref(false);
let btwToastTimer: number | undefined;
function showBtwRevertToast() {
  btwRevertToast.value = true;
  clearTimeout(btwToastTimer);
  btwToastTimer = window.setTimeout(() => (btwRevertToast.value = false), 1600);
}
```

模板发送按钮区附近加:

```html
        <Transition name="btw-toast">
          <div v-if="btwRevertToast" class="btw-revert-toast">已切回主对话输入</div>
        </Transition>
```

- [ ] **Step 4: placeholder + 发送按钮文案随模式**

textarea 的 `:placeholder`(581 行)改为 `:placeholder="btwMode ? '顺便问一下,不进入主对话…' : (isBusyVal ? '生成中,发送的消息将排队…' : '输入消息…')"`。ChatSendButton 主体文案在 btw 模式应显示"顺便问"——给 ChatSendButton 加一个 `:busy-label="btwMode ? '顺便问' : undefined"` prop 并在主体用 `{{ busy ? (busyLabel ?? '排队') : (btwActive ? '顺便问' : '发送') }}`。若不想改 ChatSendButton 内部文案逻辑,可接受按钮在 btw 模式仍显示"发送"(横幅已说明)——**选此简化**:不改 ChatSendButton 文案,横幅承担说明。

- [ ] **Step 5: 样式(全部 --aide-*)**

`<style>` 末尾(非 scoped 动态区域或 scoped 均可,但 input-box 是本组件元素,用 scoped)追加:

```css
.btw-mode-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  font-size: 11px;
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 8%, transparent);
  border-bottom: 1px solid var(--aide-border-subtle);
}
.btw-banner-glyph { font-size: 14px; line-height: 1; }
.btw-banner-text { flex: 1; }
.btw-banner-text b { color: var(--aide-accent); }
.btw-banner-x {
  background: none; border: none; color: var(--aide-accent);
  font-size: 14px; cursor: pointer; opacity: 0.8; line-height: 1;
}
.btw-banner-x:hover { opacity: 1; }
.chat-input-box.btw-mode {
  border-color: var(--aide-accent);
  box-shadow: 0 0 0 2px var(--aide-accent-subtle);
}
.chat-input-box.btw-revert-flash { animation: btw-revert-flash 0.8s ease-out; }
@keyframes btw-revert-flash {
  0% { border-color: var(--aide-accent); box-shadow: 0 0 0 3px var(--aide-accent-subtle); }
  40% { border-color: var(--aide-accent); box-shadow: 0 0 0 3px var(--aide-accent-subtle); }
  100% { border-color: var(--aide-border); box-shadow: none; }
}
.btw-revert-toast {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: 100%; margin-bottom: 6px;
  background: var(--aide-bg-raised); border: 1px solid var(--aide-accent);
  color: var(--aide-accent); font-size: 11px; padding: 4px 12px;
  border-radius: 999px; box-shadow: var(--aide-shadow-md);
  z-index: 40; pointer-events: none; white-space: nowrap;
}
.btw-banner-enter-active, .btw-banner-leave-active { transition: opacity 0.2s, max-height 0.25s; overflow: hidden; }
.btw-banner-enter-from, .btw-banner-leave-to { opacity: 0; max-height: 0; }
.btw-toast-enter-active, .btw-toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.btw-toast-enter-from, .btw-toast-leave-to { opacity: 0; transform: translate(-50%, 4px); }
```

- [ ] **Step 6: App.vue 接 send-btw → sendBtw**

在 App.vue 里接到 ChatPanel 的 `send-btw` 事件调 `useChatSession(...).sendBtw`。若 ChatPanel 不直接 emit 到 App(走 PaneGroup 中转),按现有 `@send` 的透传链同路径加 `@send-btw` 透传。**实现时按现有 send 事件透传方式镜像加一条 send-btw。**

- [ ] **Step 7: 类型检查 + 手动验证**

Run: `pnpm vue-tsc --noEmit` + `pnpm tauri dev`
手动:发送下拉点"顺便问一下"→ 横幅出 + 输入框高亮 → 打字回车 → 横幅收起 + 输入框 accent 闪烁回弹 + "已切回主对话输入" toast → 右侧抽屉出(见 Task 9)。

- [ ] **Step 8: Commit**

```bash
git add src/components/ChatPanel.vue src/App.vue
git commit -m "feat(btw): ChatPanel btw mode (banner, bypass send, revert flash)"
```

---

### Task 9: `BtwDrawer.vue` — 浮层抽屉

**Files:**
- Create: `src/components/BtwDrawer.vue`
- Modify: `src/components/ChatPanel.vue`(挂载抽屉 + 轻量/完整联动 + 关闭/停止)

**Interfaces:**
- Consumes: `useBtwSession().store`(messages/isBusy/done/error/question);`cleanup()`;`btwLightweight` 联动
- Produces: 右侧浮层抽屉;emit `close`/`stop`(由 ChatPanel 接到调 cleanup/stop)

- [ ] **Step 1: 实现 BtwDrawer.vue**

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useBtwSession } from "@/composables/useBtwSession";

const props = defineProps<{ visible: boolean; lightweight: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "stop"): void;
  (e: "update:lightweight", v: boolean): void;
}>();

const { store } = useBtwSession();
const text = computed(() => store.value.messages.join(""));
</script>

<template>
  <Transition name="btw-drawer">
    <aside v-if="props.visible" class="btw-drawer" role="complementary" aria-label="顺便问一下">
      <div class="btw-drawer-stripe"></div>
      <div class="btw-banner">
        <span class="btw-bi">↳</span> 这条支线不进入主对话上下文
        <span class="btw-blight">轻量 · 极少 token</span>
      </div>
      <div class="btw-head">
        <div class="btw-title"><span class="btw-fork">↳</span> 顺便问一下 <span class="btw-pill">· btw</span></div>
        <div class="btw-sub">从主对话 fork 副本开跑 · 来回不回写主对话 · 跑完即弃</div>
        <div class="btw-ctrl">
          <div class="btw-seg" role="group">
            <button :aria-pressed="props.lightweight" @click="emit('update:lightweight', true)" :disabled="store.isBusy">轻量</button>
            <button :aria-pressed="!props.lightweight" @click="emit('update:lightweight', false)" :disabled="store.isBusy">完整</button>
          </div>
          <span class="btw-spacer"></span>
          <button v-if="store.isBusy" class="btw-btn btw-danger" @click="emit('stop')">停止</button>
          <button v-if="!store.isBusy" class="btw-btn" @click="emit('close')">关闭</button>
        </div>
      </div>
      <div class="btw-body">
        <div class="btw-q">{{ store.question }}</div>
        <div class="btw-a">{{ text }}<span v-if="store.isBusy" class="btw-cursor"></span></div>
        <div v-if="store.error" class="btw-err">{{ store.error }}</div>
      </div>
      <div v-if="store.done" class="btw-foot">
        <span class="btw-ok">已作为批注插入主对话</span>
        <span class="btw-spacer"></span>
        <button class="btw-btn" @click="emit('close')">关闭</button>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.btw-drawer {
  position: absolute; top: 0; right: 0; bottom: 0; width: 320px;
  display: flex; flex-direction: column;
  background: var(--aide-bg-raised); border-left: 1px solid var(--aide-accent);
  box-shadow: var(--aide-shadow-lg); z-index: 20;
}
.btw-drawer-stripe { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--aide-accent); }
.btw-banner {
  display: flex; align-items: center; gap: 7px; padding: 7px 14px 7px 17px;
  font-size: 11px; color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 7%, transparent);
  border-bottom: 1px solid var(--aide-border);
}
.btw-bi { font-size: 14px; line-height: 1; }
.btw-blight { margin-left: auto; color: var(--aide-text-muted); display: flex; align-items: center; gap: 5px; }
.btw-blight::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--aide-success); }
.btw-head { padding: 11px 14px 11px 17px; border-bottom: 1px solid var(--aide-border); }
.btw-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--aide-text-primary); }
.btw-fork { color: var(--aide-accent); font-size: 14px; }
.btw-pill { font-size: 11px; color: var(--aide-text-muted); font-weight: 400; }
.btw-sub { font-size: 11px; color: var(--aide-text-muted); margin: 4px 0 0 22px; line-height: 1.5; }
.btw-ctrl { display: flex; align-items: center; gap: 7px; margin: 10px 0 0 22px; }
.btw-seg { display: inline-flex; border: 1px solid var(--aide-border); border-radius: 999px; overflow: hidden; }
.btw-seg button { background: none; border: 0; color: var(--aide-text-muted); padding: 3px 11px; font-size: 11px; cursor: pointer; }
.btw-seg button[aria-pressed="true"] { background: var(--aide-accent-subtle); color: var(--aide-accent); }
.btw-seg button:disabled { opacity: 0.5; cursor: default; }
.btw-spacer { flex: 1; }
.btw-btn { border: 1px solid var(--aide-border); background: transparent; color: var(--aide-text-secondary); border-radius: var(--aide-radius-sm); padding: 4px 10px; font-size: 12px; cursor: pointer; }
.btw-btn:hover { border-color: var(--aide-accent); color: var(--aide-accent); }
.btw-danger:hover { border-color: var(--aide-danger); color: var(--aide-danger); }
.btw-body { flex: 1; overflow: auto; padding: 13px 14px 13px 17px; display: flex; flex-direction: column; gap: 12px; }
.btw-q { font-size: 12.5px; color: var(--aide-text-secondary); border-left: 2px solid var(--aide-border); padding-left: 9px; }
.btw-a { font-size: 12.5px; line-height: 1.6; color: var(--aide-text-primary); white-space: pre-wrap; word-break: break-word; }
.btw-cursor { display: inline-block; width: 6px; height: 13px; vertical-align: -2px; background: var(--aide-accent); animation: btw-blink 1s steps(2, start) infinite; }
@keyframes btw-blink { 50% { opacity: 0; } }
.btw-err { font-size: 12px; color: var(--aide-danger); }
.btw-foot { display: flex; align-items: center; gap: 9px; padding: 9px 14px 9px 17px; border-top: 1px solid var(--aide-border); background: color-mix(in srgb, var(--aide-success) 6%, transparent); }
.btw-ok { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--aide-success); }
.btw-ok::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--aide-success); }
.btw-drawer-enter-active, .btw-drawer-leave-active { transition: transform 0.2s ease, opacity 0.2s ease; }
.btw-drawer-enter-from, .btw-drawer-leave-to { transform: translateX(20px); opacity: 0; }
</style>
```

- [ ] **Step 2: ChatPanel 挂载抽屉 + 联动**

ChatPanel 模板 `.chat-panel`(506 行)内末尾加:

```html
    <BtwDrawer
      :visible="btwDrawerVisible"
      :lightweight="btwLightweight"
      @update:lightweight="btwLightweight = $event"
      @close="closeBtw"
      @stop="stopBtw"
    />
```

script 加:

```ts
import BtwDrawer from "./BtwDrawer.vue";
import { useBtwSession } from "@/composables/useBtwSession";
const btw = useBtwSession();
const btwDrawerVisible = computed(() => !!btw.store.value.question || btw.store.value.isBusy || btw.store.value.done);
function closeBtw() { btw.cleanup(); }
function stopBtw() { btw.cleanup(); } // cleanup 走 stop_chat_session(kill 进程,跑中也生效)
```

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm vue-tsc --noEmit` + `pnpm tauri dev`,手动走完三状态(触发→跑中→跑完批注)。

```bash
git add src/components/BtwDrawer.vue src/components/ChatPanel.vue
git commit -m "feat(btw): BtwDrawer floating side panel + ChatPanel wiring"
```

---

### Task 10: `ChatMessage.vue` — btw 页边批注渲染

**Files:**
- Modify: `src/components/ChatMessage.vue`(action-only user 消息:actionId==='btw' 走折叠批注,其余走原药丸)

**Interfaces:**
- Consumes: `ActionBlock`(actionId='btw',label/body/hint/foldable/icon)from Task 4
- Produces:右对齐、虚线 accent 边、默认折叠的页边批注;展开看 body + "不进上下文"提示

- [ ] **Step 1: 定位 action 渲染分支**

`ChatMessage.vue` 第 21-26 行(按 explore 报告):用户消息仅一个 action 块时走 `.msg-action-wrap` > `.msg-action-chip`。在该分支前加 btw 判断:`actionId === 'btw'` 渲染折叠批注,否则原药丸。

```html
    <!-- btw 页边批注:可折叠、视觉权重远低于真实消息,读起来是"贴在边上的便签" -->
    <div v-else-if="block.type === 'action' && block.actionId === 'btw'" class="msg-row--note">
      <details class="btw-note">
        <summary class="btw-note-head">
          <span class="btw-note-caret tri"></span>
          <span class="btw-note-glyph tri">↳</span>
          <span class="btw-note-tag">btw</span>
          <span class="btw-note-q">{{ block.label }}</span>
          <span class="btw-note-sep">·</span>
          <span class="btw-note-hint">{{ block.hint ?? '不进上下文' }}</span>
        </summary>
        <div class="btw-note-body">
          <div>{{ block.body }}</div>
          <div class="btw-note-warn">↳ 这是支线结论,不会进入主对话上下文。</div>
        </div>
      </details>
    </div>
    <!-- 原 action 药丸(压缩/清空上下文)-->
    <div v-else-if="…" class="msg-action-wrap">…</div>
```

> 实际改写时保留原 `v-if`/`v-else-if` 链结构,仅插入 btw 分支。`tri` 类 = `font-size:14px;line-height:1`(三角箭头统一 14px)。

- [ ] **Step 2: 样式(全部 --aide-*,虚线 + accent)**

`<style>`(非 scoped 或对应作用域)追加:

```css
.msg-row--note { display: flex; justify-content: flex-end; padding: 2px 12px; }
.btw-note {
  max-width: 70%; border: 1px dashed var(--aide-accent); border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--aide-accent) 6%, transparent); overflow: hidden;
}
.btw-note-head {
  display: flex; align-items: center; gap: 7px; padding: 5px 11px; cursor: pointer;
  list-style: none; font-size: 12px; color: var(--aide-accent);
}
.btw-note-head::-webkit-details-marker { display: none; }
.btw-note-caret {
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid var(--aide-accent); opacity: 0.7; transition: transform 0.15s;
}
.btw-note[open] .btw-note-caret { transform: rotate(90deg); }
.btw-note-glyph { color: var(--aide-accent); }
.btw-note-tag {
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em; padding: 1px 6px;
  border-radius: 999px; border: 1px solid var(--aide-accent); color: var(--aide-accent);
}
.btw-note-q { color: var(--aide-text-secondary); font-size: 12px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btw-note-sep { color: var(--aide-text-muted); }
.btw-note-hint { font-size: 10px; color: var(--aide-text-muted); display: flex; align-items: center; gap: 4px; }
.btw-note-hint::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--aide-success); }
.btw-note-body { padding: 2px 12px 9px; font-size: 12px; line-height: 1.6; color: var(--aide-text-secondary); border-top: 1px dashed var(--aide-border); }
.btw-note-warn { font-size: 11px; color: var(--aide-text-muted); margin-top: 7px; }
```

- [ ] **Step 3: 验证批注不进 SDK 上下文**

确认 `dispatchSend`/主对话发消息构造 SDK messages 时不含 action 块——现有 `useChatSession.dispatchSend` 给 sidecar 发的是 `sendText`(纯文本),用户气泡的 action 块只是前端渲染,不进 sendText。btw 批注同理:它只在 `store.messages` 里(前端可见),主对话下次 `send` 时 `sendText` 来自用户输入,不含历史 action 块。**验证点**:手动测——btw 跑完批注出现后,主对话再发一条普通消息,确认模型行为未受批注影响(批注不进 resume 上下文,因为 sidecar 的 resume 只读 JSONL,btw 批注不在 JSONL 里)。

- [ ] **Step 4: Commit**

```bash
git add src/components/ChatMessage.vue
git commit -m "feat(btw): render btw conclusion as collapsible margin note in ChatMessage"
```

---

### Task 11: 集成验证 + 文档

**Files:**
- Modify: `CLAUDE.md`(关键约定追加 btw 段)、`docs/ARCHITECTURE.md`(如需)

- [ ] **Step 1: 全量测试**

Run: `cd agent-sidecar && pnpm vitest run && pnpm build`
Run: `cd src-tauri && cargo test --lib`
Run: `pnpm vitest run && pnpm vue-tsc --noEmit`
Expected: 全绿。

- [ ] **Step 2: 手动集成清单(`pnpm tauri dev`)**

- 主对话发一条长任务(让它跑着)→ 发送下拉点"顺便问一下"→ 横幅 + 输入框高亮 → 打支线问题回车 → 横幅收起 + 输入框 accent 闪烁回弹 + "已切回主对话输入" toast → 右侧抽屉出、流式输出。
- 主对话同时在跑、不被阻塞。
- 抽屉切"完整"需在跑前;跑中切被禁用。
- 抽屉"停止"→ 进程 kill、抽屉关。
- 跑完 → 主对话末尾出现虚线页边批注(默认折叠)→ 展开看结论 + "不进上下文"提示。
- 主对话再发普通消息 → 模型行为不受批注影响(隔离)。
- 切主会话 → btw 抽屉关、进程清理。
- 检查磁盘:btw 跑完后 `~/.claude-code-desktop` 下无新 fork JSONL(`persistSession:false`)。

- [ ] **Step 3: 更新 CLAUDE.md 关键约定**

在 `CLAUDE.md`「关键约定」追加一条:

```markdown
- **/btw 支线子对话(顺便问一下)**:发送按钮下拉切"顺便问一下"→ fork 主会话当前状态开独立 sidecar 进程(`start_btw_session` → `send` 带 `btw:true`+`session_id=<主sid>` → SDK `forkSession:true`+`persistSession:false`)。独立 `useBtwSession` store、右侧浮层 `BtwDrawer`(不挤占主对话)、事件按 session_id 路由隔离。跑完结论以 `ActionBlock(actionId:'btw',foldable)` 页边批注回插主对话(前端可见、不进 SDK resume 上下文)。默认轻量(`tools:[]` 禁工具省 token),可切完整(继承主工具集)。一次性:发送后自动切回主对话输入(回弹视觉)。阅后即弃:不落盘、不能重开、单实例。Claude 专属(forkSession/persistSession/tools)只落 `agent-sidecar/`,Rust/前端走 `btw:true` 中性标记。
```

- [ ] **Step 4: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs(btw): document btw side-conversation in CLAUDE.md"
```

---

## Self-Review

**1. Spec coverage:**
- §2 需求决策(fork/批注/阅后即弃/轻量默认/单实例/下拉触发/一次性)→ Tasks 1-10 全覆盖 ✓
- §3 架构红线(跨平台/async 坑/delta 层/主题/禁止原生 UI/provider 分层)→ Global Constraints + 各 task ✓
- §4 数据流 → Tasks 2+3+5+6 ✓
- §5.1 sidecar(types/index/delta)→ Task 2 ✓;§5.2 Rust(sidecar/chat/lib)→ Task 3 ✓;§5.3 前端(useChatSession/useBtwSession/BtwDrawer)→ Tasks 5+6+8+9 ✓;§5.4 批注块 → Tasks 4+10 ✓
- §6 错误处理(主会话不存活/spawn 失败/进程死亡/未等到 session_init)→ Task 3(has_session 校验)+ Task 5(error/session_dead 分支)+ startBtw 抛错 ✓
- §7 清理时机 → Task 9(close/stop)+ Task 5(cleanup)+ 切主会话(需在 ChatPanel watch active session 调 cleanup——**补:** Task 9 Step 2 加 `watch(activeSessionId, () => btw.cleanup())`)

**补:Task 9 缺"切主会话触发 cleanup"** — 修正:Task 9 Step 2 closeBtw 已有;但切主会话需额外 watch。已在上面 Self-Review 标记,实现时在 ChatPanel 加 `watch(() => props.sessionId, () => { if (!btw.store.value.done) btw.cleanup(); })`。补入 Task 9。

- §8 视觉 → Tasks 7+8+9+10 + 原型 ✓
- §9 测试 → Task 1+3+5 单测 + Task 11 集成清单 ✓
- §10 范围(v1 不做)→ 未实现并行/持久化/图片/fork mid-turn ✓

**2. Placeholder scan:** 无 TBD/TODO;所有代码块完整;`…` 仅出现在"原逻辑不变"的指示处(实现者保留原代码,不是占位)。

**3. Type consistency:**
- `build_btw_send_cmd`(Rust)产出 `{cmd:send, session_id, btw:true, lightweight, prompt, cwd, permission_mode?}` ↔ sidecar `send` 命令新增 `btw?`/`lightweight?` 字段(Task 2)✓
- `btwQueryOverrides`/`forkResumeOptions`(Task 1)签名 ↔ Task 2 调用 ✓
- `useBtwSession.isBtwSid`/`handleBtwEvent`/`startBtw`/`cleanup`/`setOnDone`(Task 5)↔ Task 6 调用 ✓
- `ActionBlock` 扩展(Task 4)↔ useBtwSession 组装(Task 5)↔ ChatMessage 渲染(Task 10)字段名 `actionId`/`label`/`body`/`hint`/`foldable`/`icon` 一致 ✓
- `sendBtw(prompt, {lightweight, permissionMode})`(Task 6)↔ ChatPanel `emit("send-btw", text, {lightweight})`(Task 8)↔ App.vue 调 sendBtw ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-btw-side-conversation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**