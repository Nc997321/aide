# 图片输入能力防护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动阻止不支持视觉输入的模型通过 `Read` 或粘贴附件把真实图片写入 Agent SDK 会话，并使后续文本对话保持可用。

**Architecture:** `agent-sidecar` 维护按连接身份和模型分区的运行期图片能力缓存，并用不持久化的内置 1×1 PNG 探测未知能力。`Read` 许可链在工具执行前拦截图片路径；前端在清空输入前经 Rust/Runtime 预检粘贴图片。Rust 只转发通用的探测请求与结果，既不解释 Provider，也不接触 Claude SDK 专属的图片块格式。

> **实现修正（2026-07-23，Task 1 Step 5 落地后补）：** 计划原本让 `probeImageInput` 只在 `for await` 里分类 `type:"result"` 消息。实测 glm-5.2 会话 JSONL 发现：CLI 把 `400 this model does not support image input` 包成 `model:"<synthetic>"` 的合成 `assistant` 文本消息（其后无 `result`），或让 CLI 非零退出、SDK 抛异常。两条路径都被原 `catch { return null }` 吞成 `unknown`，守卫全放行，400 仍冒到用户。修正：新增 `extractMessageText`，在循环里对合成 `assistant` 消息、在 `catch` 里对异常文本用 `IMAGE_UNSUPPORTED_400` 匹配，命中返回 `false`。详见规格「隔离探测」实现修正段与 `imageInputCapability.ts`。Task 6 的端到端验收步骤需重启 Aide 后由用户手动执行并勾选。

**Tech Stack:** TypeScript、Vue 3 Composition API、Vitest、Rust/Tauri v2、Claude Agent SDK。

## Global Constraints

- 不读取或上传用户本地图片文件来进行能力判断；探测只使用 sidecar 内置的极小 base64 PNG。
- 所有新配色/间距/圆角均使用既有 `--aide-*` token；即时反馈使用 `useToast`，不使用浏览器原生 UI。
- Rust 与 Vue 层只携带通用的图片输入能力语义，Claude SDK `query()`、视觉块和 HTTP 错误分类只能在 `agent-sidecar/`。
- `Read` 文本路径、原有 `PermissionManager` 流程、支持视觉的模型和现有图片预览必须保持行为不变。
- 只把精确命中 `this model does not support image input` 的 HTTP 400 缓存为不支持；认证、网络、429、其他 4xx/5xx 保持未知并不缓存。
- 能力缓存只存活于 persistent Agent Runtime 进程，不写 Provider 配置或会话 JSONL；缓存键使用 endpoint、模型和凭据的不可逆 SHA-256 摘要，绝不存储、输出或记录原始凭据。
- Windows 上新增的任何外部 Rust `Command` 都必须加 `CREATE_NO_WINDOW`；本计划不新增 Rust 外部进程。
- 不自动截断已被旧版本污染的 JSONL；恢复旧会话继续使用已有会话回退或新建会话。
- 未经用户明确要求，不执行 git commit。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `agent-sidecar/src/imageInputCapability.ts` | 纯函数：图片路径识别、缓存键、SDK result 分类、运行期去重缓存和隔离 probe。 |
| `agent-sidecar/src/imageInputCapability.test.ts` | 上述纯逻辑和探测分类的单元测试；只用内置测试 PNG。 |
| `agent-sidecar/src/types.ts` | 扩展 provider-agnostic 的 runtime command/event：预检请求、预检结果、图片输入拒绝事件。 |
| `agent-sidecar/src/session-manager.ts` | Runtime 范围持有共享缓存；处理无会话的预检命令；将缓存注入新建 worker。 |
| `agent-sidecar/src/session-manager.test.ts` | 验证预检命令不创建用户会话、输出带 request ID 的通用结果。 |
| `agent-sidecar/src/session-worker.ts` | `canUseTool` 前置守卫和 `send` 的二次防线；与现有许可管理器组合。 |
| `agent-sidecar/src/session-worker.test.ts` | 模拟不支持/支持/未知能力时，验证 Read 和图片发送不会污染主 query。 |
| `src-tauri/src/runtime/mod.rs` | 将 sidecar 的预检结果匹配到等待中的 Tauri command；其他聊天事件照旧转发。 |
| `src-tauri/src/commands/chat.rs` | 提供 `probe_image_input` async command；构造携带当前 Provider 环境和选定模型的 runtime 命令。 |
| `src-tauri/src/lib.rs` | 注册新的 Tauri command。 |
| `src/api.ts` | 提供 `probeImageInput(model)` 前端 API。 |
| `src/components/ChatPanel.vue` | 在清空文字/待发图片之前预检；不支持时保留输入并显示主题化 Toast。 |
| `src/components/ChatPanel.test.ts` | 验证图片预检不支持时不发送、不清空；支持时透传原始发送行为。 |
| `src/composables/useChatSession.ts` | 消费 sidecar 的二次防线 `image_input_rejected`，在非 UI 调用绕过前端预检时收尾为可恢复状态。 |
| `src/composables/useChatSession.test.ts` | 验证二次拒绝不会留下 running/busy，下一条文本消息可以派发。 |

## Wire Contracts

`agent-sidecar/src/types.ts` 与 `src/types/chat.ts` 的核心事件新增：

```ts
// 只由 sidecar → Rust 内部等待表消费，不转发到 Vue。
{ type: "image_input_probe_result"; request_id: string; supported: boolean | null }

// sidecar → Vue：第二道防线拒绝了用户直接发送的图片附件。
{ type: "image_input_rejected"; message: string }
```

`SidecarCommand` 新增：

```ts
{ cmd: "probe_image_input"; request_id: string; model?: string; env: Record<string, string> }
```

`null` 表示探测未能得出结论，而不是“不支持”。Rust command 的返回类型：

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageInputProbeResult {
    supported: Option<bool>, // Some(true) / Some(false) / None(未知)
}
```

---

### Task 1: 建立 sidecar 图片能力模块（纯逻辑与隔离 probe）

**Files:**
- Create: `agent-sidecar/src/imageInputCapability.ts`
- Create: `agent-sidecar/src/imageInputCapability.test.ts`

**Interfaces:**
- Produces: `isImagePath(path: unknown): boolean`
- Produces: `imageCapabilityKey(env: Record<string, string>, model: string): string`
- Produces: `classifyImageInputResult(message: unknown): true | false | null`
- Produces: `ImageInputCapabilityCache.ensure(key, probe): Promise<true | false | null>`
- Produces: `probeImageInput(queryFn, { env, model }): Promise<true | false | null>`

- [ ] **Step 1: 写失败测试，定义图片路径与 SDK result 分类**

```ts
import { describe, expect, it } from "vitest";
import {
  classifyImageInputResult,
  isImagePath,
} from "./imageInputCapability.js";

describe("isImagePath", () => {
  it.each(["shot.png", "PHOTO.JPEG", "diagram.Gif", "asset.webp"])(
    "recognizes %s",
    (path) => expect(isImagePath(path)).toBe(true),
  );

  it.each(["README.md", "src/main.ts", { file_path: "x.png" }, ""])(
    "does not treat %p as an image path",
    (value) => expect(isImagePath(value)).toBe(false),
  );
});

describe("classifyImageInputResult", () => {
  it("recognizes only the explicit unsupported-image 400", () => {
    expect(classifyImageInputResult({
      type: "result", subtype: "error_during_execution", is_error: true,
      api_error_status: 400,
      errors: ["API Error: 400 this model does not support image input"],
    })).toBe(false);
  });

  it.each([
    { type: "result", subtype: "success", is_error: false },
    { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 401, errors: ["Unauthorized"] },
    { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 429, errors: ["rate limited"] },
    { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 400, errors: ["invalid model"] },
  ])("does not misclassify %o", (message) => {
    expect(classifyImageInputResult(message)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm exec vitest run agent-sidecar/src/imageInputCapability.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现路径识别、缓存键和精确错误分类**

创建模块。路径只接受非空字符串，以扩展名集合 `png/jpeg/jpg/gif/webp` 判定；不要通过读取文件头来判定。缓存键必须包含会影响路由的稳定连接字段和模型，但不得把完整密钥写入键或日志：

```ts
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_UNSUPPORTED = /\bthis model does not support image input\b/i;

export function isImagePath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const ext = path.trim().split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase();
  return !!ext && IMAGE_EXTENSIONS.has(ext);
}

import { createHash } from "node:crypto";

export function imageCapabilityKey(env: Record<string, string>, model: string): string {
  const endpoint = env.ANTHROPIC_BASE_URL ?? "";
  const credential = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "";
  const identity = createHash("sha256")
    .update(JSON.stringify([endpoint, credential]))
    .digest("hex");
  return `${identity}\0${model}`;
}

export function classifyImageInputResult(message: any): true | false | null {
  if (message?.type !== "result") return null;
  if (message?.is_error !== true) return true;
  const errors = [
    ...(Array.isArray(message.errors) ? message.errors : []),
    typeof message.result === "string" ? message.result : "",
  ].join("\n");
  return message.api_error_status === 400 && IMAGE_UNSUPPORTED.test(errors) ? false : null;
}
```

- [ ] **Step 4: 为并发去重和隔离 probe 写失败测试**

```ts
import { ImageInputCapabilityCache, probeImageInput } from "./imageInputCapability.js";

it("deduplicates concurrent probes and persists only definitive answers", async () => {
  const cache = new ImageInputCapabilityCache();
  let calls = 0;
  const probe = async () => { calls += 1; return false as const; };
  await Promise.all([cache.ensure("connection\0glm-5.2", probe), cache.ensure("connection\0glm-5.2", probe)]);
  expect(calls).toBe(1);
  expect(await cache.ensure("connection\0glm-5.2", async () => true)).toBe(false);

  const unknown = new ImageInputCapabilityCache();
  expect(await unknown.ensure("k", async () => null)).toBeNull();
  expect(await unknown.ensure("k", async () => true)).toBe(true);
});

it("probes with an ephemeral image-only query and never resumes a session", async () => {
  const calls: any[] = [];
  const queryFn = (request: any) => {
    calls.push(request);
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false };
    })();
  };
  await expect(probeImageInput(queryFn as any, { env: { ANTHROPIC_BASE_URL: "https://gateway" }, model: "vision-model" })).resolves.toBe(true);
  expect(calls[0].options).toMatchObject({ model: "vision-model", persistSession: false, tools: [] });
  expect(calls[0].options).not.toHaveProperty("resume");
});
```

- [ ] **Step 5: 实现 `ImageInputCapabilityCache` 和 `probeImageInput`**

使用 `Map<string, true | false>` 存最终状态、`Map<string, Promise<true | false | null>>` 存在途请求。`ensure` 仅在结果非 `null` 时写最终缓存，并在 promise settle 后删除在途项。

`probeImageInput` 必须：

```ts
const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+G0g6VwAAAABJRU5ErkJggg==";

const probe = queryFn({
  prompt: (async function* () {
    yield {
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PROBE_PNG_BASE64 },
        }, { type: "text", text: "Reply with OK." }],
      },
      parent_tool_use_id: null,
    };
  })(),
  options: {
    persistSession: false,
    tools: [],
    allowedTools: [],
    model,
    env,
  },
});
```

遍历所有 SDK 消息：任何成功 `result` 返回 `true`；`classifyImageInputResult` 返回 `false` 时立刻返回 `false`；正常结束、抛异常或未分类错误返回 `null`。探测不得使用 `buildUserMessage()`，避免将测试输入耦合到真实会话消息构建。

- [ ] **Step 6: 运行模块测试**

Run: `pnpm exec vitest run agent-sidecar/src/imageInputCapability.test.ts`

Expected: PASS。

---

### Task 2: 在 Runtime 协议中提供共享预检缓存

**Files:**
- Modify: `agent-sidecar/src/types.ts`
- Modify: `agent-sidecar/src/session-manager.ts`
- Modify: `agent-sidecar/src/session-manager.test.ts`

**Interfaces:**
- Consumes: `ImageInputCapabilityCache`、`imageCapabilityKey`、`probeImageInput`。
- Produces: `SessionManager.imageCapabilityCache`，由所有 `SessionWorker` 和 `probe_image_input` command 共享。
- Produces: stdout `{ type: "image_input_probe_result", request_id, supported }`，其中 `supported: null` 表示未知。

- [ ] **Step 1: 扩展 sidecar 的 provider-agnostic command/event 联合类型**

在 `SidecarCommand` 增加：

```ts
| {
    cmd: "probe_image_input";
    request_id: string;
    model?: string;
    env: Record<string, string>;
  }
```

在 `ChatEvent` 增加：

```ts
| { type: "image_input_probe_result"; request_id: string; supported: boolean | null }
| { type: "image_input_rejected"; message: string }
```

注释须明确：前者是 Rust command 应答，不转发为 UI 消息；后者是用户消息二次防线，`message` 不含厂商专属字段。

- [ ] **Step 2: 为 manager 的预检路由写失败测试**

在 `session-manager.test.ts` 注入可替换 probe 函数或通过公开测试构造器创建 manager。测试命令不得走真实 SDK：

```ts
it("answers image capability probes without creating a session worker", async () => {
  const output: any[] = [];
  const manager = new SessionManager({
    emit: (event) => output.push(event),
    probeImageInput: async () => false,
  } as any);

  manager.handleCommand({
    cmd: "probe_image_input", request_id: "p-1", model: "glm-5.2",
    env: { ANTHROPIC_BASE_URL: "https://gateway" },
  });
  await Promise.resolve();

  expect(manager.getAllWorkers().size).toBe(0);
  expect(output).toContainEqual({
    type: "image_input_probe_result", request_id: "p-1", supported: false,
  });
});
```

- [ ] **Step 3: 运行 manager 测试，确认失败**

Run: `pnpm exec vitest run agent-sidecar/src/session-manager.test.ts`

Expected: FAIL，command/event/constructor seam 尚不存在。

- [ ] **Step 4: 在 manager 中实现共享缓存、预检 command 和 worker 注入**

- `SessionManager` 创建一个 `ImageInputCapabilityCache`。
- `cmd === "probe_image_input"` 在 `getOrCreate()` 之前处理：计算 `imageCapabilityKey(cmd.env, cmd.model ?? cmd.env.ANTHROPIC_MODEL ?? "")`，调用共享 `cache.ensure(key, () => probeImageInput(query, { env: cmd.env, model }))`。
- 将 `image_input_probe_result` 直接写 stdout，`session_id` 使用 `_runtime`，使 Rust 的运行期 reader 可以识别但不会改动任何真实会话状态。
- 新 worker 构造参数增加 `imageCapabilityCache`；不要给 worker 创建每会话缓存。
- probe 的错误必须 catch 并返回 `supported: null`，以免一个 Provider 探测异常导致 Runtime stdin loop 退出。

- [ ] **Step 5: 运行 manager 测试**

Run: `pnpm exec vitest run agent-sidecar/src/session-manager.test.ts`

Expected: PASS。

---

### Task 3: 在 `SessionWorker` 的 `Read` 与图片发送路径加防线

**Files:**
- Modify: `agent-sidecar/src/session-worker.ts`
- Modify: `agent-sidecar/src/session-worker.test.ts`

**Interfaces:**
- Consumes: manager 注入的 `ImageInputCapabilityCache` 与 `imageInputCapabilityKey`。
- Produces: `guardImageInput(images?)` 和包装现有 `PermissionManager.makeCallback()` 的 `canUseTool` callback。
- Emits: `{ type: "image_input_rejected", message }`，且不把含图片的 user message 压入 `MessageQueue`。

- [ ] **Step 1: 写失败测试，锁定不支持模型时图片 Read 的行为**

在 `session-worker.test.ts` 为 worker 构造器提供假的 capability cache 和假的 `queryFn`。测试通过 worker 暴露的测试 seam 调用其 canUseTool callback：

```ts
it("denies an image Read before the permission manager or main query sees it", async () => {
  const { worker, events } = makeWorkerWithImageCapability(false);
  const result = await worker._testCanUseTool()("Read", { file_path: "C:/repo/diagram.PNG" }, {});

  expect(result).toMatchObject({ behavior: "deny" });
  expect(result.message).toContain("不支持图片输入");
  expect(events.some((event) => event.type === "permission_request")).toBe(false);
});

it("preserves the existing permission flow for text Read and supported image Read", async () => {
  const text = makeWorkerWithImageCapability(false);
  void text.worker._testCanUseTool()("Read", { file_path: "README.md" }, {});
  expect(text.events[0]?.type).toBe("permission_request");

  const image = makeWorkerWithImageCapability(true);
  void image.worker._testCanUseTool()("Read", { file_path: "diagram.png" }, {});
  expect(image.events[0]?.type).toBe("permission_request");
});
```

- [ ] **Step 2: 写失败测试，锁定图片附件的二次防线**

```ts
it("does not enqueue a direct image attachment when the capability probe rejects it", async () => {
  const { worker, events } = makeWorkerWithImageCapability(false);
  worker.handleCommand({
    cmd: "send", session_id: "s1", prompt: "看看这张图",
    images: [{ data: "not-used", mediaType: "image/png" }], env: {},
  } as any);
  await flushPromises();

  expect(worker._testQueueLength()).toBe(0);
  expect(events).toContainEqual(expect.objectContaining({
    type: "image_input_rejected",
  }));
});
```

- [ ] **Step 3: 运行 worker 测试，确认失败**

Run: `pnpm exec vitest run agent-sidecar/src/session-worker.test.ts`

Expected: FAIL，guard 和测试 seam 尚不存在。

- [ ] **Step 4: 实现能力守卫，复用而非重写权限管理**

添加以下私有方法；`model` 使用 `this.currentModel || this.envOverrides.ANTHROPIC_MODEL || ""`，连接使用 `this.envOverrides`：

```ts
private async imageInputSupported(): Promise<true | false | null> {
  const model = this.currentModel || this.envOverrides.ANTHROPIC_MODEL || "";
  const key = imageCapabilityKey(this.envOverrides, model);
  return this.imageCapabilityCache.ensure(
    key,
    () => probeImageInput(this.queryFn, { env: this.envOverrides, model }),
  );
}

private async guardImagePaths(paths: unknown[]): Promise<boolean> {
  if (!paths.some(isImagePath)) return true;
  return (await this.imageInputSupported()) !== false;
}
```

`canUseTool` 改为包装函数：`toolName === "Read" && isImagePath((input as any)?.file_path)` 时先调用 `imageInputSupported()`；结果为 `false` 时返回：

```ts
{
  behavior: "deny" as const,
  message: "当前模型不支持图片输入，不能读取该图片。请改读 OCR/文本描述、跳过该文件，或切换到支持视觉的模型。",
}
```

其余情况必须调用原有 `this.permMgr.makeCallback(...)` 结果，不能复制 `PermissionManager` 内部 pending、abort 或 always-allow 逻辑。

将 `handleCommand` 的 `send` 分支改为调用异步私有 `handleSend`。在调用 `startLoop()`、`queue.push(buildUserMessage(...))` 前检查 `cmd.images`：若 probe 明确返回 `false`，emit `image_input_rejected` 后 return。`null` 必须继续现有发送路径。对插队请求也在真正写入 `jumpQueueCtl` 前执行相同检查。

- [ ] **Step 5: 运行 worker 测试**

Run: `pnpm exec vitest run agent-sidecar/src/session-worker.test.ts`

Expected: PASS。

- [ ] **Step 6: 运行 sidecar 全量回归**

Run: `pnpm exec vitest run agent-sidecar/src`

Expected: PASS；现有模型切换、权限、mapper、session manager 测试均不回归。

---

### Task 4: 建立 Rust 的异步预检应答桥

**Files:**
- Modify: `src-tauri/src/runtime/mod.rs`
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/commands/chat.rs` 内 `#[cfg(test)]` 模块

**Interfaces:**
- Consumes: sidecar `_runtime` 的 `image_input_probe_result` 事件。
- Produces: `probe_image_input(model: Option<String>, ...) -> Result<ImageInputProbeResult, String>`。
- Produces: Rust → sidecar `{ cmd: "probe_image_input", request_id, model?, env }`。

- [ ] **Step 1: 写 Rust 单元测试，锁定 command JSON 和三态返回值**

在 `commands/chat.rs` 测试模块增加一个纯函数 `build_probe_image_input_command`，先写：

```rust
#[test]
fn probe_image_input_cmd_carries_request_model_and_provider_env() {
    let cmd = build_probe_image_input_command(
        "probe-1",
        Some("glm-5.2".into()),
        &HashMap::from([("ANTHROPIC_BASE_URL".into(), "https://gateway".into())]),
    );
    assert_eq!(cmd["cmd"], "probe_image_input");
    assert_eq!(cmd["request_id"], "probe-1");
    assert_eq!(cmd["model"], "glm-5.2");
    assert_eq!(cmd["env"]["ANTHROPIC_BASE_URL"], "https://gateway");
}
```

- [ ] **Step 2: 运行 Rust 测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml probe_image_input_cmd_carries_request_model_and_provider_env`

Expected: FAIL，构造函数尚不存在。

- [ ] **Step 3: 给 `AgentRuntimeManager` 增加等待表和一次性应答方法**

在 `AgentRuntimeManager` 新增：

```rust
image_probe_waiters: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<bool>>>>,
spawn_lock: TokioMutex<()>,
```

新增幂等的 `ensure_runtime(app_handle, env_vars)` async 方法：先取得 `spawn_lock`，再检查 `stdin` 是否已存在；仅未启动时调用既有 `spawn_runtime`。这样应用启动任务和首次图片预检并发时不会启动两个 Runtime。

实现一个方法：注册 `request_id` 的 sender、向 Runtime stdin 写 command、在 10 秒 `tokio::time::timeout` 内等待，超时/Runtime 写入失败时清理 waiter 并返回 `Ok(None)`。探测未知是正常退化，不能杀 Runtime 或将错误冒泡成聊天会话错误。

在 stdout reader 解析到 `type == "image_input_probe_result"` 时，读取 `request_id` 和 nullable `supported`，从 waiter map 移除并 `send(supported)`；这个内部响应不得 `app.emit("chat-event", ...)`，避免前端把 `_runtime` 当成会话。

- [ ] **Step 4: 在 chat command 中实现并注册 Tauri command**

在 `commands/chat.rs` 定义：

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInputProbeResult {
    pub supported: Option<bool>,
}

#[tauri::command]
pub async fn probe_image_input(
    model: Option<String>,
    app_handle: tauri::AppHandle,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<ImageInputProbeResult, String> {
    let active = active_provider_or_system_default();
    let proxy = get_settings().map(|s| s.proxy).unwrap_or_default();
    let mut env = build_runtime_env_vars(&active, &proxy);
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        env.insert("ANTHROPIC_MODEL".into(), model);
    }
    runtime_mgr.ensure_runtime(app_handle, env.clone()).await?;
    Ok(ImageInputProbeResult {
        supported: runtime_mgr.probe_image_input(env).await?,
    })
}
```

`probe_image_input` 添加到 `src-tauri/src/lib.rs` 的 `invoke_handler!` 列表；并把 setup 中的初始 `spawn_runtime(...)` 调整为 `ensure_runtime(...).await`，与首次预检共享同一启动互斥锁。生成 request ID 使用 Rust `Uuid::new_v4()`；若当前 Cargo feature 没有 uuid，使用已有依赖/模块提供的 UUID 设施，禁止新增仅为该 ID 的新外部进程或网络依赖。

- [ ] **Step 5: 运行 Rust 定向测试与编译检查**

Run: `cargo test --manifest-path src-tauri/Cargo.toml probe_image_input_cmd_carries_request_model_and_provider_env`

Expected: PASS。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS。

---

### Task 5: 前端粘贴预检与二次拒绝状态收尾

**Files:**
- Modify: `src/api.ts`
- Modify: `src/components/ChatPanel.vue`
- Modify: `src/components/ChatPanel.test.ts`
- Modify: `src/composables/useChatSession.ts`
- Modify: `src/composables/useChatSession.test.ts`

**Interfaces:**
- Consumes: `api.probeImageInput(model)` 返回 `{ supported: boolean | null }`。
- Produces: `ChatPanel.handleSend()` 在清空输入前完成预检。
- Consumes: `image_input_rejected` chat event。
- Produces: 前端可恢复 `waiting` 状态，无遗留 busy/queue，并保持下一条纯文本可发。

- [ ] **Step 1: 在 API facade 加失败测试和方法**

在现有 `api` 测试（若无 API facade 测试，则在 `ChatPanel.test.ts` mock 中）先约定：

```ts
probeImageInput(model?: string): Promise<{ supported: boolean | null }> {
  return invoke("probe_image_input", { model: model || null });
},
```

所有现有 `api` mock 加上默认：

```ts
probeImageInput: vi.fn(async () => ({ supported: true })),
```

- [ ] **Step 2: 写 ChatPanel 的失败测试，保证不支持时输入不丢失**

在 `ChatPanel.test.ts`（按现有 mount helper）设置 `api.probeImageInput` 返回 `{ supported: false }`，填入文本并设置一张 `pendingImages` 测试附件后触发发送。断言：

```ts
expect(api.probeImageInput).toHaveBeenCalledWith("glm-5.2");
expect(wrapper.emitted("send")).toBeUndefined();
expect(textarea.element.value).toBe("请分析图片");
expect(wrapper.find(".attached-image-preview").exists()).toBe(true);
expect(toastState.value.message).toContain("不支持图片输入");
```

另加 `{ supported: null }` 和 `{ supported: true }` 两个测试，断言它们保持既有 `send` payload（`images`、`initialModel` 和输入清空）行为。

- [ ] **Step 3: 运行前端组件测试，确认失败**

Run: `pnpm exec vitest run src/components/ChatPanel.test.ts`

Expected: FAIL，API 和发送前预检尚不存在。

- [ ] **Step 4: 在 `ChatPanel.handleSend` 的清空前预检**

仅当 `pendingImages.value.length > 0` 时调用 `await api.probeImageInput(selectedModel.value || undefined)`。调用位置必须在：

- `inputText.value = ""`；
- `pendingImages.value = []`；
- `emit("send", ...)`；

之前。

探测返回 `supported === false` 时：调用组件既有的 `useToast` 实例显示“当前模型不支持图片输入。已保留输入内容和图片附件。”，随后 `return`。不得构造用户气泡、不得解析/发送附件、不得改动 `inputText` 或 `pendingImages`。`true`/`null` 继续原有分支。

- [ ] **Step 5: 消费 sidecar 二次防线事件**

在 `useChatSession.handleChatEvent` 加：

```ts
case "image_input_rejected": {
  resetRuntimeState(store, false);
  store.messages.push({
    id: crypto.randomUUID(),
    role: "assistant",
    blocks: [{ type: "text", text: String(e["message"]) }],
    timestamp: Date.now(),
  });
  setSessionState(sid, "waiting");
  setSessionHealth(sid, "warning");
  break;
}
```

它与普通 `error` 分支分开，因为这是本地防护产生的、没有向模型发出过视觉请求的拒绝。保持 `clearTasks=false`，避免清掉仍可显示的任务快照。

- [ ] **Step 6: 写并运行 useChatSession 回归测试**

追加：

```ts
it("image_input_rejected leaves the session reusable for the next text message", async () => {
  const sid = ref<string | null>("uuid-a");
  const chat = useChatSession(sid);
  await chat.sendMessage("含图片的消息");
  emit({ type: "image_input_rejected", message: "当前模型不支持图片输入", session_id: "uuid-a" });
  await flush();

  expect(chat.isBusy.value).toBe(false);
  expect(useSessionState().state["uuid-a"]).toBe("waiting");
  await chat.sendMessage("只发文本");
  expect(useSessionState().state["uuid-a"]).toBe("running");
});
```

Run: `pnpm exec vitest run src/components/ChatPanel.test.ts src/composables/useChatSession.test.ts`

Expected: PASS。

- [ ] **Step 7: 运行 TypeScript 检查与全量前端测试**

Run: `pnpm build`

Expected: PASS（`vue-tsc --noEmit` 与 Vite build 完成）。

Run: `pnpm test`

Expected: PASS。

---

### Task 6: 端到端验证与文档状态同步

**Files:**
- Modify: `docs/superpowers/specs/2026-07-22-image-input-capability-guard-design.md`
- Modify: `docs/superpowers/plans/2026-07-22-image-input-capability-guard.md`

**Interfaces:**
- Consumes: Tasks 1–5 的可执行构建。
- Produces: 已勾选的计划验证项和已实现规格状态。

- [ ] **Step 1: 构建可分发 sidecar**

Run:

```sh
cd agent-sidecar && pnpm build && pnpm build:exe
```

Expected: `dist/runtime.js` 和 `dist/aide-agent.exe` 均生成成功。不要反复重试网络失败；若依赖缺失且安装失败，按项目代理规则请求用户启动代理。

- [ ] **Step 2: 用 `glm-5.2` 验证工具路径**

在配置了 `glm-5.2` 的 Provider 中，让 Agent 尝试 `Read` 一个图片路径。

Expected：首次显示隔离 probe 后的工具级拒绝文本；聊天中不出现 `API Error: 400 this model does not support image input`；随后发送“继续，请只检查 README”能在同一会话获得正常响应。

- [ ] **Step 3: 验证直接粘贴路径**

选择同一个 `glm-5.2`，粘贴图片并输入一行文本后发送。

Expected：Toast 说明不支持且输入/附件保持不变；消息列表没有新增用户消息；改为删除图片后发送文本可正常开始新一轮。

- [ ] **Step 4: 验证支持视觉的回归路径**

选择已确认支持视觉的模型，粘贴图片并让 Agent `Read` 一张图片文件。

Expected：预检只在该 connection/model 首次发生；图片附件和 `Read` 均照常执行，后续同模型图片操作不再启动额外 probe。

- [ ] **Step 5: 更新计划和规格状态**

将本计划中已执行的验证步骤勾选；将规格文件首部状态从“已确认，待实施”改为“已实现并验证”，并记录验证日期和实际执行的测试命令。不要加入未验证的结果。

---

## Plan Self-Review

- **规格覆盖：** Task 1–3 实现隔离探测、运行期缓存、图片 `Read` 前置阻断和图片发送二次防线；Task 4 提供前端等待的通用 Rust bridge；Task 5 保证粘贴图片不清空输入并处理绕过 UI 的拒绝；Task 6 覆盖 GLM、文本续发、视觉模型和分发 sidecar 验收。
- **非目标：** 没有实现 JSONL 自动截断、模型厂商黑名单或人工能力字段。
- **类型一致性：** `supported: boolean | null` 在 sidecar event、Rust `Option<bool>`、Tauri camelCase JSON 和前端 API 中保持三态一致；`request_id` 只用于 Rust/sidecar 内部关联。
- **占位符检查：** 每个实现步骤均包含具体接口、测试代码和运行命令，没有留空的后续工作说明。
