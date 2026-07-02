# Agent SDK 迁移实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Aide 的对话引擎从 PTY 包裹 Claude CLI 完全替换为 Claude Agent SDK（Node.js sidecar），精确感知对话结束、工具调用边界和权限确认。

**Architecture:** Rust 后端通过 `tokio::process::Command` 启动 Node.js sidecar 子进程（每会话一个），sidecar 使用 `@anthropic-ai/claude-agent-sdk` 的流式输入模式运行 agent loop，通过 stdin/stdout JSON lines 与 Rust 通信，Rust 将事件转发为 Tauri 前端事件，前端渲染 Chat UI 替换原有终端界面。

**Tech Stack:** Rust + Tauri v2、Node.js 18+（用户机器上必须已安装）、`@anthropic-ai/claude-agent-sdk`（TypeScript）、esbuild、Vue 3 + Composition API、xterm.js（仅用于 bash 输出块）

## Global Constraints

- Windows 必须加 `CREATE_NO_WINDOW (0x08000000)` 标志（所有 `Command::new` 子进程）
- Tauri 前端用 `@tauri-apps/api` invoke/listen，不直接调 HTTP
- 所有 Rust 异步用 `tokio`（项目已依赖）
- Vue 组件用 Composition API + TypeScript，不用 Options API
- 不破坏现有 session.rs 的 JSONL 读取逻辑（`list_sessions`、`load_messages`）
- Node.js 路径：优先 `AIDE_NODE_PATH` 环境变量，否则直接 `node`（系统 PATH）
- sidecar JS 构建输出：`agent-sidecar/dist/sidecar.js`；release 时复制到 Tauri 资源目录

---

### Task 1: agent-sidecar 项目脚手架 + IPC 基础类型

**Files:**
- Create: `agent-sidecar/package.json`
- Create: `agent-sidecar/tsconfig.json`
- Create: `agent-sidecar/src/types.ts`
- Create: `agent-sidecar/src/index.ts`（本 task 仅做 stdin echo 测试）

**Interfaces:**
- Produces: `ChatEvent` 和 `SidecarCommand` 类型定义，后续所有 task 依赖

- [ ] **Step 1: 创建目录和 package.json**

```bash
mkdir agent-sidecar
cd agent-sidecar
```

`agent-sidecar/package.json`:
```json
{
  "name": "agent-sidecar",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/sidecar.js",
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --target=node18 --outfile=dist/sidecar.js --external:@anthropic-ai/claude-code",
    "dev": "npx tsx src/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

`agent-sidecar/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 安装依赖**

```bash
cd agent-sidecar
npm install
```

- [ ] **Step 4: 创建 src/types.ts**

`agent-sidecar/src/types.ts`:
```typescript
// Sidecar → Rust（每行一个 JSON，写入 stdout）
export type ChatEvent =
  | { type: "session_init"; session_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "permission_request"; id: string; name: string; input: unknown }
  | { type: "message_stop"; stop_reason: string; cost_usd: number | null }
  | { type: "error"; message: string };

// Rust → Sidecar（每行一个 JSON，从 stdin 读取）
export type SidecarCommand =
  | { cmd: "send"; prompt: string; session_id?: string; cwd?: string }
  | { cmd: "permission_response"; id: string; approved: boolean }
  | { cmd: "interrupt" };
```

- [ ] **Step 5: 创建最小 src/index.ts（echo 测试用）**

`agent-sidecar/src/index.ts`（暂时只做 echo，Task 2 替换为真实逻辑）:
```typescript
import * as readline from "readline";
import type { ChatEvent, SidecarCommand } from "./types.js";

function emit(event: ChatEvent) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const cmd: SidecarCommand = JSON.parse(line);
    // echo back for test
    emit({ type: "session_init", session_id: "test-" + Date.now() });
    if (cmd.cmd === "send") {
      emit({ type: "text_delta", delta: "echo: " + cmd.prompt });
      emit({ type: "message_stop", stop_reason: "end_turn", cost_usd: 0 });
    }
  } catch (e) {
    emit({ type: "error", message: String(e) });
  }
});
```

- [ ] **Step 6: 验证 echo 流程**

```bash
cd agent-sidecar
echo '{"cmd":"send","prompt":"hello"}' | npx tsx src/index.ts
```

预期输出（每行一个 JSON）:
```
{"type":"session_init","session_id":"test-..."}
{"type":"text_delta","delta":"echo: hello"}
{"type":"message_stop","stop_reason":"end_turn","cost_usd":0}
```

- [ ] **Step 7: Commit**

```bash
git add agent-sidecar/
git commit -m "feat(sidecar): scaffold agent-sidecar project with IPC types"
```

---

### Task 2: Sidecar Agent Loop 完整实现

**Files:**
- Create: `agent-sidecar/src/generator.ts`
- Create: `agent-sidecar/src/permissions.ts`
- Create: `agent-sidecar/src/mapper.ts`
- Modify: `agent-sidecar/src/index.ts`（替换为真实 SDK 逻辑）

**Interfaces:**
- Consumes: `ChatEvent`、`SidecarCommand`（Task 1）
- Produces: 完整 sidecar 可执行文件 `agent-sidecar/dist/sidecar.js`

- [ ] **Step 1: 创建 generator.ts（消息队列 AsyncGenerator）**

`agent-sidecar/src/generator.ts`:
```typescript
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class MessageQueue {
  private queue: SDKUserMessage[] = [];
  private resolveNext: (() => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage) {
    this.queue.push(msg);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  close() {
    this.closed = true;
    this.resolveNext?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => { this.resolveNext = resolve; });
      }
    }
  }
}
```

- [ ] **Step 2: 创建 permissions.ts（canUseTool 回调）**

`agent-sidecar/src/permissions.ts`:
```typescript
import type { ChatEvent } from "./types.js";

export class PermissionManager {
  private pending = new Map<string, (approved: boolean) => void>();

  makeCallback(emit: (e: ChatEvent) => void) {
    return async (toolName: string, input: unknown) => {
      const id = crypto.randomUUID();
      emit({ type: "permission_request", id, name: toolName, input });
      const approved = await new Promise<boolean>((resolve) => {
        this.pending.set(id, resolve);
      });
      return approved
        ? { behavior: "allow" as const, updatedInput: input }
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

- [ ] **Step 3: 创建 mapper.ts（SDK 消息 → ChatEvent）**

`agent-sidecar/src/mapper.ts`:
```typescript
import type { ChatEvent } from "./types.js";

// SDK message types from @anthropic-ai/claude-agent-sdk
export function mapSdkMessage(msg: any, emit: (e: ChatEvent) => void) {
  if (msg.type === "system" && msg.subtype === "init") {
    emit({ type: "session_init", session_id: msg.session_id });
    return;
  }

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        emit({ type: "text_delta", delta: block.text });
      } else if (block.type === "tool_use") {
        emit({ type: "tool_use_start", id: block.id, name: block.name, input: block.input });
      }
    }
    return;
  }

  if (msg.type === "user" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? "").join("")
          : String(block.content ?? "");
        emit({ type: "tool_result", id: block.tool_use_id, content, is_error: block.is_error ?? false });
      }
    }
    return;
  }

  if (msg.type === "result") {
    emit({
      type: "message_stop",
      stop_reason: msg.subtype === "success" ? "end_turn" : msg.subtype,
      cost_usd: msg.total_cost_usd ?? null,
    });
    return;
  }
}
```

- [ ] **Step 4: 替换 index.ts 为完整 Agent SDK 实现**

`agent-sidecar/src/index.ts`:
```typescript
import * as readline from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, SidecarCommand } from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager } from "./permissions.js";
import { mapSdkMessage } from "./mapper.js";

function emit(event: ChatEvent) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

const queue = new MessageQueue();
const permMgr = new PermissionManager();
let abortController = new AbortController();
let sessionId: string | undefined;

// 启动 agent loop（流式输入模式）
async function startLoop(cwd?: string) {
  const originalCwd = process.cwd();
  if (cwd) process.chdir(cwd);

  try {
    for await (const msg of query({
      prompt: queue[Symbol.asyncIterator](),
      options: {
        permissionMode: "default",
        allowedTools: ["Read", "Glob", "Grep", "Skill"],
        canUseTool: permMgr.makeCallback(emit),
        settingSources: ["project", "user"],
        skills: "all",
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })) {
      mapSdkMessage(msg, emit);
      // capture session_id from init event
      if ((msg as any).type === "system" && (msg as any).subtype === "init") {
        sessionId = (msg as any).session_id;
      }
    }
  } catch (e: any) {
    if (e?.name !== "AbortError") {
      emit({ type: "error", message: String(e?.message ?? e) });
    }
  } finally {
    if (cwd) process.chdir(originalCwd);
  }
}

// 处理 stdin 指令
const rl = readline.createInterface({ input: process.stdin });
let loopStarted = false;

rl.on("line", (line) => {
  let cmd: SidecarCommand;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  if (cmd.cmd === "send") {
    if (cmd.session_id) sessionId = cmd.session_id;
    if (!loopStarted) {
      loopStarted = true;
      startLoop(cmd.cwd);
    }
    queue.push({
      type: "user",
      message: { role: "user", content: cmd.prompt },
      parent_tool_use_id: null,
    } as any);
  } else if (cmd.cmd === "permission_response") {
    permMgr.resolve(cmd.id, cmd.approved);
  } else if (cmd.cmd === "interrupt") {
    abortController.abort();
    abortController = new AbortController();
  }
});

rl.on("close", () => {
  queue.close();
  process.exit(0);
});
```

- [ ] **Step 5: 设置 ANTHROPIC_API_KEY 并测试真实 API 调用**

```bash
cd agent-sidecar
export ANTHROPIC_API_KEY=your-key
echo '{"cmd":"send","prompt":"say hello in 3 words","cwd":"/tmp"}' | npx tsx src/index.ts
```

预期：先输出 `session_init`，再输出若干 `text_delta`，最后 `message_stop`

- [ ] **Step 6: 构建 sidecar bundle**

```bash
cd agent-sidecar
npm run build
```

验证：
```bash
export ANTHROPIC_API_KEY=your-key
echo '{"cmd":"send","prompt":"say hi"}' | node dist/sidecar.js
```

预期输出同上

- [ ] **Step 7: Commit**

```bash
git add agent-sidecar/
git commit -m "feat(sidecar): implement full agent loop with streaming input and canUseTool"
```

---

### Task 3: Rust SidecarManager

**Files:**
- Create: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/lib.rs`（添加 SidecarManager state）

**Interfaces:**
- Produces:
  - `SidecarManager` struct（注册为 Tauri managed state）
  - `SidecarManager::spawn(session_id, cwd, env_vars, emit_fn)` → `Result<(), String>`
  - `SidecarManager::send(session_id, cmd: SidecarCommand)` → `Result<(), String>`
  - `SidecarManager::kill(session_id)` → `Result<(), String>`

- [ ] **Step 1: 创建 sidecar.rs**

`src-tauri/src/sidecar.rs`:
```rust
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tauri::{AppHandle, Emitter};
use serde_json::Value;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ChatEventPayload {
    pub session_id: String,
    #[serde(flatten)]
    pub event: Value,
}

struct SidecarSession {
    stdin: ChildStdin,
    child: Child,
}

pub struct SidecarManager {
    sessions: Mutex<HashMap<String, SidecarSession>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }

    pub fn spawn(
        &self,
        session_id: String,
        cwd: PathBuf,
        api_key: String,
        base_url: Option<String>,
        model: Option<String>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let sidecar_js = Self::resolve_sidecar_path()?;
        let node_bin = std::env::var("AIDE_NODE_PATH").unwrap_or_else(|_| "node".to_string());

        let mut cmd = tokio::process::Command::new(&node_bin);
        cmd.arg(&sidecar_js)
            .current_dir(&cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .env("ANTHROPIC_API_KEY", &api_key);

        if let Some(url) = &base_url {
            cmd.env("ANTHROPIC_BASE_URL", url);
        }
        if let Some(m) = &model {
            cmd.env("ANTHROPIC_MODEL", m);
        }

        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = child.stdout.take().ok_or("No stdout")?;

        // Spawn reader task
        let sid = session_id.clone();
        let app = app_handle.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Ok(mut event) = serde_json::from_str::<Value>(&line) {
                    if let Some(obj) = event.as_object_mut() {
                        obj.insert("session_id".to_string(), Value::String(sid.clone()));
                    }
                    let _ = app.emit("chat-event", event);
                }
            }
        });

        self.sessions.lock().unwrap().insert(session_id, SidecarSession { stdin, child });
        Ok(())
    }

    pub fn send(&self, session_id: &str, cmd: &Value) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(session_id).ok_or("Session not found")?;
        let line = serde_json::to_string(cmd).map_err(|e| e.to_string())? + "\n";
        let bytes = line.into_bytes();
        // Use blocking write for simplicity; in async context use spawn_blocking
        use std::io::Write;
        let stdin_fd = session.stdin.as_mut_fd();
        // Write via tokio runtime
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async {
            session.stdin.write_all(&bytes).await
        }).map_err(|e| e.to_string())
    }

    pub fn kill(&self, session_id: &str) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(session_id) {
            let _ = s.child.start_kill();
        }
    }

    fn resolve_sidecar_path() -> Result<PathBuf, String> {
        #[cfg(debug_assertions)]
        {
            // dev: use source path relative to Cargo.toml
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let path = manifest.parent().unwrap().join("agent-sidecar/dist/sidecar.js");
            if path.exists() {
                return Ok(path);
            }
            return Err(format!("Sidecar not found at {:?}. Run: cd agent-sidecar && npm run build", path));
        }
        #[cfg(not(debug_assertions))]
        {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            Ok(exe.parent().unwrap().join("agent-sidecar.js"))
        }
    }
}
```

> Note: `send` 方法需要在 async context 中调用。Tauri commands 是 async 的，所以可以直接 `.await`。将 `send` 改为 async：

**修正 send 为 async（替换上面的 send 方法）：**

```rust
pub async fn send(&self, session_id: &str, cmd: &Value) -> Result<(), String> {
    let mut sessions = self.sessions.lock().unwrap();
    let session = sessions.get_mut(session_id).ok_or("Session not found")?;
    let mut line = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
    line.push('\n');
    session.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 2: 在 lib.rs 中添加 SidecarManager mod 和 state**

在 `src-tauri/src/lib.rs` 顶部添加：
```rust
mod sidecar;
```

在 `tauri::Builder::default()` 的 `.manage()` 链中添加：
```rust
.manage(sidecar::SidecarManager::new())
```

- [ ] **Step 3: 在 Cargo.toml 中确认依赖**

`src-tauri/Cargo.toml` 确保有：
```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
serde_json = "1"
serde = { version = "1", features = ["derive"] }
tauri = { version = "2", features = ["...", "unstable"] }
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri
cargo check
```

预期：无编译错误

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/lib.rs
git commit -m "feat(sidecar): add SidecarManager Rust bridge"
```

---

### Task 4: Rust chat commands

**Files:**
- Create: `src-tauri/src/commands/chat.rs`
- Modify: `src-tauri/src/commands/mod.rs`（添加 `pub mod chat`）
- Modify: `src-tauri/src/lib.rs`（注册 chat commands）

**Interfaces:**
- Consumes: `SidecarManager`（Task 3）、`WorkspaceState`、provider config（`get_active_provider`）
- Produces:
  - `start_chat_session(session_id, resume_id?) → Result<(), String>`
  - `send_message(session_id, prompt) → Result<(), String>`
  - `permission_response(session_id, id, approved) → Result<(), String>`
  - `interrupt_session(session_id) → Result<(), String>`

- [ ] **Step 1: 创建 commands/chat.rs**

`src-tauri/src/commands/chat.rs`:
```rust
use tauri::State;
use serde_json::json;
use crate::sidecar::SidecarManager;
use crate::commands::{WorkspaceState, project_root_for_commands};
use crate::commands::settings::get_settings_inner;
use crate::commands::provider::get_active_provider_inner;

#[tauri::command]
pub async fn start_chat_session(
    session_id: String,
    resume_id: Option<String>,
    sidecar_mgr: State<'_, SidecarManager>,
    workspace_state: State<'_, WorkspaceState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let cwd = project_root_for_commands(&workspace_state);

    // 获取 provider 配置
    let provider = get_active_provider_inner().unwrap_or_default();
    let api_key = provider.api_key.unwrap_or_default();
    let base_url = provider.base_url;
    let model = provider.model_sonnet; // 或 active model

    sidecar_mgr.spawn(session_id.clone(), cwd, api_key, base_url, model, app_handle)?;

    // 如果是续接，写入 session_id
    if let Some(rid) = resume_id {
        let cmd = json!({ "cmd": "send", "prompt": "", "session_id": rid });
        // 发送一个空消息触发 resume（sidecar 会先设置 session_id 再等待真实消息）
        // 实际上只需要在首次 send 时传 session_id，这里只 spawn 就够了
        drop(cmd); // not needed at spawn time
    }

    Ok(())
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    prompt: String,
    resume_id: Option<String>,
    sidecar_mgr: State<'_, SidecarManager>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let cwd = project_root_for_commands(&workspace_state)
        .to_string_lossy()
        .to_string();
    let mut cmd = json!({
        "cmd": "send",
        "prompt": prompt,
        "cwd": cwd,
    });
    if let Some(rid) = resume_id {
        cmd["session_id"] = json!(rid);
    }
    sidecar_mgr.send(&session_id, &cmd).await
}

#[tauri::command]
pub async fn permission_response(
    session_id: String,
    id: String,
    approved: bool,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "permission_response", "id": id, "approved": approved });
    sidecar_mgr.send(&session_id, &cmd).await
}

#[tauri::command]
pub async fn interrupt_session(
    session_id: String,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    let cmd = json!({ "cmd": "interrupt" });
    sidecar_mgr.send(&session_id, &cmd).await
}

#[tauri::command]
pub async fn stop_chat_session(
    session_id: String,
    sidecar_mgr: State<'_, SidecarManager>,
) -> Result<(), String> {
    sidecar_mgr.kill(&session_id);
    Ok(())
}
```

- [ ] **Step 2: 在 commands/mod.rs 添加 chat 模块**

在 `src-tauri/src/commands/mod.rs` 中添加：
```rust
pub mod chat;
```

- [ ] **Step 3: 在 lib.rs 注册 chat commands**

在 `tauri::generate_handler![]` 中添加：
```rust
chat::start_chat_session,
chat::send_message,
chat::permission_response,
chat::interrupt_session,
chat::stop_chat_session,
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri
cargo check
```

预期：无错误

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/chat.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(chat): add Tauri chat commands bridging to sidecar"
```

---

### Task 5: 前端 useChatSession.ts

**Files:**
- Create: `src/composables/useChatSession.ts`
- Create: `src/types/chat.ts`（Chat UI 类型定义）

**Interfaces:**
- Produces:
  - `useChatSession(sessionId: Ref<string | null>)` composable
  - `messages: ComputedRef<ChatMessage[]>`
  - `isBusy: Ref<boolean>`（对话进行中）
  - `pendingPermission: Ref<PermissionRequest | null>`
  - `sendMessage(prompt: string, resumeId?: string): Promise<void>`
  - `respondPermission(id: string, approved: boolean): Promise<void>`
  - `interrupt(): Promise<void>`

- [ ] **Step 1: 创建 src/types/chat.ts**

`src/types/chat.ts`:
```typescript
export type MessageRole = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  isPending: boolean;
}

export type ContentBlock = TextBlock | ToolCallBlock;

export interface ChatMessage {
  id: string;
  role: MessageRole;
  blocks: ContentBlock[];
  timestamp: number;
}

export interface PermissionRequest {
  id: string;
  name: string;
  input: unknown;
}
```

- [ ] **Step 2: 创建 useChatSession.ts**

`src/composables/useChatSession.ts`:
```typescript
import { ref, computed, type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, ContentBlock, PermissionRequest, ToolCallBlock } from "@/types/chat";

export function useChatSession(sessionId: Ref<string | null>) {
  const messages = ref<ChatMessage[]>([]);
  const isBusy = ref(false);
  const pendingPermission = ref<PermissionRequest | null>(null);
  let unlisten: (() => void) | null = null;

  // 当前正在构建的 assistant 消息
  let currentAssistantMsg: ChatMessage | null = null;

  function getOrCreateAssistant(): ChatMessage {
    if (!currentAssistantMsg || messages.value[messages.value.length - 1] !== currentAssistantMsg) {
      currentAssistantMsg = {
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [],
        timestamp: Date.now(),
      };
      messages.value.push(currentAssistantMsg);
    }
    return currentAssistantMsg;
  }

  async function setupListener(sid: string) {
    if (unlisten) { unlisten(); unlisten = null; }

    unlisten = await listen<Record<string, unknown>>("chat-event", (event) => {
      const e = event.payload;
      if (e["session_id"] !== sid) return;

      switch (e["type"]) {
        case "text_delta": {
          const msg = getOrCreateAssistant();
          const last = msg.blocks[msg.blocks.length - 1];
          if (last?.type === "text") {
            last.text += e["delta"] as string;
          } else {
            msg.blocks.push({ type: "text", text: e["delta"] as string });
          }
          break;
        }
        case "tool_use_start": {
          const msg = getOrCreateAssistant();
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
          const msg = getOrCreateAssistant();
          const block = msg.blocks.find(
            (b): b is ToolCallBlock => b.type === "tool_call" && b.id === e["id"]
          );
          if (block) {
            block.result = e["content"] as string;
            block.isError = e["is_error"] as boolean;
            block.isPending = false;
          }
          break;
        }
        case "permission_request": {
          pendingPermission.value = {
            id: e["id"] as string,
            name: e["name"] as string,
            input: e["input"],
          };
          break;
        }
        case "message_stop": {
          currentAssistantMsg = null;
          isBusy.value = false;
          break;
        }
        case "error": {
          currentAssistantMsg = null;
          isBusy.value = false;
          messages.value.push({
            id: crypto.randomUUID(),
            role: "assistant",
            blocks: [{ type: "text", text: `Error: ${e["message"]}` }],
            timestamp: Date.now(),
          });
          break;
        }
      }
    });
  }

  async function sendMessage(prompt: string, resumeId?: string) {
    const sid = sessionId.value;
    if (!sid) return;

    isBusy.value = true;
    messages.value.push({
      id: crypto.randomUUID(),
      role: "user",
      blocks: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    });

    await setupListener(sid);
    await invoke("send_message", { sessionId: sid, prompt, resumeId });
  }

  async function respondPermission(id: string, approved: boolean) {
    const sid = sessionId.value;
    if (!sid) return;
    pendingPermission.value = null;
    await invoke("permission_response", { sessionId: sid, id, approved });
  }

  async function interrupt() {
    const sid = sessionId.value;
    if (!sid) return;
    isBusy.value = false;
    await invoke("interrupt_session", { sessionId: sid });
  }

  function reset() {
    messages.value = [];
    isBusy.value = false;
    pendingPermission.value = null;
    currentAssistantMsg = null;
  }

  return { messages: computed(() => messages.value), isBusy, pendingPermission, sendMessage, respondPermission, interrupt, reset };
}
```

- [ ] **Step 3: 添加 src/types/chat.ts 到 src/types/index.ts（若存在则 export，否则跳过）**

检查是否有 `src/types/index.ts`，有则添加：
```typescript
export * from "./chat";
```

- [ ] **Step 4: 编译检查**

```bash
pnpm run build 2>&1 | head -30
```

预期：仅缺少组件的错误（组件在后续 Task 中创建），无 TS 类型错误

- [ ] **Step 5: Commit**

```bash
git add src/composables/useChatSession.ts src/types/chat.ts
git commit -m "feat(chat): add useChatSession composable with Tauri event handling"
```

---

### Task 6: ChatPanel.vue + ChatMessage.vue

**Files:**
- Create: `src/components/ChatPanel.vue`
- Create: `src/components/ChatMessage.vue`

**Interfaces:**
- Consumes: `useChatSession`（Task 5），`ChatMessage`、`ContentBlock` 类型
- Produces: 完整消息列表渲染，含自动滚动

- [ ] **Step 1: 创建 ChatMessage.vue**

`src/components/ChatMessage.vue`:
```vue
<script setup lang="ts">
import { computed } from "vue";
import type { ChatMessage } from "@/types/chat";
import { marked } from "marked";
import { escapeHtml } from "@/utils/markdown";

const props = defineProps<{ message: ChatMessage }>();

const isUser = computed(() => props.message.role === "user");
</script>

<template>
  <div :class="['flex gap-2 px-4 py-2', isUser ? 'justify-end' : 'justify-start']">
    <div
      :class="[
        'max-w-[85%] rounded-lg px-3 py-2 text-sm',
        isUser
          ? 'bg-blue-600 text-white'
          : 'bg-surface-1 text-text-primary',
      ]"
    >
      <template v-for="block in message.blocks" :key="block.type + (block.type === 'tool_call' ? block.id : '')">
        <!-- 文本块：Markdown 渲染 -->
        <div
          v-if="block.type === 'text'"
          class="prose prose-sm prose-invert max-w-none"
          v-html="marked.parse(block.text)"
        />
        <!-- 工具调用块（在 Task 7 中替换为 ToolCallBlock 组件） -->
        <div
          v-else-if="block.type === 'tool_call'"
          class="mt-1 rounded bg-surface-2 px-2 py-1 font-mono text-xs text-text-muted"
        >
          {{ block.isPending ? "⏳" : block.isError ? "❌" : "✅" }}
          {{ block.name }}
        </div>
      </template>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 创建 ChatPanel.vue**

`src/components/ChatPanel.vue`:
```vue
<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import type { Ref } from "vue";
import ChatMessage from "./ChatMessage.vue";
import { useChatSession } from "@/composables/useChatSession";

const props = defineProps<{
  sessionId: string | null;
  resumeId?: string;
}>();

const emit = defineEmits<{ sessionStarted: [id: string] }>();

const sessionIdRef = ref(props.sessionId) as Ref<string | null>;
watch(() => props.sessionId, (v) => { sessionIdRef.value = v; });

const { messages, isBusy, pendingPermission, sendMessage, interrupt } = useChatSession(sessionIdRef);

const inputText = ref("");
const scrollEl = ref<HTMLDivElement>();

watch(messages, () => {
  nextTick(() => {
    if (scrollEl.value) {
      scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
    }
  });
}, { deep: true });

async function handleSend() {
  const text = inputText.value.trim();
  if (!text || isBusy.value || !props.sessionId) return;
  inputText.value = "";
  await sendMessage(text, props.resumeId);
}
</script>

<template>
  <div class="flex h-full flex-col bg-base">
    <!-- 消息列表 -->
    <div ref="scrollEl" class="flex-1 overflow-y-auto py-2">
      <div v-if="messages.length === 0" class="flex h-full items-center justify-center text-text-muted text-sm">
        开始新对话
      </div>
      <ChatMessage
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
      />
      <!-- 思考中指示器 -->
      <div v-if="isBusy" class="flex items-center gap-2 px-4 py-2 text-text-muted text-xs">
        <span class="animate-pulse">●</span> Claude 正在思考…
        <button class="ml-2 text-red-400 hover:text-red-300" @click="interrupt">中断</button>
      </div>
    </div>

    <!-- 输入框 -->
    <div class="border-t border-border px-3 py-2">
      <div class="flex gap-2">
        <textarea
          v-model="inputText"
          class="flex-1 resize-none rounded bg-surface-1 px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted"
          placeholder="输入消息…"
          rows="3"
          :disabled="isBusy || !sessionId"
          @keydown.enter.exact.prevent="handleSend"
          @keydown.enter.shift.exact.prevent="inputText += '\n'"
        />
        <button
          class="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50 hover:bg-blue-500"
          :disabled="isBusy || !sessionId || !inputText.trim()"
          @click="handleSend"
        >
          发送
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: 编译检查**

```bash
pnpm run build 2>&1 | grep -E "error|Error" | head -20
```

预期：无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/components/ChatPanel.vue src/components/ChatMessage.vue
git commit -m "feat(chat): add ChatPanel and ChatMessage components"
```

---

### Task 7: ToolCallBlock.vue + BashOutputBlock.vue + PermissionDialog.vue

**Files:**
- Create: `src/components/ToolCallBlock.vue`
- Create: `src/components/BashOutputBlock.vue`
- Modify: `src/components/ChatMessage.vue`（使用 ToolCallBlock）
- Create: `src/components/PermissionDialog.vue`

**Interfaces:**
- Consumes: `ToolCallBlock` 类型、`pendingPermission`（来自 useChatSession）
- Produces: 完整工具调用渲染 + 权限确认对话框

- [ ] **Step 1: 创建 ToolCallBlock.vue**

`src/components/ToolCallBlock.vue`:
```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import type { ToolCallBlock } from "@/types/chat";
import BashOutputBlock from "./BashOutputBlock.vue";

const props = defineProps<{ block: ToolCallBlock }>();
const expanded = ref(false);

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});

const isBash = computed(() => props.block.name === "Bash");
const inputSummary = computed(() => {
  const input = props.block.input as Record<string, unknown>;
  if (props.block.name === "Bash") return input?.command ?? "";
  if (props.block.name === "Read" || props.block.name === "Write" || props.block.name === "Edit")
    return input?.file_path ?? "";
  return JSON.stringify(input).slice(0, 60);
});
</script>

<template>
  <div class="my-1 rounded border border-border bg-surface-2 text-xs">
    <!-- 标题栏（可点击折叠） -->
    <button
      class="flex w-full items-center gap-2 px-2 py-1 text-left text-text-muted hover:text-text-primary"
      @click="expanded = !expanded"
    >
      <span>{{ statusIcon }}</span>
      <span class="font-semibold text-text-secondary">{{ block.name }}</span>
      <span class="flex-1 truncate font-mono text-text-muted">{{ inputSummary }}</span>
      <span>{{ expanded ? "▲" : "▼" }}</span>
    </button>
    <!-- 展开内容 -->
    <div v-if="expanded" class="border-t border-border px-2 py-1">
      <!-- Bash 输出用 xterm -->
      <BashOutputBlock v-if="isBash && block.result" :content="block.result" :is-error="block.isError ?? false" />
      <!-- 其他工具：纯文本 -->
      <pre v-else-if="block.result" class="max-h-40 overflow-auto whitespace-pre-wrap text-text-secondary">{{ block.result }}</pre>
      <pre v-else class="text-text-muted italic">等待结果…</pre>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 创建 BashOutputBlock.vue（内嵌 xterm）**

`src/components/BashOutputBlock.vue`:
```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const props = defineProps<{ content: string; isError: boolean }>();
const containerRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;

onMounted(() => {
  if (!containerRef.value) return;
  terminal = new Terminal({
    rows: 10,
    cols: 80,
    theme: { background: "#1e1e2e", foreground: "#cdd6f4" },
    scrollback: 1000,
    disableStdin: true,
    fontSize: 12,
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(containerRef.value);
  fitAddon.fit();
  terminal.write(props.content.replace(/\n/g, "\r\n"));
});

onBeforeUnmount(() => {
  terminal?.dispose();
});

watch(() => props.content, (val) => {
  terminal?.clear();
  terminal?.write(val.replace(/\n/g, "\r\n"));
});
</script>

<template>
  <div ref="containerRef" class="h-40 w-full rounded" />
</template>

<style>
/* 非 scoped：xterm 动态 DOM 需要全局样式 */
.xterm { height: 100% !important; }
.xterm-viewport { overflow-y: auto !important; }
</style>
```

- [ ] **Step 3: 更新 ChatMessage.vue 使用 ToolCallBlock**

在 `src/components/ChatMessage.vue` 中：

```diff
+ import ToolCallBlock from "./ToolCallBlock.vue";
```

将模板中的工具调用部分替换为：
```vue
<ToolCallBlock
  v-else-if="block.type === 'tool_call'"
  :block="block"
/>
```

- [ ] **Step 4: 创建 PermissionDialog.vue**

`src/components/PermissionDialog.vue`:
```vue
<script setup lang="ts">
import { computed } from "vue";
import type { PermissionRequest } from "@/types/chat";

const props = defineProps<{
  permission: PermissionRequest | null;
}>();

const emit = defineEmits<{
  respond: [id: string, approved: boolean];
}>();

const inputSummary = computed(() => {
  if (!props.permission) return "";
  const input = props.permission.input as Record<string, unknown>;
  if (props.permission.name === "Bash") return `命令：${input?.command ?? ""}`;
  if (["Write", "Edit"].includes(props.permission.name)) return `文件：${input?.file_path ?? ""}`;
  if (props.permission.name === "WebFetch") return `URL：${input?.url ?? ""}`;
  return JSON.stringify(input, null, 2).slice(0, 200);
});

function approve() {
  if (props.permission) emit("respond", props.permission.id, true);
}
function deny() {
  if (props.permission) emit("respond", props.permission.id, false);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="permission"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div class="w-[480px] rounded-lg bg-surface-0 p-5 shadow-xl border border-border">
        <h3 class="mb-1 text-sm font-semibold text-text-primary">
          允许工具调用：<span class="text-blue-400">{{ permission.name }}</span>
        </h3>
        <pre class="mb-4 max-h-32 overflow-auto rounded bg-surface-2 px-3 py-2 text-xs text-text-secondary">{{ inputSummary }}</pre>
        <div class="flex justify-end gap-2">
          <button
            class="rounded px-4 py-1.5 text-sm bg-surface-1 text-text-secondary hover:bg-surface-2"
            @click="deny"
          >
            拒绝
          </button>
          <button
            class="rounded px-4 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-500"
            @click="approve"
          >
            允许
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 5: 编译检查**

```bash
pnpm run build 2>&1 | grep -E "error TS" | head -20
```

预期：无 TS 错误

- [ ] **Step 6: Commit**

```bash
git add src/components/ToolCallBlock.vue src/components/BashOutputBlock.vue \
        src/components/PermissionDialog.vue src/components/ChatMessage.vue
git commit -m "feat(chat): add ToolCallBlock, BashOutputBlock, PermissionDialog components"
```

---

### Task 8: App.vue 集成 + 端到端联调

**Files:**
- Modify: `src/App.vue`（引入 ChatPanel，替换 TerminalPanel，接入 PermissionDialog）
- Modify: `src/api.ts`（添加 chat 相关 invoke 函数）

**Interfaces:**
- Consumes: 所有前序 Task 产出

- [ ] **Step 1: 在 src/api.ts 添加 chat API 函数**

在 `src/api.ts` 末尾追加：
```typescript
// Chat (Agent SDK)
export const startChatSession = (sessionId: string, resumeId?: string) =>
  invoke<void>("start_chat_session", { sessionId, resumeId });

export const sendChatMessage = (sessionId: string, prompt: string, resumeId?: string) =>
  invoke<void>("send_message", { sessionId, prompt, resumeId });

export const permissionResponse = (sessionId: string, id: string, approved: boolean) =>
  invoke<void>("permission_response", { sessionId, id, approved });

export const interruptSession = (sessionId: string) =>
  invoke<void>("interrupt_session", { sessionId });

export const stopChatSession = (sessionId: string) =>
  invoke<void>("stop_chat_session", { sessionId });
```

- [ ] **Step 2: 在 App.vue 中引入 ChatPanel 和 PermissionDialog**

在 `src/App.vue` 的 `<script setup>` 中：

```typescript
import ChatPanel from "./components/ChatPanel.vue";
import PermissionDialog from "./components/PermissionDialog.vue";
import { useChatSession } from "./composables/useChatSession";
```

注：`currentSid`（当前选中会话 ID）已有相关 ref，接入 `useChatSession`：
```typescript
const { pendingPermission, respondPermission } = useChatSession(currentSid);
```

- [ ] **Step 3: 在 App.vue 模板中替换 TerminalPanel**

找到模板中 `<TerminalPanel` 的位置，替换为：
```vue
<ChatPanel
  :session-id="currentSid"
  class="flex-1 min-h-0"
/>
```

在模板末尾（`</div>` 前）添加：
```vue
<PermissionDialog
  :permission="pendingPermission"
  @respond="respondPermission"
/>
```

- [ ] **Step 4: 启动开发服务器手动测试**

```bash
# 终端 1：构建 sidecar
cd agent-sidecar && npm run build

# 终端 2：启动 Tauri dev
pnpm tauri dev
```

测试步骤：
1. 打开 Aide，选择一个项目
2. 点击侧栏"新建会话"
3. 在 ChatPanel 输入框输入 `list files here`，按 Enter
4. 验证：消息出现在 Chat UI，Claude 回复出现（有 text_delta）
5. 验证：对话结束后 isBusy 变为 false（不再显示"思考中"）
6. 输入需要 Bash 权限的指令：`run ls -la`，验证 PermissionDialog 弹出

- [ ] **Step 5: Commit**

```bash
git add src/App.vue src/api.ts
git commit -m "feat(app): integrate ChatPanel into App.vue, replace TerminalPanel"
```

---

### Task 9: JSONL 持久化 + 会话续接

**Files:**
- Create: `src-tauri/src/conversation.rs`
- Modify: `src-tauri/src/commands/chat.rs`（在 session_init 时开始记录）
- Modify: `src-tauri/src/sidecar.rs`（路由 session_init 事件到 conversation.rs）

**Interfaces:**
- Consumes: `ChatEvent` 流（来自 sidecar）
- Produces: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` 文件，`load_messages` 可读取

- [ ] **Step 1: 创建 conversation.rs**

`src-tauri/src/conversation.rs`:
```rust
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use serde_json::{json, Value};
use chrono::Utc;

pub struct ConversationWriter {
    path: PathBuf,
}

impl ConversationWriter {
    pub fn new(cwd_encoded: &str, session_id: &str) -> std::io::Result<Self> {
        let dir = dirs::home_dir()
            .unwrap()
            .join(".claude")
            .join("projects")
            .join(cwd_encoded);
        fs::create_dir_all(&dir)?;
        Ok(Self { path: dir.join(format!("{session_id}.jsonl")) })
    }

    /// 写一条 JSONL 记录（兼容 Claude CLI 格式）
    pub fn append(&self, record: &Value) -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        let line = serde_json::to_string(record).unwrap();
        writeln!(file, "{line}")
    }

    pub fn append_user_message(&self, content: &str) -> std::io::Result<()> {
        self.append(&json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "timestamp": Utc::now().to_rfc3339(),
        }))
    }

    pub fn append_assistant_message(&self, content: &str, cost_usd: Option<f64>) -> std::io::Result<()> {
        self.append(&json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": content }] },
            "timestamp": Utc::now().to_rfc3339(),
            "costUSD": cost_usd,
        }))
    }
}
```

在 `Cargo.toml` 添加：
```toml
dirs = "5"
chrono = { version = "0.4", features = ["serde"] }
```

- [ ] **Step 2: 在 sidecar.rs 的 stdout reader 中路由 session_init**

修改 `sidecar.rs` 中的 reader task，当收到 `session_init` 时记录 session_id 并建立 writer：

```rust
// 在 spawn() 方法的 reader task 中，在 emit 之前：
if let Some("session_init") = event.get("type").and_then(|t| t.as_str()) {
    if let Some(sid) = event.get("session_id").and_then(|s| s.as_str()) {
        // 通知 chat.rs 这个 session 已初始化，可以开始写 JSONL
        // 通过 app.emit 一个内部事件
        let _ = app.emit("sidecar-session-init", json!({
            "sidecar_session": session_id_for_task.clone(),
            "sdk_session_id": sid,
        }));
    }
}
```

- [ ] **Step 3: 验证会话续接**

```bash
pnpm tauri dev
```

1. 新建会话，发送消息，关闭 Aide
2. 重新打开 Aide，选择同一会话
3. 发送消息，验证 Claude 记得上下文

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/conversation.rs src-tauri/src/commands/chat.rs \
        src-tauri/src/sidecar.rs src-tauri/Cargo.toml
git commit -m "feat(conversation): add JSONL persistence compatible with Claude CLI format"
```

---

### Task 10: 清理 PTY 旧代码

**Files:**
- Delete: `src-tauri/src/pty.rs`
- Delete: `src-tauri/src/commands/pty.rs`
- Delete: `src/components/TerminalPanel.vue`
- Delete: `src/composables/useTerminalManager.ts`
- Delete: `src/composables/useSessionMonitor.ts`
- Modify: `src-tauri/src/commands/mod.rs`（移除 `pub mod pty`）
- Modify: `src-tauri/src/lib.rs`（移除 PTY state 和 commands，移除 TerminalPanel 相关导入）
- Modify: `src/App.vue`（清理残余 TerminalPanel 引用）

**Interfaces:**
- Consumes: 所有前序 Task（确保已功能完整再清理）

- [ ] **Step 1: 确认 PTY 相关 Tauri commands 不再被前端调用**

```bash
grep -r "ptySpawn\|ptyWrite\|ptyResize\|ptyKill\|pollPtyOutput\|startClaude" src/ --include="*.ts" --include="*.vue"
```

预期：无结果（若有，先修改对应组件）

- [ ] **Step 2: 删除 Rust PTY 文件**

```bash
rm src-tauri/src/pty.rs
rm src-tauri/src/commands/pty.rs
```

- [ ] **Step 3: 从 lib.rs 移除 PTY 引用**

在 `src-tauri/src/lib.rs` 中：
- 删除 `mod pty;`
- 删除 `.manage(PtyManager::new())`（或对应 state）
- 从 `generate_handler![]` 移除所有 `pty::` 开头的 commands

- [ ] **Step 4: 从 commands/mod.rs 移除 PTY 模块**

删除：
```rust
pub mod pty;
```

- [ ] **Step 5: 删除前端 PTY 相关文件**

```bash
rm src/components/TerminalPanel.vue
rm src/composables/useTerminalManager.ts
rm src/composables/useSessionMonitor.ts
```

- [ ] **Step 6: 检查残余引用**

```bash
grep -r "TerminalPanel\|useTerminalManager\|useSessionMonitor\|PtyManager\|ptyToDisplay\|liveSessions" \
  src/ src-tauri/src/ --include="*.ts" --include="*.vue" --include="*.rs"
```

逐个修复所有剩余引用。

- [ ] **Step 7: 完整编译验证**

```bash
cargo check --manifest-path src-tauri/Cargo.toml && pnpm run build
```

预期：0 错误

- [ ] **Step 8: 端到端回归测试**

启动 `pnpm tauri dev`，验证：
- [ ] 新建会话、发送消息、收到 Claude 回复
- [ ] 工具调用（`read src/App.vue`）可见 ToolCallBlock
- [ ] 需要权限的 Bash 命令弹出 PermissionDialog，允许/拒绝均正常
- [ ] 续接历史会话，Claude 记得上下文
- [ ] 点击"中断"停止正在运行的对话
- [ ] Skills（`/brainstorming` 等）可被 Claude 调用

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(cleanup): remove PTY/CLI code, complete Agent SDK migration"
```

---

## 自查

### Spec 覆盖验证

| Spec 要求 | 覆盖 Task |
|-----------|----------|
| 完全替换 PTY/CLI | Task 10 |
| Node.js sidecar + Agent SDK | Task 1-2 |
| Rust sidecar bridge | Task 3-4 |
| Chat UI（气泡流）| Task 6 |
| bash 输出内嵌 xterm | Task 7 |
| 权限确认弹窗 | Task 7 |
| canUseTool 回调 | Task 2 |
| 流式输入模式 AsyncGenerator | Task 2 |
| JSONL 持久化（兼容 CLI 格式）| Task 9 |
| 会话续接 | Task 9 |
| Skills/Plugins 支持 | Task 2（`settingSources + skills:"all"`）|
| 多厂商扩展点保留 | Task 3-4（SidecarManager 接口独立）|
| Windows CREATE_NO_WINDOW | Task 3 |

### 已知待验证项

- [ ] `@anthropic-ai/claude-agent-sdk` esbuild bundle 是否需要特殊处理 native Claude Code binary（Task 2 Step 6 验证）
- [ ] `/plugin install` 在 SDK sidecar 环境下的兼容性（后续单独调研，不阻塞本次迁移）
