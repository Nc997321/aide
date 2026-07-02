# Agent SDK 迁移遗留问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Agent SDK 迁移后的数据正确性 bug（缓存污染 / resume 断裂 / `new_` ID 永不迁移 / 后台会话事件丢失 / 权限死锁 / stderr 假死）、恢复通知链路，并打通 dev 与 release 的 sidecar 构建分发路径。

**Architecture:** 前端把「单一 messages ref + 切换时拷贝缓存」改为**每会话独立 store**（模块级 reactive Map），前台/后台事件走同一条写入路径；会话 ID 生命周期改为「`new_` 草稿 ID → 首次 `session_init` 事件到达时确定性迁移为 SDK UUID」（Rust 端 `migrate_session` 命令一次性改名 sidecar 注册表 + 元数据 + 变更记录 + 最近访问，前端 alias map 兜住迁移窗口期的事件）；`message_stop` 恢复置 `waiting` 状态以复活通知/横幅/变更捕获。

**Tech Stack:** Vue 3 Composition API + TypeScript、Tauri v2 (Rust)、Node.js sidecar（@anthropic-ai/claude-agent-sdk 0.3.197）、vitest 4、esbuild。

## Global Constraints

- **Provider 抽象红线**（项目 CLAUDE.md「架构红线」）：前端与 Rust 层只依赖 `ChatEvent` / `SidecarCommand` 协议；本计划新增的 `permission_cancelled` 事件是 provider 无关的，Claude 专属逻辑只能改 `agent-sidecar/`。
- **跨平台红线**：Rust 路径一律 `PathBuf`；`creation_flags(0x08000000)` 必须 `#[cfg(windows)]`；dev.ps1 与 dev.sh 功能对等。
- **Windows 坑点**：任何 spawn 外部进程的代码必须带 `CREATE_NO_WINDOW (0x08000000)`（CLAUDE.md）。
- **不做的事**（后续独立计划）：流式输出（includePartialMessages）、权限「总是允许」持久化、Edit diff 渲染、plan mode / 模型切换、忙碌时排队输入。
- 提交信息用中文、`feat(scope):` / `fix(scope):` 前缀，与 git log 现有风格一致。
- 前端验证命令：`pnpm test`（vitest）、`pnpm build`（vue-tsc + vite）。Rust 验证：`cargo check`（在 `src-tauri/` 下）、`cargo test`。
- **网络注意**：`agent-sidecar/node_modules` 当前缺失。任何需要 `npm install` 的步骤如果失败，**停下来向用户要代理端口**（用户全局 CLAUDE.md 规则），不要反复重试。

---

### Task 1: sidecar.rs — 会话重命名支持 + stderr 不再伪装成 error 事件

**Files:**
- Modify: `src-tauri/src/sidecar.rs`

**Interfaces:**
- Produces: `SidecarManager::rename(&self, old_id: &str, new_id: &str) -> Result<(), String>`（Task 2 的 `migrate_session` 命令调用）
- Produces: stdout reader 之后 emit 的事件里 `session_id` 跟随 rename 实时变化（通过 `Arc<Mutex<String>>` 共享）
- 行为变化: stderr 每行**不再**作为 `error` ChatEvent 发给前端，只 `eprintln!` 并存入尾部环形缓冲；sidecar 意外退出时把缓冲尾部拼进那条唯一的 `error` 事件消息。

- [ ] **Step 1: 改写 sidecar.rs**

用以下要点改写（保持其余逻辑不变）：

```rust
use std::collections::{HashMap, VecDeque};
// ...原有 imports 不变...

struct SidecarSession {
    stdin: Arc<TokioMutex<ChildStdin>>,
    child: Child,
    killed: Arc<AtomicBool>,
    /// 会话 ID 共享句柄：rename 后 stdout/stderr reader 任务发出的事件立刻带新 ID
    sid: Arc<Mutex<String>>,
}
```

`spawn()` 中：

```rust
let killed = Arc::new(AtomicBool::new(false));
let sid_shared = Arc::new(Mutex::new(session_id.clone()));
// stderr 尾部缓冲（最多 8 行），意外退出时用于诊断信息
let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

// stdout reader 任务：sid.clone() 改为读取共享句柄
let sid_handle = Arc::clone(&sid_shared);
let tail_handle = Arc::clone(&stderr_tail);
let app = app_handle.clone();
let killed_clone = Arc::clone(&killed);
tokio::spawn(async move {
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if let Ok(mut event) = serde_json::from_str::<Value>(&line) {
            let current_sid = sid_handle.lock().unwrap().clone();
            if let Some(obj) = event.as_object_mut() {
                if obj.get("type").and_then(|t| t.as_str()) == Some("session_init") {
                    if let Some(sdk_sid) = obj.get("session_id").cloned() {
                        obj.insert("sdk_session_id".to_string(), sdk_sid);
                    }
                }
                obj.insert("session_id".to_string(), Value::String(current_sid));
            }
            let _ = app.emit("chat-event", event);
        }
    }
    if !killed_clone.load(Ordering::Relaxed) {
        let current_sid = sid_handle.lock().unwrap().clone();
        let tail: Vec<String> = tail_handle.lock().unwrap().iter().cloned().collect();
        let detail = if tail.is_empty() {
            String::new()
        } else {
            format!("\n{}", tail.join("\n"))
        };
        let exit_event = serde_json::json!({
            "type": "error",
            "message": format!("Sidecar process exited unexpectedly{detail}"),
            "session_id": current_sid
        });
        let _ = app.emit("chat-event", exit_event);
    }
});

// stderr reader 任务：只记录，不 emit 事件
let tail_writer = Arc::clone(&stderr_tail);
tokio::spawn(async move {
    let mut reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if line.is_empty() { continue; }
        eprintln!("[sidecar stderr] {}", line);
        let mut buf = tail_writer.lock().unwrap();
        if buf.len() >= 8 { buf.pop_front(); }
        buf.push_back(line);
    }
});

self.sessions.lock().unwrap().insert(
    session_id,
    SidecarSession { stdin, child, killed, sid: sid_shared },
);
```

新增方法：

```rust
/// 把运行中会话从 old_id 重命名为 new_id：重挂 HashMap key 并更新共享 sid，
/// 之后 reader 任务发出的事件立即携带新 ID。old 不存在时静默成功（幂等）。
pub fn rename(&self, old_id: &str, new_id: &str) -> Result<(), String> {
    let mut sessions = self.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(old_id) {
        *session.sid.lock().unwrap() = new_id.to_string();
        sessions.insert(new_id.to_string(), session);
    }
    Ok(())
}
```

注意：原来 stderr 任务里的 `if line.starts_with("[sidecar]") { continue; }` 与「每行 emit error 事件」逻辑整体删除。

- [ ] **Step 2: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无 warning 新增（`sid2`/`app2` 等已删变量不再引用）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sidecar.rs
git commit -m "fix(sidecar): stderr 不再伪装 error 事件；支持运行中会话重命名"
```

---

### Task 2: migrate_session 命令 —— 一次性迁移会话 ID 的所有落点

**Files:**
- Modify: `src-tauri/src/commands/session.rs`（新增 `migrate_session` 命令 + 纯函数 helper + 单测）
- Modify: `src-tauri/src/commands/recent.rs`（新增 `rename_recent_session` pub fn）
- Modify: `src-tauri/src/lib.rs`（注册命令）
- Modify: `src/api.ts`（新增 `migrateSession` 封装）

**Interfaces:**
- Consumes: Task 1 的 `SidecarManager::rename(old, new)`
- Produces: Tauri 命令 `migrate_session(old_id: String, new_id: String)`；前端 `api.migrateSession(oldId, newId): Promise<void>`（Task 4 调用）
- 迁移落点：sidecar 注册表、`our_sessions_dir()/<id>.json`（名字元数据，重写内部 `id` 字段）、`our_sessions_dir()/<id>-changes.json`（变更轮次）、`recent.json` 里的 `session_id`。

- [ ] **Step 1: recent.rs 新增纯函数 + 落盘封装**

在 `// ── 纯函数（无 IO，可单测） ──` 区域追加：

```rust
/// 把 recent 列表里 old_id 的会话条目改成 new_id（去重：若 new_id 已存在则移除 old 条目）。
pub fn rename_session_entry(state: &mut RecentState, old_id: &str, new_id: &str) -> bool {
    if state.sessions.iter().any(|s| s.session_id == new_id) {
        let before = state.sessions.len();
        state.sessions.retain(|s| s.session_id != old_id);
        return state.sessions.len() != before;
    }
    let mut changed = false;
    for s in state.sessions.iter_mut() {
        if s.session_id == old_id {
            s.session_id = new_id.to_string();
            changed = true;
        }
    }
    changed
}
```

在 `// ── Tauri 命令 ──` 区域前追加（供 session.rs 调用，不是 Tauri 命令）：

```rust
pub fn rename_recent_session(old_id: &str, new_id: &str) -> Result<(), String> {
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    if rename_session_entry(&mut guard, old_id, new_id) {
        save_recent_file(&guard)?;
    }
    Ok(())
}
```

- [ ] **Step 2: recent.rs 单测（先写测试）**

recent.rs 文件末尾（若已有 `#[cfg(test)]` 模块则并入）：

```rust
#[cfg(test)]
mod rename_tests {
    use super::*;

    fn sess(id: &str) -> RecentSession {
        RecentSession {
            ws_key: "w".into(), ws_name: "w".into(),
            session_id: id.into(), name: "n".into(), ts: 1,
        }
    }

    #[test]
    fn renames_matching_entry() {
        let mut st = RecentState { sessions: vec![sess("new_1")], files: Default::default() };
        assert!(rename_session_entry(&mut st, "new_1", "uuid-a"));
        assert_eq!(st.sessions[0].session_id, "uuid-a");
    }

    #[test]
    fn dedupes_when_new_id_already_present() {
        let mut st = RecentState { sessions: vec![sess("uuid-a"), sess("new_1")], files: Default::default() };
        assert!(rename_session_entry(&mut st, "new_1", "uuid-a"));
        assert_eq!(st.sessions.len(), 1);
    }

    #[test]
    fn noop_when_absent() {
        let mut st = RecentState { sessions: vec![sess("x")], files: Default::default() };
        assert!(!rename_session_entry(&mut st, "new_1", "uuid-a"));
    }
}
```

Run: `cd src-tauri && cargo test rename_`
Expected: 先 FAIL（函数未写时）→ 实现后 3 个测试 PASS。

- [ ] **Step 3: session.rs 新增 migrate_session**

```rust
/// 会话 ID 迁移：new_<ts> 草稿 ID → SDK 真实 UUID。
/// 幂等：任何落点不存在都静默跳过。
#[tauri::command]
pub fn migrate_session(
    old_id: String,
    new_id: String,
    sidecar_mgr: State<'_, crate::sidecar::SidecarManager>,
) -> Result<(), String> {
    if old_id == new_id {
        return Ok(());
    }
    // 1. sidecar 注册表（必须最先做：后续 send_message 按 new_id 找进程）
    sidecar_mgr.rename(&old_id, &new_id)?;

    // 2. 名字元数据 <old>.json → <new>.json，重写内部 id 字段
    let dir = our_sessions_dir();
    let old_meta = dir.join(format!("{}.json", old_id));
    if old_meta.exists() {
        if let Ok(content) = fs::read_to_string(&old_meta) {
            if let Ok(mut v) = serde_json::from_str::<Value>(&content) {
                v["id"] = Value::String(new_id.clone());
                let new_meta = dir.join(format!("{}.json", new_id));
                fs::write(&new_meta, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("Failed to write migrated meta: {}", e))?;
                let _ = fs::remove_file(&old_meta);
            }
        }
    }

    // 3. 变更轮次 <old>-changes.json → <new>-changes.json
    let old_changes = dir.join(format!("{}-changes.json", old_id));
    if old_changes.exists() {
        let new_changes = dir.join(format!("{}-changes.json", new_id));
        let _ = fs::rename(&old_changes, &new_changes);
    }

    // 4. 最近访问
    let _ = super::recent::rename_recent_session(&old_id, &new_id);

    Ok(())
}
```

- [ ] **Step 4: lib.rs 注册**

在 `invoke_handler` 的 session 命令组（`commands::session::rename_session` 附近）加一行：

```rust
commands::session::migrate_session,
```

- [ ] **Step 5: api.ts 封装**

在 `renameSession` 后追加：

```typescript
migrateSession(oldId: string, newId: string): Promise<void> {
  return invoke("migrate_session", { oldId, newId });
},
```

- [ ] **Step 6: 验证**

Run: `cd src-tauri && cargo test && cargo check`
Expected: rename_ 测试 PASS、编译通过。

Run: `pnpm build`（根目录，校验 api.ts 类型）
Expected: vue-tsc 通过。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/session.rs src-tauri/src/commands/recent.rs src-tauri/src/lib.rs src/api.ts
git commit -m "feat(session): migrate_session 命令，new_ 草稿 ID 一次性迁移为 SDK UUID"
```

---

### Task 3: sidecar（Node 侧）—— 权限请求可取消 + 使用 Options.cwd

**Files:**
- Modify: `agent-sidecar/src/types.ts`
- Modify: `agent-sidecar/src/permissions.ts`
- Modify: `agent-sidecar/src/index.ts`
- Modify: `src/types/chat.ts`（前端镜像类型，只加事件类型定义）

**Interfaces:**
- Produces: 新 ChatEvent `{ type: "permission_cancelled"; id: string }` —— 中断导致权限请求作废时发出，前端（Task 4）据此清掉对话框。
- Produces: `PermissionManager.makeCallback` 兼容 SDK 第三参 `{ signal }`：signal abort → resolve deny + 发 `permission_cancelled`。
- 行为变化: `startLoop` 不再 `process.chdir`，改用 SDK `options.cwd`。

**⚠️ SDK 文档依赖**：本任务假设 `@anthropic-ai/claude-agent-sdk@0.3.197` 的 `canUseTool` 第三参含 `signal: AbortSignal`、`Options` 支持 `cwd?: string`。实现前先向用户要这两处的 SDK 文档确认；若 `cwd` 不支持，保留 `process.chdir` 原逻辑，只做权限部分。

- [ ] **Step 1: types.ts（sidecar）加事件**

```typescript
export type ChatEvent =
  | { type: "session_init"; session_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "permission_request"; id: string; name: string; input: unknown }
  | { type: "permission_cancelled"; id: string }
  | { type: "message_stop"; stop_reason: string; cost_usd: number | null }
  | { type: "error"; message: string };
```

- [ ] **Step 2: permissions.ts 支持 signal**

```typescript
import type { ChatEvent } from "./types.js";

export class PermissionManager {
  private pending = new Map<string, (approved: boolean) => void>();

  makeCallback(emit: (e: ChatEvent) => void) {
    return async (
      toolName: string,
      input: unknown,
      opts?: { signal?: AbortSignal },
    ) => {
      const id = crypto.randomUUID();
      emit({ type: "permission_request", id, name: toolName, input });
      const approved = await new Promise<boolean>((resolve) => {
        this.pending.set(id, resolve);
        // 中断（interrupt）会 abort signal：视为拒绝并通知前端关掉对话框
        opts?.signal?.addEventListener("abort", () => {
          if (this.pending.delete(id)) {
            emit({ type: "permission_cancelled", id });
            resolve(false);
          }
        }, { once: true });
      });
      return approved
        ? { behavior: "allow" as const, updatedInput: input as Record<string, unknown> }
        : { behavior: "deny" as const, message: "用户拒绝" };
    };
  }

  resolve(id: string, approved: boolean) {
    const resolve = this.pending.get(id);
    if (resolve) {
      this.pending.delete(id);
      resolve(approved);
    }
  }
}
```

- [ ] **Step 3: index.ts 用 options.cwd 替代 chdir**

`startLoop` 改为：

```typescript
async function startLoop(cwd?: string) {
  try {
    while (true) {
      try {
        const q = query({
          prompt: queue[Symbol.asyncIterator](),
          options: {
            permissionMode: "default",
            canUseTool: permMgr.makeCallback(emit) as any,
            settingSources: ["project", "user"],
            skills: "all",
            ...(cwd ? { cwd } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
          },
        });
        // ...其余不变...
```

`finally` 块里的 `process.chdir(originalCwd)` 与开头的 `originalCwd`/`process.chdir(cwd)` 删除。

- [ ] **Step 4: 前端 types/chat.ts 镜像**

`src/types/chat.ts` 中若有 ChatEvent 联合类型则同步加 `permission_cancelled`；若前端未定义事件联合类型（事件按 `Record<string, unknown>` 处理）则跳过此步。

- [ ] **Step 5: 构建验证（需要 node_modules）**

Run: `cd agent-sidecar && npm install`（**失败则停下向用户要代理端口**）
Run: `npm run build`
Expected: dist/sidecar.js 重新生成，无类型错误。

- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/src src/types/chat.ts
git commit -m "fix(sidecar): 中断时取消挂起的权限请求；cwd 走 SDK 选项"
```

---

### Task 4: useChatSession 重写 —— 每会话独立 store（核心任务）

**Files:**
- Rewrite: `src/composables/useChatSession.ts`
- Modify: `src/types/chat.ts`（ChatMessage 加 `streaming?: boolean`）
- Test: `src/composables/useChatSession.test.ts`（新建）

**Interfaces:**
- Consumes: `api.migrateSession`（Task 2）、Tauri 事件 `chat-event`（Task 1 格式）、`permission_cancelled` 事件（Task 3）
- Produces（App.vue 消费，签名保持兼容）:
  - `useChatSession(sessionId: Ref<string | null>)` 返回 `{ messages, isBusy, pendingPermission, sendMessage, respondPermission, interrupt, stopSession, onSessionMigrated }`
  - 新增 `stopSession(): Promise<void>`（Task 6 的停止按钮用）
  - 新增 `onSessionMigrated(cb: (oldId: string, newId: string) => void): void`（Task 5 注册侧栏/activeSessionId 换 ID）
- 状态语义（useNotification / useConversationChanges / SidebarLeft 依赖）:
  - send → `running`；permission_request → `attention`；respond → `running`；message_stop → **`waiting`**（复活通知链路）；interrupt → `waiting`；error / 进程退出 / stopSession → `stopped`。

**设计要点（实现者必读）：**
1. 模块级 `stores: Record<string, SessionStore>`（`reactive({})`），事件按 `session_id` 路由到对应 store，**前台后台同一条写入路径**，不存在「切换时拷贝缓存」。
2. 流式 assistant 消息不用对象身份比较（reactive proxy 会破坏 `===`），用 `streaming: true` 标记：最后一条消息是 `role === "assistant" && streaming` 就续写，否则新建。
3. 迁移窗口：`session_init` 携带 `sdk_session_id` 且当前 aide id 是 `new_` 前缀 → 前端立刻把 store/state/alias 换新 key，再调 `api.migrateSession`（Rust 端重命名 sidecar 注册表等）。Rust rename 完成前 reader 可能还发旧 ID 事件，用 `aliasMap` 转发。
4. resume 兜底：`sdkSessionMap` 未命中且 aide id 不是 `new_` 前缀（= 历史会话，aide id 就是 SDK session id）时，把 aide id 自己作为 resume 传下去。**这是重启后续接历史会话的关键修复。**

- [ ] **Step 1: types/chat.ts 加 streaming 标记**

`ChatMessage` 接口加一个可选字段：

```typescript
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  blocks: (TextBlock | ToolCallBlock | ImageBlock)[];
  timestamp: number;
  /** assistant 消息正在流式生成中（用于续写判定，替代对象身份比较） */
  streaming?: boolean;
}
```

（以文件实际字段为准，只追加 `streaming`。）

- [ ] **Step 2: 写失败测试**

新建 `src/composables/useChatSession.test.ts`。用 `vi.mock` 拦截 Tauri API；`listen` 的 handler 存进变量供测试直接注入事件：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

// ── Tauri mocks ──
let chatEventHandler: ((e: { payload: Record<string, unknown> }) => void) | null = null;
const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    chatEventHandler = cb;
    return () => { chatEventHandler = null; };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useChatSession, __resetForTest } from "./useChatSession";
import { useSessionState } from "./useSessionState";

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: e });
}

async function flush() {
  await Promise.resolve();
  await nextTick();
}

describe("useChatSession per-session store", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
  });

  it("后台会话的 message_stop 不会污染前台会话的消息（P0 缓存污染回归）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    await chat.sendMessage("hello A");
    emit({ type: "text_delta", delta: "A 的回复", session_id: "uuid-a" });

    // 切到 B，A 在后台完成
    sid.value = "uuid-b";
    await flush();
    emit({ type: "message_stop", stop_reason: "end_turn", cost_usd: null, session_id: "uuid-a" });
    await flush();

    // B 的消息列表必须为空（load_messages mock 返回 undefined → 空历史）
    expect(chat.messages.value).toEqual([]);

    // 切回 A，回复完整保留
    sid.value = "uuid-a";
    await flush();
    const texts = chat.messages.value.flatMap(m => m.blocks).filter(b => b.type === "text");
    expect(texts.some(b => (b as { text: string }).text.includes("A 的回复"))).toBe(true);
  });

  it("后台会话的 text_delta / tool_use / tool_result 全部入库", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    sid.value = "uuid-b";
    await flush();

    emit({ type: "text_delta", delta: "后台文本", session_id: "uuid-a" });
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" }, session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t1", content: "ok", is_error: false, session_id: "uuid-a" });
    await flush();

    sid.value = "uuid-a";
    await flush();
    const blocks = chat.messages.value.flatMap(m => m.blocks);
    expect(blocks.some(b => b.type === "text" && (b as { text: string }).text === "后台文本")).toBe(true);
    const tool = blocks.find(b => b.type === "tool_call") as { result?: string; isPending?: boolean } | undefined;
    expect(tool?.result).toBe("ok");
    expect(tool?.isPending).toBe(false);
  });

  it("历史会话（UUID id）首次发送时把自身 id 作为 resume 传下去（P0 resume 断裂回归）", async () => {
    const sid = ref<string | null>("0f6d9a2e-1234-4abc-9def-000000000001");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("continue");

    const call = invokeMock.mock.calls.find(c => c[0] === "send_message");
    expect(call?.[1]).toMatchObject({ resumeId: "0f6d9a2e-1234-4abc-9def-000000000001" });
  });

  it("new_ 草稿会话首次发送不带 resume；session_init 后触发迁移", async () => {
    const sid = ref<string | null>("new_123");
    const chat = useChatSession(sid);
    const migrated = vi.fn();
    chat.onSessionMigrated(migrated);
    await flush();
    await chat.sendMessage("first");

    const sendCall = invokeMock.mock.calls.find(c => c[0] === "send_message");
    expect((sendCall?.[1] as { resumeId?: string }).resumeId).toBeUndefined();

    emit({ type: "session_init", session_id: "sdk-uuid-1", sdk_session_id: "sdk-uuid-1", session_id_orig: undefined, ...( {} ) , });
    // ↑ 实际 payload：{ type:"session_init", sdk_session_id:"sdk-uuid-1", session_id:"new_123" }
    emit({ type: "session_init", sdk_session_id: "sdk-uuid-1", session_id: "new_123" });
    await flush();

    expect(invokeMock.mock.calls.some(c => c[0] === "migrate_session")).toBe(true);
    expect(migrated).toHaveBeenCalledWith("new_123", "sdk-uuid-1");

    // 迁移后旧 ID 事件经 alias 路由到新 store
    emit({ type: "text_delta", delta: "after", session_id: "new_123" });
    sid.value = "sdk-uuid-1";
    await flush();
    const blocks = chat.messages.value.flatMap(m => m.blocks);
    expect(blocks.some(b => b.type === "text" && (b as { text: string }).text === "after")).toBe(true);
  });

  it("后台会话的 permission_request 在切回时弹出（P1 死锁回归）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    sid.value = "uuid-b";
    await flush();
    emit({ type: "permission_request", id: "p1", name: "Bash", input: {}, session_id: "uuid-a" });
    await flush();
    expect(chat.pendingPermission.value).toBeNull();

    sid.value = "uuid-a";
    await flush();
    expect(chat.pendingPermission.value?.id).toBe("p1");
  });

  it("message_stop 置 waiting（通知链路回归）；error 置 stopped", async () => {
    const { state } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    expect(state["uuid-a"]).toBe("running");

    emit({ type: "message_stop", stop_reason: "end_turn", cost_usd: null, session_id: "uuid-a" });
    await flush();
    expect(state["uuid-a"]).toBe("waiting");
    expect(chat.isBusy.value).toBe(false);

    await chat.sendMessage("q2");
    emit({ type: "error", message: "boom", session_id: "uuid-a" });
    await flush();
    expect(state["uuid-a"]).toBe("stopped");
  });

  it("permission_cancelled 清掉挂起的对话框", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "permission_request", id: "p1", name: "Bash", input: {}, session_id: "uuid-a" });
    await flush();
    expect(chat.pendingPermission.value?.id).toBe("p1");
    emit({ type: "permission_cancelled", id: "p1", session_id: "uuid-a" });
    await flush();
    expect(chat.pendingPermission.value).toBeNull();
  });
});
```

注意测试里 `load_messages` 走 `invokeMock.mockResolvedValue(undefined)`：实现必须容忍非数组返回（视为无历史）。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run src/composables/useChatSession.test.ts`
Expected: FAIL（`__resetForTest`、`onSessionMigrated`、`stopSession` 不存在）。

- [ ] **Step 4: 重写 useChatSession.ts**

完整实现：

```typescript
import { computed, reactive, watch, type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  PermissionRequest,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
import { useSessionState } from "./useSessionState";

export interface ImageAttachment {
  data: string;
  mediaType: string;
}

interface SessionStore {
  messages: ChatMessage[];
  isBusy: boolean;
  pendingPermission: PermissionRequest | null;
  /** 是否已从磁盘加载过历史 */
  hydrated: boolean;
}

// ── 模块级单例状态 ──────────────────────────────────────────────────────────

/** 每会话独立 store：前台/后台事件同一条写入路径 */
const stores = reactive<Record<string, SessionStore>>({});
/** aide_session_id → sdk_session_id（会话续接） */
const sdkSessionMap = new Map<string, string>();
/** 迁移窗口期：旧 ID → 新 ID（Rust rename 完成前的在途事件转发） */
const aliasMap = new Map<string, string>();
/** 迁移回调（App.vue 注册，更新侧栏与 activeSessionId） */
const migrationCallbacks = new Set<(oldId: string, newId: string) => void>();

let globalUnlisten: (() => void) | null = null;

const { setSessionState, removeSessionState, state: sessionState } = useSessionState();

function getStore(sid: string): SessionStore {
  if (!stores[sid]) {
    stores[sid] = { messages: [], isBusy: false, pendingPermission: null, hydrated: false };
  }
  return stores[sid];
}

function resolveSid(raw: string): string {
  return aliasMap.get(raw) ?? raw;
}

function isDraftId(sid: string): boolean {
  return sid.startsWith("new_");
}

/** 取续写目标：最后一条消息是流式 assistant 就续写，否则新建 */
function getOrCreateAssistant(store: SessionStore): ChatMessage {
  const last = store.messages[store.messages.length - 1];
  if (last && last.role === "assistant" && last.streaming) return last;
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    blocks: [],
    timestamp: Date.now(),
    streaming: true,
  };
  store.messages.push(msg);
  return msg;
}

function finishStreaming(store: SessionStore) {
  const last = store.messages[store.messages.length - 1];
  if (last?.streaming) last.streaming = false;
}

async function migrateStore(oldId: string, newId: string) {
  // 1. 前端立即换 key + 建 alias，兜住 Rust rename 完成前的在途事件
  aliasMap.set(oldId, newId);
  if (stores[oldId]) {
    stores[newId] = stores[oldId];
    delete stores[oldId];
  }
  if (sessionState[oldId]) {
    setSessionState(newId, sessionState[oldId]);
    removeSessionState(oldId);
  }
  const sdk = sdkSessionMap.get(oldId);
  if (sdk) {
    sdkSessionMap.set(newId, sdk);
    sdkSessionMap.delete(oldId);
  }
  // 2. Rust 侧迁移（sidecar 注册表 / 元数据 / 变更记录 / 最近访问）
  try {
    await invoke("migrate_session", { oldId, newId });
  } catch (e) {
    console.warn("migrate_session failed:", e);
  }
  // 3. 通知 App.vue 更新侧栏与 activeSessionId
  for (const cb of migrationCallbacks) cb(oldId, newId);
}

function handleChatEvent(e: Record<string, unknown>) {
  const raw = e["session_id"] as string | undefined;
  if (!raw) return;
  const sid = resolveSid(raw);
  const store = getStore(sid);

  switch (e["type"]) {
    case "session_init": {
      const sdkSid = e["sdk_session_id"] as string | undefined;
      if (sdkSid) {
        sdkSessionMap.set(sid, sdkSid);
        if (isDraftId(sid) && sdkSid !== sid) {
          void migrateStore(sid, sdkSid);
        }
      }
      setSessionState(sid, "running");
      break;
    }
    case "text_delta": {
      const msg = getOrCreateAssistant(store);
      const last = msg.blocks[msg.blocks.length - 1];
      if (last?.type === "text") {
        (last as TextBlock).text += e["delta"] as string;
      } else {
        msg.blocks.push({ type: "text", text: e["delta"] as string });
      }
      break;
    }
    case "tool_use_start": {
      const msg = getOrCreateAssistant(store);
      msg.blocks.push({
        type: "tool_call",
        id: e["id"] as string,
        name: e["name"] as string,
        input: e["input"],
        isPending: true,
      } as ToolCallBlock);
      break;
    }
    case "tool_result": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find(
          (b): b is ToolCallBlock =>
            b.type === "tool_call" && (b as ToolCallBlock).id === e["id"],
        );
      if (block) {
        block.result = e["content"] as string;
        block.isError = e["is_error"] as boolean;
        block.isPending = false;
      }
      break;
    }
    case "permission_request": {
      store.pendingPermission = {
        id: e["id"] as string,
        name: e["name"] as string,
        input: e["input"],
      };
      setSessionState(sid, "attention");
      break;
    }
    case "permission_cancelled": {
      if (store.pendingPermission?.id === e["id"]) {
        store.pendingPermission = null;
      }
      break;
    }
    case "message_stop": {
      finishStreaming(store);
      store.isBusy = false;
      // waiting = sidecar 存活但空闲 → 通知/横幅/变更捕获依赖此转换
      setSessionState(sid, "waiting");
      break;
    }
    case "error": {
      finishStreaming(store);
      store.isBusy = false;
      store.pendingPermission = null;
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: `Error: ${e["message"]}` }],
        timestamp: Date.now(),
      });
      setSessionState(sid, "stopped");
      break;
    }
  }
}

async function ensureGlobalListener() {
  if (globalUnlisten) return;
  globalUnlisten = await listen<Record<string, unknown>>("chat-event", (event) => {
    handleChatEvent(event.payload);
  });
}

async function hydrate(sid: string) {
  const store = getStore(sid);
  if (store.hydrated || store.messages.length > 0 || isDraftId(sid)) {
    store.hydrated = true;
    return;
  }
  store.hydrated = true;
  try {
    const items = await invoke<Array<{ role: string; content: string; timestamp: number }>>(
      "load_messages",
      { sessionId: sid },
    );
    if (!Array.isArray(items)) return;
    // hydrate 期间可能已有实时消息进来：历史插到最前
    const history: ChatMessage[] = items.map((item) => ({
      id: crypto.randomUUID(),
      role: (item.role === "claude" ? "assistant" : item.role) as "user" | "assistant",
      blocks: [{ type: "text" as const, text: item.content }],
      timestamp: item.timestamp,
    }));
    store.messages.unshift(...history);
  } catch (e) {
    console.warn("Failed to load messages:", e);
  }
}

/** 仅测试用：清空模块级状态 */
export function __resetForTest() {
  for (const k of Object.keys(stores)) delete stores[k];
  sdkSessionMap.clear();
  aliasMap.clear();
  migrationCallbacks.clear();
  globalUnlisten?.();
  globalUnlisten = null;
}

// ── useChatSession（App.vue 顶层单例调用）───────────────────────────────────

export function useChatSession(sessionId: Ref<string | null>) {
  void ensureGlobalListener();

  const current = computed(() => (sessionId.value ? getStore(sessionId.value) : null));

  watch(
    sessionId,
    (sid) => {
      if (sid) void hydrate(sid);
    },
    { immediate: true },
  );

  async function sendMessage(
    prompt: string,
    images?: ImageAttachment[],
    resumeId?: string,
  ) {
    const sid = sessionId.value;
    if (!sid) return;
    await ensureGlobalListener();

    const store = getStore(sid);
    store.isBusy = true;
    setSessionState(sid, "running");

    const blocks: (ImageBlock | TextBlock)[] = [
      ...(images ?? []).map((img): ImageBlock => ({
        type: "image",
        data: img.data,
        mediaType: img.mediaType,
      })),
      ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
    ];
    store.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      blocks,
      timestamp: Date.now(),
    });
    finishStreaming(store); // 上一条 assistant 不再续写

    // resume 解析：显式传入 > 运行期映射 > 历史会话用自身 ID（重启后续接的关键）
    const resolvedResumeId =
      resumeId ?? sdkSessionMap.get(sid) ?? (isDraftId(sid) ? undefined : sid);

    await invoke("send_message", {
      sessionId: sid,
      prompt,
      images: images?.length ? images : null,
      resumeId: resolvedResumeId ?? null,
    });
  }

  async function respondPermission(id: string, approved: boolean) {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    store.pendingPermission = null;
    setSessionState(sid, "running");
    await invoke("permission_response", { sessionId: sid, id, approved });
  }

  async function interrupt() {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    try {
      await invoke("interrupt_session", { sessionId: sid });
    } finally {
      store.isBusy = false;
      store.pendingPermission = null;
      finishStreaming(store);
      setSessionState(sid, "waiting"); // sidecar 仍存活
    }
  }

  async function stopSession() {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    try {
      await invoke("stop_chat_session", { sessionId: sid });
    } finally {
      store.isBusy = false;
      store.pendingPermission = null;
      finishStreaming(store);
      setSessionState(sid, "stopped");
    }
  }

  function onSessionMigrated(cb: (oldId: string, newId: string) => void) {
    migrationCallbacks.add(cb);
  }

  return {
    messages: computed(() => current.value?.messages ?? []),
    isBusy: computed(() => current.value?.isBusy ?? false),
    pendingPermission: computed(() => current.value?.pendingPermission ?? null),
    sendMessage,
    respondPermission,
    interrupt,
    stopSession,
    onSessionMigrated,
  };
}
```

- [ ] **Step 5: 跑测试到全绿**

Run: `pnpm vitest run src/composables/useChatSession.test.ts`
Expected: 7 个测试 PASS。

Run: `pnpm test`
Expected: 全部测试（含既有 time/paste 测试）PASS。

- [ ] **Step 6: 修正调用方类型（App.vue / ChatPanel props）**

`isBusy`、`pendingPermission` 现在是 `ComputedRef`，与 App.vue 现有解构用法兼容（`ChatPanel` props 已接受 `{ value: boolean } | boolean`）。跑 `pnpm build` 确认 vue-tsc 无报错；如 `respondPermission`/`interrupt` 签名不匹配按编译器提示修正 App.vue（只改类型不改逻辑）。

Run: `pnpm build`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/composables/useChatSession.ts src/composables/useChatSession.test.ts src/types/chat.ts src/App.vue
git commit -m "fix(chat): 每会话独立 store，修复缓存污染/后台事件丢失/权限死锁/resume 断裂"
```

---

### Task 5: 迁移接线 —— App.vue / SidebarLeft / contextMenus

**Files:**
- Modify: `src/App.vue`（注册 onSessionMigrated；onNewSession 不再直接记 recent）
- Modify: `src/components/SidebarLeft.vue`（新增 `migrateSessionId` 暴露方法）
- Modify: `src/menus/contextMenus.ts`（删除会话前先杀 sidecar）

**Interfaces:**
- Consumes: Task 4 的 `onSessionMigrated(cb)`；Task 2 已在 Rust 侧迁移 recent，前端不用重复处理。
- Produces: `SidebarLeft` 暴露 `migrateSessionId(oldId: string, newId: string): void`。

- [ ] **Step 1: SidebarLeft 新增 migrateSessionId**

在 `addSession` 函数后追加，并加入 `defineExpose`：

```typescript
/**
 * 会话 ID 迁移（new_ 草稿 → SDK UUID）：原地替换侧栏条目 ID，保留名字与位置。
 * 不能 loadSessions()——props 异步传播会把旧条目加回来（见 CLAUDE.md 关键约定）。
 */
function migrateSessionId(oldId: string, newId: string) {
  const wsKey = activeWorkspace.value;
  const list = sessionsByWorkspace.value[wsKey] ?? [];
  const idx = list.findIndex(s => s.id === oldId);
  if (idx !== -1) {
    list.splice(idx, 1, { ...list[idx], id: newId });
    sessionsByWorkspace.value[wsKey] = [...list];
  }
}
```

```typescript
defineExpose({ newSession, loadSessions, addSession, migrateSessionId, selectSessionFromWorkspace, sessionsByWorkspace });
```

- [ ] **Step 2: App.vue 注册迁移回调 + 调整 recent 记录时机**

`useChatSession` 解构处（App.vue:107 附近）改为：

```typescript
const { pendingPermission, respondPermission, messages, isBusy, sendMessage, interrupt, stopSession, onSessionMigrated } = useChatSession(chatSessionIdRef);

onSessionMigrated((oldId, newId) => {
  sidebarRef.value?.migrateSessionId(oldId, newId);
  if (activeSessionId.value === oldId) {
    activeSessionId.value = newId;
  }
  // 迁移后才记入最近访问（真实 UUID，避免幽灵 new_ 条目）
  const name = activeSessionName.value || newId.substring(0, 8);
  void useRecent().recordCurrentSession(newId, name);
});
```

`onNewSession`（App.vue:226-231）删掉 `recordCurrentSession` 那行（recent 记录移到迁移回调）：

```typescript
async function onNewSession(name: string) {
  const session = await api.createSession(name);
  sidebarRef.value?.addSession({ id: session.id, name: session.name, timestamp: session.timestamp, last_message: "" });
  activeSessionId.value = session.id;
}
```

- [ ] **Step 3: contextMenus 删除会话前杀 sidecar**

`sessionMenuItems` 的删除 action 中，`await api.deleteSession(id)` 前加：

```typescript
await api.stopChatSession(id).catch(() => {});
```

- [ ] **Step 4: 验证**

Run: `pnpm build`
Expected: PASS。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/App.vue src/components/SidebarLeft.vue src/menus/contextMenus.ts
git commit -m "feat(session): 会话 ID 迁移接线——侧栏原地换 ID，删除会话先杀 sidecar"
```

---

### Task 6: ChatPanel 工具栏（状态点 + 停止）+ 交互小修

**Files:**
- Modify: `src/components/ChatPanel.vue`（header 状态点 + 停止按钮 + 滚动守卫 + skills 随工作区重扫）
- Modify: `src/components/ChatMessage.vue`（行号点击跳转）
- Modify: `src/App.vue`（转发 stop 事件）

**Interfaces:**
- Consumes: Task 4 的 `stopSession`、`useSessionState`。
- Produces: ChatPanel 新 emit `stop: []`。

- [ ] **Step 1: ChatPanel header 加状态点与停止按钮**

script 增加：

```typescript
import { useSessionState } from "@/composables/useSessionState";
import AStatusDot from "@/ui/AStatusDot.vue";

const { state: sessionState } = useSessionState();
const currentStatus = computed(() => {
  const sid = props.sessionId;
  if (!sid) return "stopped" as const;
  return (sessionState[sid] || "stopped") as "stopped" | "running" | "waiting" | "attention";
});
const isLive = computed(() => currentStatus.value !== "stopped");
```

emits 加 `stop: []`。template 的 `.chat-header` 改为：

```html
<div class="chat-header">
  <AStatusDot :status="currentStatus" />
  <span class="chat-header-name">{{ sessionName || sessionId || '未选择会话' }}</span>
  <button
    v-if="isLive"
    class="chat-stop-btn"
    v-tooltip="'停止会话进程'"
    @click="emit('stop')"
  >⏹ 停止</button>
</div>
```

样式（scoped 块追加）：

```css
.chat-header { gap: 8px; }
.chat-stop-btn {
  margin-left: auto;
  background: none;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-danger);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.chat-stop-btn:hover { background: var(--aide-surface-hover); }
```

（若项目未全局注册 `v-tooltip` 于该组件可用，直接用 `title="停止会话进程"`。）

- [ ] **Step 2: App.vue 转发**

```html
<ChatPanel
  ...
  @send="(prompt: string, images?: ImageAttachment[]) => sendMessage(prompt, images)"
  @interrupt="interrupt"
  @stop="stopSession"
/>
```

- [ ] **Step 3: 滚动守卫**

ChatPanel script：

```typescript
const autoScroll = ref(true);

function onScroll() {
  const el = scrollEl.value;
  if (!el) return;
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function scrollToBottom() {
  if (!autoScroll.value) return;
  nextTick(() => {
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  });
}
```

template：`<div ref="scrollEl" class="chat-messages" @scroll.passive="onScroll">`。
切换会话时重置：在现有 `watch(() => props.sessionId, ...)` 里加 `autoScroll.value = true;`。

- [ ] **Step 4: skills 随工作区重扫**

把 `onMounted` 里的扫描改为 watch：

```typescript
watch(
  () => props.workspacePath,
  async (ws) => {
    try {
      skillList.value = await api.scanPluginSkills(ws ?? "");
    } catch {
      skillList.value = [];
    }
  },
  { immediate: true },
);
```

（`onMounted` 若因此为空则删除。）

- [ ] **Step 5: ChatMessage 行号跳转**

`handleTextClick` 改为使用捕获组 3 的行号：

```typescript
const { open, openAndScrollTo } = useFileViewer();

function handleTextClick(e: MouseEvent) {
  const codeEl = (e.target as HTMLElement).closest("code");
  if (!codeEl) return;
  const text = codeEl.textContent?.trim() ?? "";
  const match = text.match(FILE_PATH_RE);
  if (!match) return;
  const filePath = match[1];
  const line = match[3] ? parseInt(match[3].slice(1), 10) : undefined;
  const isAbsolute = filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
  const fullPath = isAbsolute
    ? filePath
    : props.workspacePath
    ? `${props.workspacePath}/${filePath}`.replace(/\\/g, "/")
    : filePath;
  if (line !== undefined) {
    openAndScrollTo(fullPath, line);
  } else {
    open(fullPath);
  }
}
```

（确认 `useFileViewer` 暴露 `openAndScrollTo(path, line)`——旧 TerminalPanel 曾使用，签名一致。）

- [ ] **Step 6: 验证**

Run: `pnpm build && pnpm test`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/components/ChatPanel.vue src/components/ChatMessage.vue src/App.vue
git commit -m "feat(chat): 会话状态点+停止按钮；滚动守卫；skills 随工作区重扫；行号跳转"
```

---

### Task 7: dev 脚本集成 sidecar 构建

**Files:**
- Modify: `dev.ps1`
- Modify: `dev.sh`

**Interfaces:**
- 行为: 启动前确保 `agent-sidecar/node_modules` 存在（缺失则 `npm install`，失败时提示用户开代理）并执行 `npm run build` 产出 `dist/sidecar.js`。

- [ ] **Step 1: dev.ps1**

在启动 tauri dev 之前插入（按脚本现有结构放在依赖检查区域）：

```powershell
# ── agent-sidecar 构建 ──
Push-Location "$PSScriptRoot\agent-sidecar"
if (-not (Test-Path node_modules)) {
    Write-Host "[aide] 安装 agent-sidecar 依赖..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[aide] npm install 失败——如果是网络问题请开启代理后重试" -ForegroundColor Red
        Pop-Location; exit 1
    }
}
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[aide] sidecar 构建失败" -ForegroundColor Red
    Pop-Location; exit 1
}
Pop-Location
```

- [ ] **Step 2: dev.sh 对等**

```bash
# ── agent-sidecar 构建 ──
pushd "$(dirname "$0")/agent-sidecar" > /dev/null
if [ ! -d node_modules ]; then
  echo "[aide] 安装 agent-sidecar 依赖..."
  npm install || { echo "[aide] npm install 失败——如果是网络问题请开启代理后重试"; popd > /dev/null; exit 1; }
fi
npm run build || { echo "[aide] sidecar 构建失败"; popd > /dev/null; exit 1; }
popd > /dev/null
```

- [ ] **Step 3: 验证**

Run: `powershell -File dev.ps1`（或让用户运行）——观察 sidecar 构建段执行；node_modules 缺失时走 npm install 分支（**网络失败 → 问用户要代理**）。
Expected: dist/sidecar.js 生成后 tauri dev 正常拉起。

- [ ] **Step 4: Commit**

```bash
git add dev.ps1 dev.sh
git commit -m "chore(dev): 启动脚本集成 agent-sidecar 依赖安装与构建"
```

---

### Task 8: Release 打包路径（⚠️ 含 SDK 文档验证点）

**Files:**
- Modify: `agent-sidecar/package.json`（esbuild 参数）
- Modify: `src-tauri/tauri.conf.json`（resources）
- Modify: `src-tauri/src/sidecar.rs`（release 路径走 resource_dir + node 检测错误信息）
- Modify: `src-tauri/src/commands/chat.rs`（spawn 失败时给出可操作错误）

**⚠️ 实现前必须先做的验证（需要 node_modules，Task 7 已装）：**
1. `grep -r "claude-code" agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/` —— 确认 SDK 是否真的在运行时 require `@anthropic-ai/claude-code`，还是自带 `cli.js`。
2. SDK 若用 `import.meta.url` 定位自带的 `cli.js`/资源文件，esbuild 全量打包会破坏该定位 → 此时**不要全量打包**，改用方案 B。
3. 向用户索要 Agent SDK 的部署/打包官方文档，确认推荐分发方式。

**方案 A（SDK 可全量打包）：**
- esbuild 去掉 `--external:@anthropic-ai/claude-code`，`undici` 一并打包（纯 JS 可打包）：
  ```json
  "build": "esbuild src/index.ts --bundle --platform=node --format=esm --target=node18 --outfile=dist/sidecar.js"
  ```
- tauri.conf.json `bundle` 节点加：
  ```json
  "resources": { "../agent-sidecar/dist/sidecar.js": "agent-sidecar/sidecar.js" }
  ```

**方案 B（SDK 必须保留目录结构）：**
- 保持 external，release 时把 `dist/sidecar.js` + `node_modules/@anthropic-ai/**` + `node_modules/undici/**` 整体作为 resources 目录带上：
  ```json
  "resources": {
    "../agent-sidecar/dist/sidecar.js": "agent-sidecar/sidecar.js",
    "../agent-sidecar/node_modules": "agent-sidecar/node_modules"
  }
  ```

- [ ] **Step 1: 完成上面 3 项验证，与用户确认选 A 或 B**

- [ ] **Step 2: resolve_sidecar_path 改用 resource_dir**

```rust
fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let path = manifest.parent().unwrap().join("agent-sidecar/dist/sidecar.js");
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "Sidecar not found at {:?}. Run: cd agent-sidecar && npm run build",
            path
        ));
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let path = resource_dir.join("agent-sidecar").join("sidecar.js");
        if path.exists() {
            return Ok(path);
        }
        Err(format!("Sidecar resource missing: {:?}", path))
    }
}
```

`spawn()` 签名相应改为传入 `&app_handle` 调 `Self::resolve_sidecar_path(&app_handle)?`。

- [ ] **Step 3: node 缺失时的可操作错误**

`spawn()` 的 `cmd.spawn().map_err(...)` 错误信息改为：

```rust
.map_err(|e| format!(
    "无法启动 agent sidecar（node: {node_bin}）：{e}。请确认已安装 Node.js ≥ 18 并在 PATH 中，或设置 AIDE_NODE_PATH 环境变量指向 node 可执行文件。"
))?
```

- [ ] **Step 4: 验证**

Run: `cd src-tauri && cargo check`
Expected: PASS。

Run: `pnpm tauri build`（时间较长，可与用户确认后执行）
Expected: 产物安装目录内存在 `agent-sidecar/sidecar.js`；安装版可发送消息。

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/package.json src-tauri/tauri.conf.json src-tauri/src/sidecar.rs src-tauri/src/commands/chat.rs
git commit -m "feat(build): release 打包 sidecar 资源，node 缺失给出可操作错误"
```

---

### Task 9: 端到端验证 + 文档更新

**Files:**
- Modify: `CLAUDE.md`（项目结构小节：TerminalPanel 相关描述已过时，替换为 Chat 架构；「PTY key 不能重命名」「session ID 迁移」两条关键约定改写为新机制）
- Modify: `docs/ARCHITECTURE.md`（如存在 PTY 章节则同步）

- [ ] **Step 1: 手动端到端清单（dev 模式运行）**

1. 新建会话 → 发消息 → 侧栏条目 ID 变为 UUID（名字保留）→ 重启应用后名字仍在、继续发消息能接上上下文。
2. 会话 A 运行中切到会话 B → A 完成后切回，回复完整；B 消息区不受污染。
3. 会话 A 运行中触发权限请求 → 切到 B 再切回 A → 对话框弹出。
4. 回复完成且窗口失焦 → 桌面通知「已回复」+ 任务栏闪烁 + 回焦横幅出现。
5. 变更面板：新建会话首轮结束后出现轮次记录；撤回按钮可用。
6. 停止按钮杀掉 sidecar → 状态点变灰 → 再发消息自动重启并 resume。
7. 中断按钮：生成中点中断 → 状态回 waiting；权限框挂起时中断 → 框自动消失。

- [ ] **Step 2: CLAUDE.md 关键约定改写**

删除「PTY key 不能重命名」「session ID 迁移」两条，替换为：

```markdown
- **会话 ID 生命周期**：新会话用 `new_<timestamp>` 草稿 ID；首次 `session_init` 事件到达后前端调 `migrate_session` 一次性迁移（sidecar 注册表 / 元数据 / 变更记录 / 最近访问），此后 aide ID == SDK session ID。历史会话续接：resume 兜底传自身 ID。
- **状态语义**：running（生成中）/ attention（等权限确认）/ waiting（sidecar 存活空闲，message_stop 后）/ stopped（进程不在）。通知与变更捕获依赖 running→waiting 转换。
- **stderr 不是错误**：sidecar stderr 只进日志与尾部缓冲，仅进程意外退出时才发一条 error 事件。
```

项目结构小节里 `TerminalPanel.vue`、`useTerminalManager.ts`、`useSessionMonitor.ts`、`pty.rs` 的条目替换为 `ChatPanel.vue`、`useChatSession.ts`、`sidecar.rs`、`commands/chat.rs`、`agent-sidecar/`。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/ARCHITECTURE.md
git commit -m "docs: 更新 Chat 架构约定与会话 ID 生命周期说明"
```

---

## Self-Review

- **Spec 覆盖**：P0 缓存污染（Task 4 store 化 + 回归测试）✅；P0 resume 断裂（Task 4 resume 兜底 + 测试）✅；P0 `new_` 迁移（Task 1+2+4+5 全链路）✅；P1 后台事件丢失（Task 4 统一路由 + 测试）✅;P1 权限死锁（Task 4 per-store pendingPermission + 测试）✅；P1 stderr 假死（Task 1）✅；P2 通知链路（Task 4 waiting 语义 + 测试）✅；P2 小修（Task 6）✅；打包（Task 7+8）✅；文档（Task 9）✅。
- **明确排除**（后续独立计划）：流式输出、权限持久化规则、diff 渲染、plan mode/模型切换、排队输入。
- **类型一致性**：`migrate_session` 命令名 / `api.migrateSession` / `invoke("migrate_session")` 一致；`stopSession`/`onSessionMigrated` 在 Task 4 定义、Task 5/6 消费一致；`permission_cancelled` 在 Task 3 定义、Task 4 消费一致。
- **SDK 文档依赖**（两处，实现时向用户索要）：Task 3 的 `canUseTool` signal 参数与 `Options.cwd`；Task 8 的 SDK 打包/部署方式。
