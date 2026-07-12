# async 子代理可见性修复（option C：sidecar 回放 .output）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 async（后台）子代理能像 sync 子代理一样在 `SubagentCallBlock` 卡片里看到「它正在执行什么工具链 / 跑在哪个模型 / 有没有执行完」——而不是只露一行「派发指令（N 字）▼ Async agent launched successfully. agentId: …」就假装结束了。

**Architecture:** 全部改动落在 **`agent-sidecar/`（Node）**，不改 Rust、不改前端协议。sidecar 在三条通路上动手：① 识别 async launch-ack（父进程的 Agent 工具 tool_result），不再误发 `subagent_end`，改为发一个新事件 `subagent_async_launched`（带 agentId + output_file），并把 id 连同 .output 路径注册进 `SubagentTracker`；② 新模块 `subagentOutputTail.ts` 轮询读取 .output JSONL 的新增行，解析出子代理内部的 tool_use / tool_result / text / model，**复用现有 `subagent_progress`/`subagent_tool_result`/`subagent_text_delta` 事件**逐条转发（前端已有 handler，零改动）；③ 识别 `<task-notification>` 完成消息（SDK 在子代理结束时注入的 `type:"user"` 消息，内容是 XML 字符串），解析出 `<tool-use-id>`/`<status>`/`<result>`，发真正的 `subagent_end` 并停掉轮询。.output 全程只在 sidecar（Node）进程内被读取解析，**绝不进 LLM 上下文**——满足 Agent 工具「Do NOT Read this file」指令的精神（该指令是禁止 LLM 把 .output 灌进自己的 context，服务端解析转发正合规）。

**Tech Stack:** TypeScript + vitest（`agent-sidecar/` 用根目录 `vitest.config.ts`），Node fs，Claude Agent SDK。前端 Vue 3 不改协议、仅可能加一个事件 case + 一句 UI 文案。

---

## Context / 根因 / 证据

### 现象
用户在 GLM 主会话里派发子代理，子代理卡片只显示：
```
派发指令（1121 字）▼ Async agent launched successfully. agentId: a8b307d814f7b0f9e
… output_file: C:\Users\yangx\AppData\Local\Temp\claude\…\tasks\a8b307d814f7b0f9e.output
```
看不到工具链、看不到模型、看不到是否在跑/跑完。

### 三条根因（全部经实证确认，2026-07-11 aide run `e80f4edd`）

1. **Agent 工具默认 async**：该 run 父 transcript 里 3 次 Agent tool_use 全部没有 `run_in_background` 字段 → SDK 走 async 路径。

2. **async 子代理不把内部活动流回父进程**：子代理内部 47 次 tool_use 全在它自己的 `.output` 文件里，父 transcript `isSidechain:true` = 0、`parent_tool_use_id` = 0。所以 mapper.ts 基于流式 `parent_tool_use_id` 的可见性功能（2026-07-05 全量转发那套）对 async 子代理**完全够不着**——内部消息根本没流过来。

3. **launch-ack 被误当结束**：async 模式下，Agent 工具的 tool_result 立即返回一条「Async agent launched successfully. agentId: … output_file: …」launch-ack（父 transcript line 22，`type:"user"` 的 tool_result block）。mapper.ts:342 `subagents.handleToolResult(block.tool_use_id)` 对所有子代理 tool_result 一律返 true → 发 `subagent_end`，把 launch-ack 文本当成「结果」，卡片瞬间标完成。真正的完成信号在别处，被丢了（见下）。

### 完成信号（实证）
SDK 在 async 子代理结束时，向**父进程**注入一条 `type:"user"` 消息（父 transcript line 26），`message.content` 是**字符串**（不是 block 数组），内容是 `<task-notification>` XML：
```xml
<task-notification>
  <task-id>a8b307d814f7b0f9e</task-id>
  <tool-use-id>call_2fb7amip</tool-use-id>      <!-- 父 Agent 工具的 tool_use_id，= SubagentBlock.id -->
  <output-file>C:\…\tasks\a8b307d814f7b0f9e.output</output-file>
  <status>completed</status>                    <!-- 也可能是别的状态 -->
  <summary>Agent "…" finished</summary>
  <result>子代理最终回复文本（verbatim）</result>
  <usage><subagent_tokens>…</subagent_tokens><tool_uses>…</tool_uses><duration_ms>…</duration_ms></usage>
</task-notification>
```
该消息带 `origin:{kind:"task-notification"}`，是模型「知道子代理完成」的依据 → 必然经 `query()` 流给 sidecar。但 mapper.ts:335-356 的 `type:"user"` 分支只认 `content` 为 block 数组里的 `tool_result`；content 是字符串时 `for (const block of msg.message.content)` 退化为逐字符遍历，啥也不发 → **完成信号被静默丢弃**，卡片永远停在 launch-ack 那条假结束上。

另有 `type:"queue-operation"` / `operation:"enqueue"` 消息（line 24）也带同样的 task-notification XML（`content` 字段），是 SDK 内部队列日志，**不一定经 `query()` 流出**——作为防御性兜底处理，不依赖。

### .output 格式（实证，`-o` 抽样，未整文件加载）
路径 `%Temp%\claude\<project-hash>\<session-uuid>\tasks\<agentId>.output`，JSONL，每行一个 JSON：
- `type:"assistant"`：`message.content` 是 block 数组（`tool_use`/`text`），`message.model` 是子代理模型；`stop_reason` 多为 `"tool_use"`。
- `type:"user"`：`message.content` 是 block 数组，含 `tool_result` block（`tool_use_id` + `content` + `is_error`）。
- 全部带 `isSidechain:true`、`agentId`。

**关键坑点（实证）**：`.output` 没有可靠的结束标记——a8b307d814f7b0f9e.output 里 `end_turn` = 0、`type:"result"` = 0，只有 20× `stop_reason:"tool_use"`。所以 **done 必须靠 task-notification 判断，不能靠 .output 尾部**。.output 只负责「进度回放」。

### 设计决策：为什么放 sidecar 而不是 Rust
- CLAUDE.md 架构红线：「Claude 专属逻辑只允许存在于 `agent-sidecar/`」。.output 的 JSONL 格式（`isSidechain`/`message.content` 的 tool_use/tool_result）是 Claude SDK 专属 → 解析它必须在 sidecar（Node），不在 Rust。
- sidecar 已经有 `SubagentTracker`、已经发 `subagent_progress`/`subagent_tool_result`/`subagent_text_delta`/`subagent_end` 这一套事件，前端已全部接好（2026-07-05 全量转发落地）。把 .output 回放映射到**同一套事件**，前端零协议改动、Rust 零改动、deltaCoalescer 自动受益（CLAUDE.md：sidecar 事件出口必须过 delta 合并层——回放事件也走 stdout → deltaCoalescer，不绕过）。
- Rust 侧只读文件会引入「Rust 解析 Claude 专属格式」的污染，且要新增 tauri command + 前端轮询 + 第二套渲染通路——更重、更脏。

---

## Global Constraints

- **只改 `agent-sidecar/`**：不动 `src-tauri/`、不动 `src/` 的协议（前端最多加一个 `subagent_async_launched` 事件 case + 一句 UI 文案，不改渲染主体）。
- **.output 绝不进 LLM 上下文**：sidecar 在 Node 进程内 `fs.read` 解析，转发成结构化 ChatEvent；不把 .output 内容塞回 SDK 的 `query()`、不写进发给模型的任何消息。满足 Agent 工具「Do NOT Read this file via the shell tool」指令的精神——该指令禁止的是 LLM 把整文件灌进 context，服务端解析转发正合规。
- **复用现有事件类型**：回放走 `subagent_progress`/`subagent_tool_result`/`subagent_text_delta`/`subagent_end`，不新增「回放专用」事件。唯一新增事件是 `subagent_async_launched`（launch-ack 标记 + .output 路径），provider-agnostic 命名（无 Anthropic 专属词）。
- **不支持嵌套子代理**：.output 里若出现子代理内部又派 Agent 工具，按普通 tool_use 一条 `subagent_progress` 报出去，不递归展开（与 2026-07-05 计划同一范围边界）。
- **done 只认 task-notification**：.output 轮询不判定完成；完成由 mapper 的 `<task-notification>` 分支发 `subagent_end` 并停轮询。加一个「无增长超时」兜底（见 Task 2），但不作为主判定。
- **跨平台**：.output 路径来自 launch-ack 文本（绝对路径，OS 无关），Node `fs` 读取无 Windows 特有逻辑；路径含 `\\` 是 JSON 转义，解析后是普通字符串。无需 `#[cfg]`、无需 `dunce`。
- **deltaCoalescer**：回放事件经 stdout 正常走 deltaCoalescer（已有的逐字合并对 `subagent_text_delta` 同样生效，避免回放文本洪峰）；禁止绕过 stdout 直写。
- **TDD**：sidecar 用 vitest，`npx vitest run <path>`；类型检查 `cd agent-sidecar && npx tsc --noEmit`。launch-ack 识别、task-notification 解析、.output 行解析都是纯函数，先写失败测试。

---

### Task 1：sidecar 识别 async launch-ack，不发假结束，注册 .output 路径

**Files:**
- Modify: `agent-sidecar/src/types.ts`
- Modify: `agent-sidecar/src/subagents.ts`
- Modify: `agent-sidecar/src/mapper.ts`
- Test: `agent-sidecar/src/mapper.test.ts`

**Interfaces:**
- Consumes：现有 `SubagentTracker.handleToolUse`/`handleToolResult`/`isActive`/`claimModelReport`（`subagents.ts`）。
- Produces：新 ChatEvent `{ type: "subagent_async_launched"; id: string; agentId: string; outputFile: string }`；`SubagentTracker` 新增 `registerAsync(id, agentId, outputFile)` / `getAsyncOutputFile(id)` / `handleAsyncResult(id)`（Task 2 的 tail 用 `getAsyncOutputFile` 取路径，Task 3 的完成分支用 `handleAsyncResult` 清理）。

- [ ] **Step 1：写失败的测试**

在 `agent-sidecar/src/mapper.test.ts` 的 `describe("mapSdkMessage routing for subagent tools", …)` 块末尾追加：

```ts
it("async launch-ack tool_result 发 subagent_async_launched 而非 subagent_end，并注册 agentId+outputFile", () => {
  const events: ChatEvent[] = [];
  const tasks = new TaskTracker();
  const subagents = new SubagentTracker();
  mapSdkMessage(
    assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
    (e) => events.push(e),
    tasks,
    subagents,
  );
  events.length = 0;
  // async launch-ack：Agent 工具的 tool_result 立即返回这条文本
  const launchAck = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a1", content: "Async agent launched successfully. agentId: ab99381a4a2eb9ccd (internal ID …) The agent is working in the background. output_file: C:\\Users\\x\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output\nDo NOT Read this file via the shell tool …" }],
    },
  };
  mapSdkMessage(launchAck, (e) => events.push(e), tasks, subagents);
  expect(events).toEqual([
    { type: "subagent_async_launched", id: "a1", agentId: "ab99381a4a2eb9ccd", outputFile: "C:\\Users\\x\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output" },
  ]);
  expect(subagents.isActive("a1")).toBe(true); // 没被 launch-ack 关掉
  expect(subagents.getAsyncOutputFile("a1")).toBe("C:\\Users\\x\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output");
});

it("sync 子代理 tool_result（无 launch-ack 签名）仍走 subagent_end，不被误判 async", () => {
  const events: ChatEvent[] = [];
  const tasks = new TaskTracker();
  const subagents = new SubagentTracker();
  mapSdkMessage(
    assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
    (e) => events.push(e),
    tasks,
    subagents,
  );
  events.length = 0;
  const syncResult = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "调研结论：用了 Vue3+Tauri。" }] },
  };
  mapSdkMessage(syncResult, (e) => events.push(e), tasks, subagents);
  expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "调研结论：用了 Vue3+Tauri。", is_error: false }]);
  expect(subagents.isActive("a1")).toBe(false);
});
```

- [ ] **Step 2：运行测试确认失败**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: FAIL——第一个测试现状会发 `subagent_end`（launch-ack 被误当结束）且 `ChatEvent` 没有 `subagent_async_launched` 类型；第二个测试现状能过（回归锁定）。

- [ ] **Step 3：实现最小代码**

`agent-sidecar/src/types.ts`：在 `subagent_end` 那行之前加：

```ts
  // async（后台）子代理的 launch-ack：Agent 工具 tool_result 立即返回「Async agent
  // launched … agentId: … output_file: …」。此时子代理才刚起步，不能当结束——发这个
  // 事件告诉前端「在后台跑」，并带上 .output 路径，sidecar 的 tail 据此回放内部活动。
  | { type: "subagent_async_launched"; id: string; agentId: string; outputFile: string }
  | { type: "subagent_end"; id: string; result: string; is_error: boolean }
```

`agent-sidecar/src/subagents.ts`：在 `SubagentTracker` 类里加 async 注册表（与现有 `active`/`modelReported`/`names` 并列的同层状态）：

```ts
  // async 子代理的 .output 回放元数据：id → { agentId, outputFile }。
  // launch-ack 时注册，task-notification 完成时清理。
  private asyncMeta = new Map<string, { agentId: string; outputFile: string }>();

  /** async launch-ack 时调用：记下 .output 路径，id 保持 active（不关）。 */
  registerAsync(id: string, agentId: string, outputFile: string): void {
    this.asyncMeta.set(id, { agentId, outputFile });
  }
  getAsyncOutputFile(id: string): string | undefined {
    return this.asyncMeta.get(id)?.outputFile;
  }
  /** task-notification 完成时调用：清 async 元数据 + 关 active（复用 handleToolResult）。 */
  handleAsyncResult(id: string): boolean {
    this.asyncMeta.delete(id);
    return this.handleToolResult(id);
  }
```

`agent-sidecar/src/mapper.ts`：把 `type === "user"` 分支里 tool_result 的子代理处理（第 335-356 行附近）改成区分 async launch-ack 与 sync 结果。在 `if (block.type === "tool_result") {` 块内、`subagents.handleToolResult` 调用之前插入 async 识别：

```ts
        if (subagents.handleToolResult(block.tool_use_id)) {
          // async launch-ack：「Async agent launched … agentId: <id> … output_file: <path>.output」
          // 是子代理刚起步的回执，不是结果——改发 subagent_async_launched，保持 active 让 tail 回放。
          const ack = parseAsyncLaunchAck(content);
          if (ack) {
            subagents.registerAsync(block.tool_use_id, ack.agentId, ack.outputFile);
            // registerAsync 不动 active；handleToolResult 已把 id 关掉，这里重新激活，
            // 让 tail 期间 emitSubagentProgress 的 isActive 判定仍通过（防御性，理论上 tail
            // 不依赖 active，因为 .output 行不带 parent_tool_use_id，走不到那条路径）。
            subagents.reactivate(block.tool_use_id);
            emit({ type: "subagent_async_launched", id: block.tool_use_id, agentId: ack.agentId, outputFile: ack.outputFile });
          } else {
            // sync 子代理：content 是真正结果
            emit({ type: "subagent_end", id: block.tool_use_id, result: content, is_error: block.is_error ?? false });
          }
          continue;
        }
```

> 注：`handleToolResult` 现有签名返回 boolean 且会 delete active。为语义清晰，**优先方案**是把 async 识别提前到 `handleToolResult` 之前——即先 `parseAsyncLaunchAck(content)`，命中则 `registerAsync` + 发 `subagent_async_launched` + `continue`（不调 `handleToolResult`，保持 active）；未命中才走原 `handleToolResult` → `subagent_end`。这样不需要 `reactivate`。实现时按这个优先方案写，上面带 `reactivate` 的片段仅作语义说明。`SubagentTracker` 需补一个 `reactivate(id)`（`this.active.add(id)`）仅在采用回退方案时才加——优先方案不需要它，别加死代码。

新增纯函数 `parseAsyncLaunchAck`（放 `mapper.ts` 顶部工具函数区，导出供测试）：

```ts
/**
 * 识别 async 子代理的 launch-ack 文本，提取 agentId 与 .output 路径。
 * launch-ack 形如：「Async agent launched successfully. agentId: <hex> … output_file: <path>.output\nDo NOT Read …」。
 * sync 子代理的 tool_result content 不含 `agentId:`/`output_file:` 签名 → 返回 null。
 */
export function parseAsyncLaunchAck(content: string): { agentId: string; outputFile: string } | null {
  const agentMatch = content.match(/agentId:\s*([a-z0-9]+)/);
  const fileMatch = content.match(/output_file:\s*(\S+\.output)/);
  if (!agentMatch || !fileMatch) return null;
  return { agentId: agentMatch[1], outputFile: fileMatch[1] };
}
```

- [ ] **Step 4：运行测试确认通过**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: PASS（含两个新测试 + 原有全部测试）。

- [ ] **Step 5：类型检查**

Run: `cd agent-sidecar && npx tsc --noEmit`
Expected: 无输出。（`subagent_async_launched` 前端类型镜像在 Task 4 补；此处 sidecar 自洽。）

- [ ] **Step 6：Commit**

```bash
git add agent-sidecar/src/types.ts agent-sidecar/src/subagents.ts agent-sidecar/src/mapper.ts agent-sidecar/src/mapper.test.ts
git commit -m "$(cat <<'EOF'
feat(sidecar): 识别 async 子代理 launch-ack，不再误发 subagent_end

async Agent 工具的 tool_result 立即返回「Async agent launched … agentId …
output_file …」回执，之前被一律当 subagent_end → 卡片瞬间假结束。新增
parseAsyncLaunchAck 纯函数识别该签名，命中则发 subagent_async_launched
（带 agentId + .output 路径）并保持 active，未命中才走原 subagent_end。
SubagentTracker 加 asyncMeta 注册表（registerAsync/getAsyncOutputFile/
handleAsyncResult）。done 信号改由 task-notification 提供（见后续任务）。
EOF
)"
```

---

### Task 2：sidecar 回放 .output——`subagentOutputTail.ts` 轮询 + 行解析

**Files:**
- Create: `agent-sidecar/src/subagentOutputTail.ts`
- Test: `agent-sidecar/src/subagentOutputTail.test.ts`
- Modify: `agent-sidecar/src/mapper.ts`（launch-ack 处启动 tail）
- Modify: `agent-sidecar/src/index.ts`（进程退出 / 会话清理时停所有 tail）

**Interfaces:**
- Consumes：Task 1 的 `subagent_async_launched` 触发点 + `getAsyncOutputFile(id)`。
- Produces：`subagentOutputTail.ts` 导出 `startOutputTail(id, outputFile, emit, onStop)` 与 `stopAllOutputTails()`；内部把 .output 的 JSONL 行解析成 `subagent_progress`/`subagent_tool_result`/`subagent_text_delta` 事件（复用 Task 2b 抽出的共享解析函数）。

- [ ] **Step 1：抽出共享的子代理消息块解析函数（先重构再复用）**

`emitSubagentProgress`（mapper.ts:197-260）当前把「assistant 的 tool_use/text + user 的 tool_result」解析与 stream_event 增量混在一起。抽出纯函数 `emitSubagentBlocks(msg, id, emit, claimModel)` 处理 assistant/user 两条分支（不含 stream_event），供 `emitSubagentProgress` 与 .output tail 共用。stream_event 分支留在 `emitSubagentProgress`。

```ts
/**
 * 解析子代理的 assistant/user 消息块并转发为 subagent_progress / subagent_tool_result /
 * subagent_text_delta。assistant 与 user 两条分支被 .output 回放和流式 emitSubagentProgress
 * 共用——区别只在消息来源（流式带 parent_tool_use_id vs .output 自身 transcript），块结构相同。
 * stream_event 逐字增量不在此（流式专属，.output 里没有）。
 * claimModel：返回 true 表示「这次能坐实 model 并只报一次」——流式用 claimModelReport，
 *   .output 回放用自己的 once 闭包（见 subagentOutputTail.ts）。
 */
export function emitSubagentBlocks(
  msg: any,
  id: string,
  emit: (e: ChatEvent) => void,
  claimModel: () => boolean,
) {
  if (msg.type === "user" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type !== "tool_result") continue;
      const content = Array.isArray(block.content)
        ? block.content.map((c: any) => c.text ?? "").join("")
        : String(block.content ?? "");
      emit({ type: "subagent_tool_result", id, toolUseId: block.tool_use_id, content, is_error: block.is_error ?? false });
    }
    return;
  }
  if (msg.type !== "assistant" || !msg.message?.content) return;
  const toolUses = (msg.message.content as any[]).filter((b) => b.type === "tool_use");
  const model = claimModel() ? (msg.message.model as string) : undefined;
  if (toolUses.length === 0) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text) emit({ type: "subagent_text_delta", id, delta: block.text });
    }
    return;
  }
  toolUses.forEach((block, i) => {
    emit({
      type: "subagent_progress",
      id,
      toolUseId: block.id,
      toolName: block.name,
      input: block.input,
      ...(i === 0 && model ? { model } : {}),
    });
  });
}
```

`emitSubagentProgress` 的 assistant/user 分支改为调 `emitSubagentBlocks(msg, parentId, emit, () => subagents.claimModelReport(parentId))`，stream_event 分支保留在前。跑现有测试确认无回归。

- [ ] **Step 2：写失败的测试（tail 行解析）**

`agent-sidecar/src/subagentOutputTail.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { parseOutputLine } from "./subagentOutputTail";
import type { ChatEvent } from "./types";

describe("subagentOutputTail parseOutputLine", () => {
  const id = "a1";
  let modelClaimed = false;
  const claimModel = () => { if (!modelClaimed) { modelClaimed = true; return true; } return false; };

  function run(line: string): ChatEvent[] {
    const events: ChatEvent[] = [];
    parseOutputLine(line, id, (e) => events.push(e), claimModel);
    return events;
  }

  beforeEach(() => { modelClaimed = false; }); // eslint-disable-line @typescript-eslint/no-require-imports

  it("assistant tool_use 行 → subagent_progress（首行带 model）", () => {
    const ev = run(JSON.stringify({
      type: "assistant", isSidechain: true, agentId: "ab99",
      message: { role: "assistant", model: "glm-5.2", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.ts" } }] },
    }));
    expect(ev).toEqual([{ type: "subagent_progress", id: "a1", toolUseId: "t1", toolName: "Read", input: { file_path: "x.ts" }, model: "glm-5.2" }]);
  });

  it("第二条 assistant tool_use 不再带 model（claimModel once）", () => {
    run(JSON.stringify({ type: "assistant", message: { model: "glm-5.2", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } }));
    const ev = run(JSON.stringify({ type: "assistant", message: { model: "glm-5.2", content: [{ type: "tool_use", id: "t2", name: "Grep", input: {} }] } }));
    expect(ev).toEqual([{ type: "subagent_progress", id: "a1", toolUseId: "t2", toolName: "Grep", input: {} }]);
  });

  it("user tool_result 行 → subagent_tool_result 回填", () => {
    const ev = run(JSON.stringify({
      type: "user", isSidechain: true, agentId: "ab99",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "文件内容…", is_error: false }] },
    }));
    expect(ev).toEqual([{ type: "subagent_tool_result", id: "a1", toolUseId: "t1", content: "文件内容…", is_error: false }]);
  });

  it("assistant 纯文本行 → subagent_text_delta", () => {
    const ev = run(JSON.stringify({ type: "assistant", message: { model: "glm-5.2", content: [{ type: "text", text: "我先看看" }] } }));
    expect(ev).toEqual([{ type: "subagent_text_delta", id: "a1", delta: "我先看看" }]);
  });

  it("空行/非法 JSON → 不发事件，不抛", () => {
    expect(run("")).toEqual([]);
    expect(run("not json")).toEqual([]);
  });
});
```
（补 `import { beforeEach } from "vitest"`，去掉那行 eslint 占位。）

- [ ] **Step 3：运行测试确认失败**

Run: `npx vitest run agent-sidecar/src/subagentOutputTail.test.ts`
Expected: FAIL——`subagentOutputTail.ts` 还不存在。

- [ ] **Step 4：实现 `subagentOutputTail.ts`**

```ts
import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import type { ChatEvent } from "./types";
import { emitSubagentBlocks } from "./mapper";

/** 解析 .output 的一行 JSONL → 子代理事件。空行/非法 JSON 安静丢弃（.output 尾部可能有半行）。 */
export function parseOutputLine(line: string, id: string, emit: (e: ChatEvent) => void, claimModel: () => boolean): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return; } // 半行/损坏：等下次轮询补全
  emitSubagentBlocks(msg, id, emit, claimModel);
}

/** 一个 async 子代理的 .output tail：从上次 offset 读新增的完整行，逐行解析转发。 */
class OutputTail {
  private offset = 0;
  private leftover = "";
  private modelClaimed = false;
  private stopped = false;
  constructor(
    private readonly id: string,
    private readonly outputFile: string,
    private readonly emit: (e: ChatEvent) => void,
    private readonly onStop: (id: string) => void,
  ) {}
  tick(): void {
    if (this.stopped) return;
    if (!existsSync(this.outputFile)) return; // 子代理还没开始写
    let fd: number | undefined;
    try {
      const st = statSync(this.outputFile);
      if (st.size < this.offset) { this.offset = 0; this.leftover = ""; } // 文件被截断/换新
      if (st.size === this.offset) return;
      fd = openSync(this.outputFile, "r");
      const buf = Buffer.allocUnsafe(st.size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = st.size;
      const data = this.leftover + buf.toString("utf8");
      const lines = data.split(/\r?\n/);
      this.leftover = lines.pop() ?? ""; // 最后一段可能是不完整行，留给下次
      const claimModel = () => (this.modelClaimed ? false : (this.modelClaimed = true));
      for (const line of lines) parseOutputLine(line, this.id, this.emit, claimModel);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  stop(): void { this.stopped = true; }
}

const tails = new Map<string, OutputTail>();
let timer: NodeJS.Timeout | undefined;

/** 启动一个 .output tail，加入全局轮询。幂等：同 id 重复启动忽略。 */
export function startOutputTail(id: string, outputFile: string, emit: (e: ChatEvent) => void, onStop: (id: string) => void): void {
  if (tails.has(id)) return;
  tails.set(id, new OutputTail(id, outputFile, emit, onStop));
  ensureTimer();
}

export function stopOutputTail(id: string): void {
  const t = tails.get(id);
  if (t) { t.stop(); tails.delete(id); }
  if (tails.size === 0 && timer) { clearInterval(timer); timer = undefined; }
}

export function stopAllOutputTails(): void {
  for (const t of tails.values()) t.stop();
  tails.clear();
  if (timer) { clearInterval(timer); timer = undefined; }
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    for (const t of tails.values()) {
      try { t.tick(); } catch { /* 单条 tail 出错不影响其它 */ }
    }
  }, 600); // 600ms：肉眼「实时」又不至于 IO 洪峰（每 tail 一个 stat+read）
  if (typeof (timer as any).unref === "function") (timer as any).unref(); // 不挡进程退出
}
```

- [ ] **Step 5：运行测试确认通过**

Run: `npx vitest run agent-sidecar/src/subagentOutputTail.test.ts`
Expected: PASS。

- [ ] **Step 6：mapper 启动 tail + index.ts 清理**

`mapper.ts`：Task 1 的 `subagent_async_launched` 发出处，紧接其后调 `startOutputTail`。但 `mapSdkMessage` 的 `emit` 是出 sidecar stdout 的回调——tail 复用同一个 `emit` 即可（事件经 stdout → deltaCoalescer）：

```ts
emit({ type: "subagent_async_launched", id: block.tool_use_id, agentId: ack.agentId, outputFile: ack.outputFile });
startOutputTail(block.tool_use_id, ack.outputFile, emit, (tailId) => {
  // 无增长超时兜底由 Task 3 的 task-notification 主路径收尾；此处仅做安全网：
  // tail 自身不判定 done，只负责进度回放。stopOutputTail 由 task-notification 分支调。
});
```

`agent-sidecar/src/index.ts`：进程退出（SIGINT/SIGTERM/正常收尾）处调 `stopAllOutputTails()`，避免泄漏定时器。具体位置：现有进程清理钩子旁（搜 `process.on` / `SIGINT`）。

- [ ] **Step 7：类型检查 + 全量测试**

Run: `cd agent-sidecar && npx tsc --noEmit && npx vitest run`
Expected: 无类型错误 + 全绿。

- [ ] **Step 8：Commit**

```bash
git add agent-sidecar/src/subagentOutputTail.ts agent-sidecar/src/subagentOutputTail.test.ts agent-sidecar/src/mapper.ts agent-sidecar/src/index.ts
git commit -m "$(cat <<'EOF'
feat(sidecar): 回放 async 子代理 .output 的内部活动（option C）

新增 subagentOutputTail：launch-ack 后按 600ms 轮询 .output JSONL 新增行，
解析出子代理内部的 tool_use/tool_result/text/model，复用现有
subagent_progress/subagent_tool_result/subagent_text_delta 事件转发（前端
零协议改动）。抽出 emitSubagentBlocks 共享解析供流式与回放复用。半行/截断
文件安全处理，unref 定时器不挡进程退出，index.ts 退出时停所有 tail。
done 不靠 .output（实测无 end_turn/result 标记），由 Task 3 的
task-notification 提供。
EOF
)"
```

---

### Task 3：sidecar 识别 `<task-notification>` 完成信号，发真 `subagent_end` + 停 tail

**Files:**
- Modify: `agent-sidecar/src/mapper.ts`
- Test: `agent-sidecar/src/mapper.test.ts`

**Interfaces:**
- Consumes：SDK 流来的 `type:"user"` 字符串 content 消息（`<task-notification>` XML）；`type:"queue-operation"`（防御性兜底）。
- Produces：真正的 `subagent_end { id, result, is_error }`（id = `<tool-use-id>`，result = `<result>` 文本）；调用 `stopOutputTail(id)` + `subagents.handleAsyncResult(id)`。

- [ ] **Step 1：写失败的测试**

`mapper.test.ts` 追加：

```ts
it("task-notification（user 字符串 content）发 subagent_end，结果取 <result>，停 tail", () => {
  const events: ChatEvent[] = [];
  const tasks = new TaskTracker();
  const subagents = new SubagentTracker();
  // 先把 a1 起成 async 子代理
  mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }), (e) => events.push(e), tasks, subagents);
  events.length = 0;
  let stopped = false;
  vi.mock? undefined; // 占位，实际用模块级 stopOutputTail spy
  // task-notification：user 消息，content 是 XML 字符串
  const note = {
    type: "user",
    message: { role: "user", content: "<task-notification>\n<task-id>ab99</task-id>\n<tool-use-id>a1</tool-use-id>\n<output-file>C:\\x\\ab99.output</output-file>\n<status>completed</status>\n<summary>Agent \"…\" finished</summary>\n<result>调研结论：用了 Vue3+Tauri。</result>\n<usage><subagent_tokens>100</subagent_tokens></usage>\n</task-notification>" },
    origin: { kind: "task-notification" },
  };
  mapSdkMessage(note, (e) => events.push(e), tasks, subagents);
  expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "调研结论：用了 Vue3+Tauri。", is_error: false }]);
  expect(subagents.isActive("a1")).toBe(false);
});

it("task-notification status 非 completed → is_error:true", () => {
  const events: ChatEvent[] = [];
  const tasks = new TaskTracker();
  const subagents = new SubagentTracker();
  mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "x" }), (e) => events.push(e), tasks, subagents);
  events.length = 0;
  const note = { type: "user", message: { role: "user", content: "<task-notification>\n<tool-use-id>a1</tool-use-id>\n<status>failed</status>\n<result>model 不存在</result>\n</task-notification>" } };
  mapSdkMessage(note, (e) => events.push(e), tasks, subagents);
  expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "model 不存在", is_error: true }]);
});

it("普通 user 文本消息（非 task-notification）不被误当完成", () => {
  const events: ChatEvent[] = [];
  const tasks = new TaskTracker();
  const subagents = new SubagentTracker();
  const plain = { type: "user", message: { role: "user", content: "用户随手打的一句话" } };
  mapSdkMessage(plain, (e) => events.push(e), tasks, subagents);
  expect(events).toEqual([]);
});
```
（`stopOutputTail` 的停 tail 验证用 `vi.spyOn` 注入；上面占位的 `vi.mock?` 删掉，改在测试里 `import * as tailMod from "./subagentOutputTail"; const spy = vi.spyOn(tailMod, "stopOutputTail");` 并断言 `expect(spy).toHaveBeenCalledWith("a1")`。）

- [ ] **Step 2：运行测试确认失败**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: FAIL——现状 `type:"user"` 字符串 content 被逐字符遍历丢弃，不发任何事件。

- [ ] **Step 3：实现最小代码**

`mapper.ts`：在 `mapSdkMessage` 的 `type === "user"` 分支**最前面**（block 循环之前）加 task-notification 识别：

```ts
  if (msg.type === "user" && msg.message && typeof msg.message.content === "string") {
    const note = parseTaskNotification(msg.message.content);
    if (note) {
      if (subagents.isActive(note.toolUseId)) {
        stopOutputTail(note.toolUseId);
        subagents.handleAsyncResult(note.toolUseId);
        emit({ type: "subagent_end", id: note.toolUseId, result: note.result, is_error: note.status !== "completed" });
      }
      return; // 不进下面的 tool_result block 循环
    }
    // 其它字符串 content（普通用户输入等）：当前主流程不处理，保持现状丢弃
  }
  // 防御性：queue-operation/enqueue 也可能带 task-notification（SDK 内部队列日志，不一定流出）
  if (msg.type === "queue-operation" && msg.operation === "enqueue" && typeof msg.content === "string") {
    const note = parseTaskNotification(msg.content);
    if (note && subagents.isActive(note.toolUseId)) {
      stopOutputTail(note.toolUseId);
      subagents.handleAsyncResult(note.toolUseId);
      emit({ type: "subagent_end", id: note.toolUseId, result: note.result, is_error: note.status !== "completed" });
    }
    return;
  }
```

新增纯函数 `parseTaskNotification`（导出供测试）：

```ts
/**
 * 解析 SDK 注入的 <task-notification> XML，提取 tool-use-id / status / result。
 * content 不以 <task-notification> 开头 → 返回 null（普通用户消息不误判）。
 * result 缺省取 <summary> 兜底，再缺省空串。
 */
export function parseTaskNotification(content: string): { toolUseId: string; status: string; result: string } | null {
  if (!content.startsWith("<task-notification>")) return null;
  const id = content.match(/<tool-use-id>([^<]*)<\/tool-use-id>/)?.[1];
  if (!id) return null;
  const status = content.match(/<status>([^<]*)<\/status>/)?.[1] ?? "completed";
  const result = content.match(/<result>([\s\S]*?)<\/result>/)?.[1] ?? content.match(/<summary>([^<]*)<\/summary>/)?.[1] ?? "";
  return { toolUseId: id, status, result };
}
```

`mapper.ts` 顶部 `import { startOutputTail, stopOutputTail } from "./subagentOutputTail";`。

- [ ] **Step 4：运行测试确认通过**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: PASS（含三个新测试 + 全部回归）。

- [ ] **Step 5：类型检查**

Run: `cd agent-sidecar && npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6：Commit**

```bash
git add agent-sidecar/src/mapper.ts agent-sidecar/src/mapper.test.ts
git commit -m "$(cat <<'EOF'
feat(sidecar): 识别 task-notification 完成 signal，发真 subagent_end 并停 tail

SDK 在 async 子代理结束时注入 type:"user" 消息，content 是 <task-notification>
XML 字符串（含 <tool-use-id>/<status>/<result>）。之前因 content 是字符串非
block 数组，被逐字符遍历丢弃 → 卡片永远停在 launch-ack 假结束。新增
parseTaskNotification 解析 XML，发 subagent_end（result 取 <result>，is_error
看 status≠completed），调 stopOutputTail + handleAsyncResult 收尾。实测 .output
无 end_turn/result 标记，done 必须靠这条信号。queue-operation/enqueue 兜底同处理。
EOF
)"
```

---

### Task 4：前端接 `subagent_async_launched` + UI 文案

**Files:**
- Modify: `src/types/chat.ts`（SubagentBlock 加 `asyncLaunched?: { agentId; outputFile }`）
- Modify: `src/composables/useChatSession.ts`（新 case）
- Modify: `src/components/SubagentCallBlock.vue`（后台运行中文案）

**说明**：回放的工具链/模型/结果**全部复用现有 handler**（`subagent_progress`/`subagent_tool_result`/`subagent_text_delta`/`subagent_end`），前端不改渲染主体。本任务只：① 镜像新事件类型；② 标记「后台运行中」让卡片 pending 文案更准（而非干等）；③ 顺手验证现有 handler 对「事件延迟到达、跨较长间隔」的 async 时序正常工作。

- [ ] **Step 1：写失败的测试**

`src/composables/useChatSession.test.ts` 的 `describe("useChatSession subagent events", …)` 块末尾追加：

```ts
it("subagent_async_launched 标记后台运行中（保持 pending），后续回放事件正常累积", async () => {
  const sid = ref<string | null>("uuid-a");
  const chat = useChatSession(sid);
  await flush();
  await chat.sendMessage("帮我调研 XXX");
  emit({ type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX", session_id: "uuid-a" });
  emit({ type: "subagent_async_launched", id: "a1", agentId: "ab99", outputFile: "C:\\x\\ab99.output", session_id: "uuid-a" });
  await flush();

  let block = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "subagent") as
    | { isPending: boolean; asyncLaunched?: { agentId: string; outputFile: string } }
    | undefined;
  expect(block?.isPending).toBe(true);
  expect(block?.asyncLaunched).toEqual({ agentId: "ab99", outputFile: "C:\\x\\ab99.output" });

  // sidecar tail 回放的工具链经现有 subagent_progress handler 累积
  emit({ type: "subagent_progress", id: "a1", toolUseId: "t1", toolName: "Read", input: { file_path: "x.ts" }, model: "glm-5.2", session_id: "uuid-a" });
  await flush();
  block = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "subagent") as any;
  expect(block?.entries).toEqual([{ type: "tool", toolUseId: "t1", toolName: "Read", input: { file_path: "x.ts" } }]);
  expect(block?.model).toBe("glm-5.2");

  // task-notification 收尾
  emit({ type: "subagent_end", id: "a1", result: "结论…", is_error: false, session_id: "uuid-a" });
  await flush();
  block = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "subagent") as any;
  expect(block?.isPending).toBe(false);
  expect(block?.result).toBe("结论…");
});
```

- [ ] **Step 2：运行测试确认失败**

Run: `npx vitest run src/composables/useChatSession.test.ts`
Expected: FAIL——`subagent_async_launched` 还没 case，`asyncLaunched` 字段不存在。

- [ ] **Step 3：实现最小代码**

`src/types/chat.ts`：`SubagentBlock` 加字段：

```ts
  /** async（后台）子代理：launch-ack 到达后标记，UI 显示「后台运行中」。
   *  回放的工具链/模型由 sidecar tail 经 subagent_progress 等事件推，与 sync 同路。 */
  asyncLaunched?: { agentId: string; outputFile: string };
```

`src/composables/useChatSession.ts`：在 `case "subagent_progress":` 之前加：

```ts
    case "subagent_async_launched": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        block.asyncLaunched = { agentId: e["agentId"] as string, outputFile: e["outputFile"] as string };
      }
      break;
    }
```

`src/components/SubagentCallBlock.vue`：把现有的 pending 兜底文案区分 async：

```vue
<div v-else-if="!block.entries.length" class="subagent-pending">
  {{ block.asyncLaunched ? "子代理后台运行中…" : "子代理执行中…" }}
</div>
```
（`block.asyncLaunched` 存在但已有 entries 时，工具链正在回放，沿用现有 entries 渲染即可，不显示该兜底。）

- [ ] **Step 4：运行测试确认通过**

Run: `npx vitest run src/composables/useChatSession.test.ts`
Expected: PASS。

- [ ] **Step 5：类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6：Commit**

```bash
git add src/types/chat.ts src/composables/useChatSession.ts src/composables/useChatSession.test.ts src/components/SubagentCallBlock.vue
git commit -m "$(cat <<'EOF'
feat(chat): 前端接 subagent_async_launched，后台运行中文案

SubagentBlock 加 asyncLaunched 元数据，useChatSession 新增对应 case（仅标记，
保持 pending）。回放的工具链/模型/结果复用现有 handler，零渲染主体改动。
SubagentCallBlock pending 文案区分「后台运行中…」。
EOF
)"
```

---

### Task 5：手动验证（无自动化 UI/E2E 覆盖，比照项目现状）

Run: `pnpm tauri dev`（或 `dev.ps1`）。在应用里派一个 async 子代理——发一条让主代理用 `general-purpose` 子代理调研的消息（superpowers 的 implementer 派发即可触发，或直接「用子代理调研一下 src/composables 用了哪些 composable」）。

确认：
1. 子代理卡片头部出现 `agentName` + 描述 + 运行中图标；**不再**出现「Async agent launched successfully…」被当成结果的假完成。展开卡片，pending 文案是「子代理后台运行中…」。
2. 随子代理执行，卡片 entries **逐条增长**（600ms 粒度）：能看到 `Read`/`Grep` 等工具调用 + 入参摘要按顺序出现、模型标签（如 `glm-5.2`）出现在第一个工具步、工具步输出可点开（`subagent_tool_result` 回填）。这是「看到它在执行」。
3. 子代理真正结束后（task-notification 到达），状态图标从 ⏳ 变 ✅/❌，时间线下方追加 `result` 文本，isPending 翻 false。这是「看到执行完」。
4. 回归：sync 子代理（若有）仍正常显示完整结果；普通工具调用（非子代理）渲染不受影响；切换会话/进程退出不泄漏 tail 定时器（可多次派发子代理后观察 Node 进程定时器数，或退出时无报错）。
5. **关键验收（杠杆1）**：系统默认「子代理模型」字段填上便宜模型（GLM→glm-4.7、Opus→sonnet，见 [[aide-cost-saving-levers]]）后，async 子代理卡片显示的 model 标签应是钉死的便宜模型，**不再是主会话模型**——这条卡片的 model 来自 .output 回放（实证：.output 里 `message.model` 是子代理实际跑的模型），坐实杠杆1 生效。

---

## Self-Review Notes

- **根因覆盖**：三条根因（async 默认 / 内部活动不流回父 / launch-ack 误当结束）分别由 Task 1（不误发 subagent_end + 注册 .output）、Task 2（回放 .output 补齐内部活动）、Task 3（task-notification 发真结束）解决；完成信号丢失根因由 Task 3 解决。done 不靠 .output（实证无 end_turn/result 标记）——已在 Context 与 Task 2/3 注释明确。
- **架构红线**：所有 Claude 专属解析（.output JSONL、task-notification XML、launch-ack 文本）都在 `agent-sidecar/`；Rust 零改动；前端协议只加一个 provider-agnostic 命名的事件；回放事件复用现有 ChatEvent，过 deltaCoalescer，不绕过 stdout。
- **.output 不进 LLM 上下文**：sidecar Node 进程内 fs.read 解析转发，不回灌 SDK query()，满足 Agent 工具「Do NOT Read」指令精神。
- **Placeholder 扫描**：各 Task 代码块为可直接使用的完整代码；测试里 `vi.mock?`/`eslint 占位` 已注明删除替换，非占位逻辑。
- **类型一致性**：`subagent_async_launched`（types.ts Task 1 定义）字段 `id`/`agentId`/`outputFile` 与前端 useChatSession（Task 4）`e["id"]`/`e["agentId"]`/`e["outputFile"]` 对应；`emitSubagentBlocks` 的 `claimModel` 回调在流式（claimModelReport）与 tail（once 闭包）两处语义一致（首次 true、之后 false）。
- **未覆盖（明确边界）**：嵌套子代理按普通 tool_use 报（YAGNI）；tail 无增长超时兜底未做强判定（done 靠 task-notification，若该信号极端情况下不到，卡片停留在「后台运行中」+ 已回放的进度——可接受降级，后续如需可加「N 秒无增长 + 父进程 message_stop」推断 done）。
- **实证依据**：2026-07-11 aide run `e80f4edd`——父 transcript（line 22 launch-ack / line 24 queue-operation / line 26 task-notification user 消息）+ a8b307d814f7b0f9e.output（47 tool_use、59× model glm-5.2、0 end_turn、0 result）。