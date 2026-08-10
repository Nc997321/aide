# 扩展管理重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重做设置面板「扩展」tab，让 MCP/Skill/Hook/Agent/指令真正可编辑、接入 sidecar 生效、带 MCP 连接状态灯与测试连接探活。

**Architecture:** 三层解法——前端 5 个专属 editor 补类型字段；sidecar 新增 `userExtensions.ts` 显式读 `~/.aide/claude/settings.json` 注入 query options（不动 `settingSources:[]`）；内建 hook 抽注册表 + 前端只读展示；MCP 探活走一次性 sidecar 进程。

**Tech Stack:** Vue 3 + Composition API + TypeScript（前端）/ vitest 4 + @vue/test-utils + jsdom（前端测试）/ Rust + Tauri v2 + serde_json（后端）/ Node 18 + @anthropic-ai/claude-agent-sdk + @modelcontextprotocol/sdk（sidecar）

## Global Constraints

- **实施分支**：从 `master` 建 `feature/extensions-redesign`，所有实施 commit 在此分支。spec 文档已在 `docs/extensions-redesign-spec` 分支。
- **Windows 红线 1（CREATE_NO_WINDOW）**：所有 spawn 子进程的 Rust command 必须加 `#[cfg(windows)] { cmd.creation_flags(0x08000000); }`，否则 release 弹大量控制台窗口。涉及 `test_mcp_connection`。
- **Windows 红线 2（dunce 剥 `\\?\`）**：传给子进程（node/agent-runtime）的资源路径必须 `dunce::simplified(&path)` 剥 verbatim 前缀，否则子进程引导崩。涉及 `test_mcp_connection` spawn agent-runtime 的路径参数。
- **异步命令红线**：重 IO/spawn 的 Rust command 必须 `async fn`（`test_mcp_connection`、`read_skill_script`、`write_skill_script`、`delete_skill_script`）。**async 命令不埋 `trace_command`**（埋了抓不到，见 CLAUDE.md）。
- **路径单一来源**：sidecar 读 settings.json 用 `process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".aide", "claude")`（与 `dispatchPlugins.ts:79` 同源），Rust 用 `claude_home()`（=`~/.aide/claude`）。两者指向同一文件。
- **主题色**：前端组件所有颜色/边框/圆角用 `var(--aide-*)`，禁止硬编码 hex。
- **文件分层**：editor 下沉 `src/components/customizations/editors/` 子目录，`CustomizationDetail.vue` 退化为按 type 分派的门面。符合项目"内聚下沉、宿主只留门面"规则。
- **新增 sidecar 依赖**：`@modelcontextprotocol/sdk`（dep）+ `vitest`（devDep）。装包若失败用代理 `http://127.0.0.1:7890`（`pnpm --dir agent-sidecar add @modelcontextprotocol/sdk`，若 ECONNREFUSED 先 `export HTTPS_PROXY=http://127.0.0.1:7890`）。
- **测试**：前端 `pnpm test`（vitest run）/ sidecar `pnpm --dir agent-sidecar test`（vitest run，新增）/ Rust `cd src-tauri && cargo test`。
- **Hook 顺序铁律**：内建 hook 永远在前，用户 hook 追加在后；`policyHook`（PreToolUse `.*`）必须第一个评估。
- **sidecar dev 生效**：改 sidecar 源码后必须 `pnpm --dir agent-sidecar build` 重建 `dist/runtime.js` + 重启 app 才生效（项目记忆 [[sidecar-dev-rebuild-restart]]）。

**Reference spec:** `docs/superpowers/specs/2026-08-10-extensions-redesign-design.md`

---

## File Structure

### 新建文件

| 文件 | 职责 |
|---|---|
| `agent-sidecar/src/builtinHooks/index.ts` | 内建 hook 注册表：元数据 + 工厂函数（依赖注入） |
| `agent-sidecar/src/userExtensions.ts` | 读 settings.json 的 mcpServers/hooks，过滤 disabled，返回可直接 merge 的对象 |
| `agent-sidecar/test-mcp.ts` | 一次性探活入口：MCP Client + 三种 transport 握手，输出 JSON 退出（仿 `smoke-mcp.ts`，放根目录） |
| `agent-sidecar/src/userExtensions.test.ts` | userExtensions 单测（vitest） |
| `agent-sidecar/src/builtinHooks/index.test.ts` | 注册表单测（元数据完整、policyHook 第一、工厂条件挂载） |
| `agent-sidecar/vitest.config.ts` | sidecar vitest 配置 |
| `src/components/customizations/editors/McpServerEditor.vue` | MCP editor：传输类型 + 条件字段 + 状态灯 + 测试连接 |
| `src/components/customizations/editors/HookEditor.vue` | Hook editor：event/matcher/command/timeout/asyncRewake |
| `src/components/customizations/editors/SkillEditor.vue` | Skill editor：frontmatter + 正文 CodeMirror + scripts 子面板 |
| `src/components/customizations/editors/AgentEditor.vue` | Agent editor：frontmatter（含 model/tools）+ 正文 CodeMirror |
| `src/components/customizations/editors/InstructionEditor.vue` | 指令 editor：全文 CodeMirror + 全局/项目切换 |
| `src/components/customizations/editors/McpServerEditor.test.ts` 等 5 个 | 各 editor 渲染/交互测试 |

### 修改文件

| 文件 | 改动 |
|---|---|
| `agent-sidecar/src/session-worker.ts` | 组装 hooks/mcpServers 时调注册表 + userExtensions；回传内建 hook 清单 |
| `agent-sidecar/package.json` | 加 `@modelcontextprotocol/sdk` dep、`vitest` devDep、`test` script |
| `src-tauri/src/commands/customizations.rs` | `create/update_mcp_server` 改整体透传；新增 `read/write/delete_skill_script`、`test_mcp_connection` |
| `src-tauri/src/lib.rs` | 注册新命令（312-328 段后追加） |
| `src/types/customization.ts` | `McpServer` 扩展 `transport` + 条件字段；`CustomizationItem` 加 `source` |
| `src/composables/useCustomizations.ts` | 列表项带 `source`；hook 列表合并内置清单 |
| `src/api/customization.ts` | 加 `testMcpConnection`、`readSkillScript` 等 |
| `src/components/customizations/CustomizationDetail.vue` | 退化为按 type 分派到对应 editor 的门面 |
| `src/components/customizations/CustomizationList.vue` | 行加来源 badge；MCP 行加状态灯 + 测试连接按钮 |
| `src/components/SettingsPanel.vue` | 扩展 tab 顶部加「下次新会话生效」提示条 |

### 删除文件

| 文件 | 理由 |
|---|---|
| `src/components/customizations/CustomizationPanel.vue` | 死代码，零引用 |

---

## Task 1: builtinHooks 注册表

把散在 `session-worker.ts:954-974` 的 6 个内建 hook 抽成注册表模块。注册表存元数据 + 工厂函数（依赖注入，解决 3 个 private 方法依赖 `this` 的问题）。`session-worker` 从注册表取 hook 组装，同时生成「本次实际挂载清单」回传前端。

**Files:**
- Create: `agent-sidecar/src/builtinHooks/index.ts`
- Create: `agent-sidecar/src/builtinHooks/index.test.ts`
- Modify: `agent-sidecar/src/session-worker.ts`（组装 hooks 段 954-974）

**Interfaces:**
- Produces:
  - `BuiltinHookEntry { id: string; event: "PreToolUse"|"Stop"; matcher: string; purpose: string; alwaysMounted: boolean; build: (ctx: HookBuildContext) => HookCallback | null }`
  - `HookBuildContext { cwd: string | undefined; env: NodeJS.ProcessEnv; session: SessionWorker; codegraphMounted: boolean }`
  - `BUILTIN_HOOKS: BuiltinHookEntry[]`（顺序固定：policyHook 第一）
  - `buildBuiltinHooks(ctx): { hooks: SdkHooksOption; manifest: BuiltinHookManifest[] }` — 返回组装好的 hooks 对象 + 实际挂载清单
  - `BuiltinHookManifest { id: string; event: string; matcher: string; purpose: string }`（回传前端用）

- [ ] **Step 1: 写失败测试**

```ts
// agent-sidecar/src/builtinHooks/index.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_HOOKS, buildBuiltinHooks } from "./index";

describe("builtinHooks registry", () => {
  it("policyHook 是第一条且 alwaysMounted", () => {
    const first = BUILTIN_HOOKS[0];
    expect(first.id).toBe("policy");
    expect(first.event).toBe("PreToolUse");
    expect(first.matcher).toBe(".*");
    expect(first.alwaysMounted).toBe(true);
  });

  it("顺序固定：policy → subagentModel → imageGuard → skillGuard → codegraphGrep(PreToolUse)，stopEffort(Stop)", () => {
    const pre = BUILTIN_HOOKS.filter((h) => h.event === "PreToolUse").map((h) => h.id);
    expect(pre).toEqual(["policy", "subagentModel", "imageGuard", "skillGuard", "codegraphGrep"]);
    const stop = BUILTIN_HOOKS.filter((h) => h.event === "Stop").map((h) => h.id);
    expect(stop).toEqual(["stopEffort"]);
  });

  it("每条有非空 purpose", () => {
    for (const h of BUILTIN_HOOKS) expect(h.purpose.length).toBeGreaterThan(0);
  });

  it("buildBuiltinHooks：codegraphMounted=false 时 codegraphGrep 不进 manifest 也不进 hooks", () => {
    const ctx = { cwd: "/x", env: {}, session: {} as any, codegraphMounted: false };
    const { hooks, manifest } = buildBuiltinHooks(ctx);
    const preIds = hooks.PreToolUse.map((e: any) => e.hooks[0]).map((_: any) => "fn");
    expect(hooks.PreToolUse.length).toBe(4); // policy + subagentModel + imageGuard + skillGuard（codegraph 不挂）
    expect(manifest.find((m) => m.id === "codegraphGrep")).toBeUndefined();
  });

  it("buildBuiltinHooks：policyHook 永远在 PreToolUse[0]", () => {
    const ctx = { cwd: "/x", env: {}, session: {} as any, codegraphMounted: true };
    const { hooks } = buildBuiltinHooks(ctx);
    expect(hooks.PreToolUse[0].matcher).toBe(".*");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir agent-sidecar test -- builtinHooks`
Expected: FAIL（模块不存在）。注：此步前需先建 vitest 配置 + 加 vitest devDep（见 Task 1 Step 3 前置）。若 vitest 未就绪，先执行 Step 3 的依赖安装。

- [ ] **Step 3: 装 vitest + 建配置**

```bash
# 代理可能需要：export HTTPS_PROXY=http://127.0.0.1:7890
pnpm --dir agent-sidecar add -D vitest@^4
```
```ts
// agent-sidecar/vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
```
在 `agent-sidecar/package.json` 的 `scripts` 加：
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: 实现注册表**

```ts
// agent-sidecar/src/builtinHooks/index.ts
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { makeSubagentModelHook } from "../subagentModelDefault";
import { makeSkillGuardHook } from "../skillGuard";
import { makeCodegraphGrepNudgeHook } from "../codegraphTools";

export interface HookBuildContext {
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  session: { makePolicyHook(cwd: string | undefined): HookCallback;
              makeImageGuardHook(): HookCallback; makeStopEffortHook(): HookCallback };
  codegraphMounted: boolean;
}

export interface BuiltinHookEntry {
  id: string;
  event: "PreToolUse" | "Stop";
  matcher: string; // Stop 用空串占位
  purpose: string;
  alwaysMounted: boolean;
  build: (ctx: HookBuildContext) => HookCallback | null;
}

export interface BuiltinHookManifest {
  id: string; event: string; matcher: string; purpose: string;
}

export const BUILTIN_HOOKS: BuiltinHookEntry[] = [
  { id: "policy", event: "PreToolUse", matcher: ".*",
    purpose: "工具权限门控（权威前置层，不可越过）", alwaysMounted: true,
    build: (ctx) => ctx.session.makePolicyHook(ctx.cwd) },
  { id: "subagentModel", event: "PreToolUse", matcher: "^(Agent|Task)$",
    purpose: "子代理模型选择兜底", alwaysMounted: false,
    build: (ctx) => makeSubagentModelHook(ctx.env) },
  { id: "imageGuard", event: "PreToolUse", matcher: "^Read$",
    purpose: "读图保护（image input 不可用时 deny）", alwaysMounted: true,
    build: (ctx) => ctx.session.makeImageGuardHook() },
  { id: "skillGuard", event: "PreToolUse", matcher: "^Skill$",
    purpose: "子代理重型 skill 名单拦截", alwaysMounted: false,
    build: (ctx) => makeSkillGuardHook(ctx.env) },
  { id: "codegraphGrep", event: "PreToolUse", matcher: "^Grep$",
    purpose: "Grep 符号状 pattern 时注入索引工具提示", alwaysMounted: false,
    build: (ctx) => (ctx.codegraphMounted ? makeCodegraphGrepNudgeHook() : null) },
  { id: "stopEffort", event: "Stop", matcher: "",
    purpose: "读本轮 effort 盖到 message_stop", alwaysMounted: true,
    build: (ctx) => ctx.session.makeStopEffortHook() },
];

export function buildBuiltinHooks(ctx: HookBuildContext): {
  hooks: { PreToolUse: { matcher: string; hooks: HookCallback[] }[]; Stop: { hooks: HookCallback[] }[] };
  manifest: BuiltinHookManifest[];
} {
  const pre: { matcher: string; hooks: HookCallback[] }[] = [];
  const stop: { hooks: HookCallback[] }[] = [];
  const manifest: BuiltinHookManifest[] = [];
  for (const entry of BUILTIN_HOOKS) {
    const hook = entry.build(ctx);
    if (!hook) continue;
    manifest.push({ id: entry.id, event: entry.event, matcher: entry.matcher, purpose: entry.purpose });
    if (entry.event === "PreToolUse") pre.push({ matcher: entry.matcher, hooks: [hook] });
    else stop.push({ hooks: [hook] });
  }
  return { hooks: { PreToolUse: pre, Stop: stop }, manifest };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --dir agent-sidecar test -- builtinHooks`
Expected: PASS（5/5）。

- [ ] **Step 6: 接线 session-worker**

修改 `agent-sidecar/src/session-worker.ts`：把 954-974 的 `hooks: {...}` 替换为注册表调用。在 :926 附近（构造 policyHook 后）构造 ctx，调用 `buildBuiltinHooks`。

```ts
// 替换原 954-974 段：
const { hooks: builtinHooks, manifest: builtinHookManifest } = buildBuiltinHooks({
  cwd: effectiveCwd,
  env: process.env,
  session: this as any, // makePolicyHook/makeImageGuardHook/makeStopEffortHook 是 private 方法，这里同类访问
  codegraphMounted: !!codegraphMcp,
});
// builtinHookManifest 通过 this.emit 回传前端（见 Task 3 的清单通道）
```
把原 `hooks: {...}` 改为 `hooks: builtinHooks`。删除原内联的 subagentModelHook/skillGuardHook 条件展开（已由注册表处理）。保留 :896/:899 的 `subagentModelHook`/`skillGuardHook` 变量定义可删（注册表内部调），但若其他地方引用则保留——检查后删。`makeCodegraphGrepNudgeHook` 导入保留（注册表用）。

跑 `pnpm --dir agent-sidecar build` 确认编译通过。

- [ ] **Step 7: Commit**

```bash
git add agent-sidecar/src/builtinHooks/ agent-sidecar/vitest.config.ts agent-sidecar/package.json agent-sidecar/src/session-worker.ts
git commit -m "refactor(sidecar): 内建 hook 抽 builtinHooks 注册表（工厂+依赖注入）"
```

---

## Task 2: userExtensions.ts（读 settings.json 注入）

新增 sidecar 模块，读 `CLAUDE_CONFIG_DIR/settings.json` 的 `mcpServers`/`hooks`，过滤 disabled，错误隔离，返回可直接 merge 的对象。

**Files:**
- Create: `agent-sidecar/src/userExtensions.ts`
- Create: `agent-sidecar/src/userExtensions.test.ts`

**Interfaces:**
- Produces:
  - `loadUserMcpServers(): Record<string, any>` — 过滤 `disabled:true` 后的用户 MCP config（stdio/sse/http 原样透传）
  - `loadUserHooks(): { PreToolUse?: {matcher:string;hooks:any[]}[]; Stop?: {hooks:any[]}[]; PostToolUse?: ...; Notification?: ... }` — 过滤 disabled 的用户 hook，按事件分组（SDK hooks option 形状）
- Consumes: `CLAUDE_CONFIG_DIR` env（fallback `homedir()/.aide/claude`，与 dispatchPlugins.ts:79 同源）

- [ ] **Step 1: 写失败测试**

```ts
// agent-sidecar/src/userExtensions.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserMcpServers, loadUserHooks } from "./userExtensions";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aide-ext-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.CLAUDE_CONFIG_DIR; });

function writeSettings(obj: any) { writeFileSync(join(dir, "settings.json"), JSON.stringify(obj)); }

describe("loadUserMcpServers", () => {
  it("文件不存在返回空对象", () => { expect(loadUserMcpServers()).toEqual({}); });
  it("损坏 JSON 返回空对象不抛", () => {
    writeFileSync(join(dir, "settings.json"), "{not json");
    expect(loadUserMcpServers()).toEqual({});
  });
  it("过滤 disabled:true", () => {
    writeSettings({ mcpServers: { a: { command: "x" }, b: { command: "y", disabled: true } } });
    expect(loadUserMcpServers()).toEqual({ a: { command: "x" } });
  });
  it("原样保留 sse/http 格式", () => {
    writeSettings({ mcpServers: { s: { type: "sse", url: "http://x" } } });
    expect(loadUserMcpServers()).toEqual({ s: { type: "sse", url: "http://x" } });
  });
  it("无 mcpServers 键返回空", () => { writeSettings({}); expect(loadUserMcpServers()).toEqual({}); });
});

describe("loadUserHooks", () => {
  it("过滤 disabled 的 hook 条目", () => {
    writeSettings({ hooks: { PostToolUse: [
      { matcher: "^Bash$", hooks: [{ type: "command", command: "x" }] },
      { matcher: "^Read$", hooks: [{ type: "command", command: "y" }], disabled: true },
    ] } });
    const h = loadUserHooks();
    expect(h.PostToolUse?.length).toBe(1);
    expect(h.PostToolUse?.[0].matcher).toBe("^Bash$");
  });
  it("无 hooks 键返回空对象", () => { writeSettings({}); expect(loadUserHooks()).toEqual({}); });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --dir agent-sidecar test -- userExtensions`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// agent-sidecar/src/userExtensions.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function settingsFile(): string {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".aide", "claude");
  return join(home, "settings.json");
}

function readSettings(): Record<string, any> {
  const p = settingsFile();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")) ?? {}; }
  catch { return {}; } // 损坏 → 空，不阻断会话
}

/** 过滤 disabled:true 的 mcpServer，原样透传 config（stdio/sse/http）。 */
export function loadUserMcpServers(): Record<string, any> {
  const servers = readSettings().mcpServers;
  if (!servers || typeof servers !== "object") return {};
  const out: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(servers as Record<string, any>)) {
    if (cfg && cfg.disabled === true) continue; // sidecar 过滤，SDK 不认 disabled
    out[name] = cfg;
  }
  return out;
}

type HookEntry = { matcher?: string; hooks: any[]; disabled?: boolean };
type HooksByEvent = Record<string, { matcher?: string; hooks: any[] }[]>;

/** 过滤 disabled 的 hook 条目，按事件分组（SDK hooks option 形状）。 */
export function loadUserHooks(): HooksByEvent {
  const hooks = readSettings().hooks;
  if (!hooks || typeof hooks !== "object") return {};
  const out: HooksByEvent = {};
  for (const [event, entries] of Object.entries(hooks as Record<string, HookEntry[]>)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => e && e.disabled !== true && Array.isArray(e.hooks) && e.hooks.length > 0);
    if (kept.length > 0) out[event] = kept.map((e) => ({ matcher: e.matcher, hooks: e.hooks }));
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --dir agent-sidecar test -- userExtensions`
Expected: PASS（7/7）。

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/userExtensions.ts agent-sidecar/src/userExtensions.test.ts
git commit -m "feat(sidecar): userExtensions 读取 settings.json 的 mcpServers/hooks（过滤 disabled、错误隔离）"
```

---

## Task 3: session-worker 接线（merge options + 内建清单回传）

把 userExtensions 的结果 merge 进 query options：`mcpServers` 与 codegraph 合并，`hooks` 内建在前 + 用户追加。同时把内建 hook manifest 回传前端（Task 8 的 hook 列表用）。

**Files:**
- Modify: `agent-sidecar/src/session-worker.ts`（options 组装段 928-998）

**Interfaces:**
- Consumes: `loadUserMcpServers()`、`loadUserHooks()`（Task 2）、`buildBuiltinHooks()`（Task 1）
- Produces: 经 `this.emit` 发出一个 `builtin_hooks_manifest` 事件（payload: `BuiltinHookManifest[]`）

- [ ] **Step 1: 写失败测试（接线行为）**

接线测试用集成断言：mock `loadUserMcpServers`/`loadUserHooks` 返回值，断言 `queryFn` 收到的 options.mcpServers/hooks 含用户项 + 内建在前。

```ts
// agent-sidecar/src/session-worker.test.ts（新建，仅测 options 组装逻辑）
// session-worker 依赖重，本测试聚焦：抽一个纯函数 assembleExtensions() 做 merge，
// 在 session-worker 调用它，单测它即可（避免拉起整个 SessionWorker）。
```
> 实现策略：把 merge 逻辑抽成纯函数 `assembleMcpServers(codegraph, user)` 和 `assembleHooks(builtin, user)` 放 `userExtensions.ts`，session-worker 调用，单测纯函数。

- [ ] **Step 2: 在 userExtensions.ts 加 merge 纯函数 + 测试**

```ts
// 追加到 userExtensions.ts
/** 合并 codegraph（in-process）与用户 mcpServers（stdio/sse/http），name 不冲突即可。 */
export function assembleMcpServers(codegraph: Record<string, any> | null, user: Record<string, any>): Record<string, any> {
  return { ...(codegraph ?? {}), ...user };
}

/** 合并内建 hook（前）与用户 hook（后），按事件分组。内建不可被越过。 */
export function assembleHooks(builtin: { PreToolUse: any[]; Stop: any[] }, user: Record<string, any>): Record<string, any> {
  const events = new Set<string>(["PreToolUse", "Stop", ...Object.keys(user)]);
  const out: Record<string, any> = {};
  for (const ev of events) {
    const b = (builtin as any)[ev] ?? [];
    const u = user[ev] ?? [];
    const merged = [...b, ...u];
    if (merged.length > 0) out[ev] = merged;
  }
  return out;
}
```
在 `userExtensions.test.ts` 加 `assembleMcpServers`/`assembleHooks` 测试：用户 hook 排在内建后、codegraph 与用户合并 name 共存、用户 hook 不进 PreToolUse[0]。

- [ ] **Step 3: 跑测试**

Run: `pnpm --dir agent-sidecar test -- userExtensions`
Expected: PASS。

- [ ] **Step 4: session-worker 接线**

修改 `session-worker.ts` options 组装（替换 Task 1 Step 6 留下的 `hooks: builtinHooks`）：

```ts
import { loadUserMcpServers, loadUserHooks, assembleMcpServers, assembleHooks } from "./userExtensions";

// 在 queryFn 调用前：
const userMcp = loadUserMcpServers();
const userHooks = loadUserHooks();
const { hooks: builtinHooks, manifest: builtinHookManifest } = buildBuiltinHooks({ ... }); // Task 1

// options 内：
mcpServers: assembleMcpServers(codegraphMcp ?? null, userMcp),
hooks: assembleHooks(builtinHooks, userHooks),

// 回传前端（在 query 启动后 emit 一次）：
this.emit({ type: "builtin_hooks_manifest", manifest: builtinHookManifest } as any);
```
删除原 `...(codegraphMcp ? { mcpServers: codegraphMcp as any } : {})` 行（被 assembleMcpServers 取代）。

- [ ] **Step 5: 构建验证**

Run: `pnpm --dir agent-sidecar build`
Expected: 编译通过，无 TS 错误。

- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/src/session-worker.ts agent-sidecar/src/userExtensions.ts agent-sidecar/src/userExtensions.test.ts
git commit -m "feat(sidecar): options 接入用户 mcpServers/hooks，内建在前+用户追加，回传内置清单"
```

---

## Task 4: Rust mcp_server 透传改造

`create_mcp_server`/`update_mcp_server` 从硬编码 `command/args/env` 改为整体透传 config 对象（支持 stdio/sse/http），保留 disabled 处理。

**Files:**
- Modify: `src-tauri/src/commands/customizations.rs`（`create_mcp_server`:735-767、`update_mcp_server`:769-792）
- Modify: `src-tauri/src/commands/customizations.rs` 顶部 `CustomizationItem` 不变（metadata 已是 Value）

**Interfaces:**
- Consumes: 前端传 `data: { name, transport: "stdio"|"sse"|"http", command?, args?, env?, url?, headers?, disabled? }`
- Produces: settings.json 的 `mcpServers[name]` = 整个 config 对象（去掉 disabled，toggle 单独管）

- [ ] **Step 1: 写失败测试（Rust 单元测试）**

```rust
// src-tauri/src/commands/customizations.rs 末尾
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn build_mcp_config_stdio() {
        let data = serde_json::json!({ "transport": "stdio", "command": "npx", "args": ["-y", "srv"], "env": {} });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["command"], "npx");
        assert!(cfg["args"].is_array());
        assert!(!cfg.as_object().unwrap().contains_key("disabled"));
    }
    #[test]
    fn build_mcp_config_sse_strips_transport_key() {
        let data = serde_json::json!({ "transport": "sse", "url": "http://x/sse" });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["url"], "http://x/sse");
        assert!(!cfg.as_object().unwrap().contains_key("transport")); // transport 是前端 UI 字段，不写入 settings
    }
    #[test]
    fn build_mcp_config_http() {
        let data = serde_json::json!({ "transport": "http", "url": "http://x/mcp", "headers": { "Authorization": "Bearer k" } });
        let cfg = build_mcp_config(&data);
        assert_eq!(cfg["url"], "http://x/mcp");
        assert_eq!(cfg["headers"]["Authorization"], "Bearer k");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test build_mcp_config`
Expected: FAIL（函数不存在）。

- [ ] **Step 3: 实现 build_mcp_config + 改造 create/update**

```rust
/// 从前端 data 构造写入 settings.json 的 mcpServer config。
/// 剥离前端 UI 字段（transport/disabled/name），保留 SDK 认的传输字段。
fn build_mcp_config(data: &serde_json::Value) -> serde_json::Value {
    let mut cfg = serde_json::Map::new();
    if let Some(obj) = data.as_object() {
        for (k, v) in obj {
            if k == "name" || k == "transport" || k == "disabled" { continue; }
            // 跳过 null/空字段，保持 settings 干净
            if v.is_null() { continue; }
            if k == "env" { if let Some(e) = v.as_object() { if e.is_empty() { continue; } } }
            if k == "args" { if let Some(a) = v.as_array() { if a.is_empty() { continue; } } }
            cfg.insert(k.clone(), v.clone());
        }
    }
    serde_json::Value::Object(cfg)
}

#[tauri::command]
pub async fn create_mcp_server(data: serde_json::Value) -> Result<CustomizationItem, String> {
    let name = data["name"].as_str().unwrap_or("unnamed").to_string();
    let cfg = build_mcp_config(&data);
    let mut settings = load_settings();
    settings.as_object_mut().unwrap().entry("mcpServers").or_insert_with(|| serde_json::json!({}));
    settings["mcpServers"][&name] = cfg.clone();
    save_settings(&settings)?;
    Ok(CustomizationItem {
        id: name.clone(), name, r#type: "mcp_server".to_string(), enabled: true,
        path: settings_path().to_string_lossy().to_string(),
        description: Some(describe_mcp(&cfg)), metadata: Some(cfg),
    })
}

fn describe_mcp(cfg: &serde_json::Value) -> String {
    if let Some(c) = cfg.get("command").and_then(|v| v.as_str()) {
        let args = cfg.get("args").and_then(|a| a.as_array())
            .map(|v| v.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        format!("{} {}", c, args)
    } else if let Some(u) = cfg.get("url").and_then(|v| v.as_str()) {
        let t = if cfg.get("headers").is_some() { "http" } else { "sse" };
        format!("{} {}", t, u)
    } else { String::new() }
}

#[tauri::command]
pub async fn update_mcp_server(id: String, data: serde_json::Value) -> Result<(), String> {
    let cfg = build_mcp_config(&data);
    let mut settings = load_settings();
    if let Some(servers) = settings.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        // 保留原 disabled 状态（toggle 单独管），其余整体替换
        let disabled = servers.get(&id).and_then(|c| c.get("disabled")).cloned();
        let mut new_cfg = cfg;
        if let Some(d) = disabled { if let Some(obj) = new_cfg.as_object_mut() { obj.insert("disabled".into(), d); } }
        servers.insert(id, new_cfg);
    }
    save_settings(&settings)
}
```
> 注意：`create_mcp_server`/`update_mcp_server` 改 `async fn`（CLAUDE.md 红线：文件 IO 重应 async）。`lib.rs` 注册不变（Tauri async command 自动支持）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test build_mcp_config`
Expected: PASS（3/3）。

- [ ] **Step 5: 编译 + clippy**

Run: `cd src-tauri && cargo build`
Expected: 编译通过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/customizations.rs
git commit -m "refactor(customizations): create/update_mcp_server 整体透传 config（支持 stdio/sse/http）"
```

---

## Task 5: Rust skill_script 三命令

新增 `read_skill_script`/`write_skill_script`/`delete_skill_script` 三个 async command，读写 `<skill>/scripts/<filename>`，限文件名防 `../` 越界。

**Files:**
- Modify: `src-tauri/src/commands/customizations.rs`（末尾追加）
- Modify: `src-tauri/src/lib.rs`（312-328 段后注册）

**Interfaces:**
- Produces:
  - `read_skill_script(skill_id: String, filename: String) -> Result<String, String>`
  - `write_skill_script(skill_id: String, filename: String, content: String) -> Result<(), String>`
  - `delete_skill_script(skill_id: String, filename: String) -> Result<(), String>`

- [ ] **Step 1: 写失败测试**

```rust
// 在 #[cfg(test)] mod tests 内追加
#[test]
fn sanitize_script_filename_rejects_traversal() {
    assert!(sanitize_script_filename("build.sh").is_ok());
    assert!(sanitize_script_filename("../evil").is_err());
    assert!(sanitize_script_filename("a/b").is_err());
    assert!(sanitize_script_filename("").is_err());
    assert!(sanitize_script_filename(".gitignore").is_err()); // 防隐藏/敏感
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test sanitize_script_filename`
Expected: FAIL。

- [ ] **Step 3: 实现**

```rust
/// 校验脚本文件名：单段、非空、非隐藏、无路径分隔/越界。
fn sanitize_script_filename(name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid script filename".into());
    }
    if name.starts_with('.') { return Err("hidden file not allowed".into()); }
    // 仅允许字母数字下划点连
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-') {
        return Err("filename contains invalid chars".into());
    }
    Ok(name.to_string())
}

fn script_path(skill_id: &str, filename: &str) -> Result<std::path::PathBuf, String> {
    let safe = sanitize_script_filename(filename)?;
    let p = skills_dir().join(skill_id).join("scripts").join(safe);
    // 防止 skill_id 越界
    if !p.starts_with(skills_dir()) { return Err("path escape".into()); }
    Ok(p)
}

#[tauri::command]
pub async fn read_skill_script(skill_id: String, filename: String) -> Result<String, String> {
    let p = script_path(&skill_id, &filename)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_skill_script(skill_id: String, filename: String, content: String) -> Result<(), String> {
    let p = script_path(&skill_id, &filename)?;
    if let Some(parent) = p.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::write(&p, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_skill_script(skill_id: String, filename: String) -> Result<(), String> {
    let p = script_path(&skill_id, &filename)?;
    if p.exists() { fs::remove_file(&p).map_err(|e| e.to_string())?; }
    Ok(())
}
```

- [ ] **Step 4: 注册命令**

在 `src-tauri/src/lib.rs` 的 `commands::customizations::toggle_mcp_server,`（:328）后追加：
```rust
commands::customizations::read_skill_script,
commands::customizations::write_skill_script,
commands::customizations::delete_skill_script,
```

- [ ] **Step 5: 跑测试 + 编译**

Run: `cd src-tauri && cargo test sanitize_script_filename && cargo build`
Expected: 测试 PASS，编译通过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/customizations.rs src-tauri/src/lib.rs
git commit -m "feat(customizations): read/write/delete_skill_script 三命令（限文件名防越界）"
```

---

## Task 6: Rust test_mcp_connection command

新增 async command，spawn `agent-runtime` 跑 `test-mcp.ts` 探活，收集 stdout JSON 返回。Windows 加 CREATE_NO_WINDOW + dunce 路径处理。

**Files:**
- Modify: `src-tauri/src/commands/customizations.rs`（追加 `test_mcp_connection`）
- Modify: `src-tauri/src/lib.rs`（注册）
- Reference: `src-tauri/src/runtime.rs` 的 `resolve_runtime_path`（agent-runtime exe 路径解析，仿它）

**Interfaces:**
- Produces: `test_mcp_connection(config: serde_json::Value) -> Result<TestResult, String>`
  - `TestResult { status: "ok"|"timeout"|"spawn_error"|"handshake_error"|"connect_error", tools: Vec<String>, error: Option<String>, duration_ms: u64 }`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn testresult_serializes_status() {
        let r = TestResult { status: "ok".into(), tools: vec!["a".into()], error: None, duration_ms: 10 };
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["status"], "ok");
        assert_eq!(j["tools"][0], "a");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test testresult_serializes`
Expected: FAIL（类型不存在）。

- [ ] **Step 3: 实现**

```rust
#[derive(Debug, Serialize)]
pub struct TestResult {
    pub status: String,
    pub tools: Vec<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// spawn agent-runtime 跑 test-mcp.ts 探活，解析 stdout JSON 返回。
/// config = { transport, command?, args?, env?, url?, headers? }
#[tauri::command]
pub async fn test_mcp_connection(config: serde_json::Value) -> Result<TestResult, String> {
    use std::process::Command;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    // 解析 agent-runtime exe 路径（仿 runtime.rs::resolve_runtime_path）
    let exe = resolve_agent_runtime_exe()?; // 见下方 helper
    let config_str = serde_json::to_string(&config).map_err(|e| e.to_string())?;

    let start = std::time::Instant::now();
    let mut cmd = Command::new(&exe);
    cmd.arg("test-mcp").arg(&config_str);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); } // CREATE_NO_WINDOW 红线
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let out = tokio::task::spawn_blocking(move || cmd.output())
        .await.map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let duration_ms = start.elapsed().as_millis() as u64;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Ok(TestResult { status: "spawn_error".into(), tools: vec![], error: Some(err), duration_ms });
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    // test-mcp.ts 输出一行 JSON：{"status":"ok","tools":[...]}
    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(v) => Ok(TestResult {
            status: v["status"].as_str().unwrap_or("handshake_error").to_string(),
            tools: v["tools"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default(),
            error: v["error"].as_str().map(String::from),
            duration_ms,
        }),
        Err(e) => Ok(TestResult { status: "handshake_error".into(), tools: vec![], error: Some(format!("{}: {}", e, stdout)), duration_ms }),
    }
}

/// 解析 agent-runtime 可执行文件路径。仿 runtime.rs::resolve_runtime_path，
/// 用 dunce::simplified 剥 \\?\ 前缀（CLAUDE.md 红线 2）。
fn resolve_agent_runtime_exe() -> Result<std::path::PathBuf, String> {
    // dev: CARGO_MANIFEST_DIR/../agent-sidecar/dist/aide-agent.exe（或 .exe 不存在时回退 node + runtime.js）
    // release: resource_dir/agent-runtime/aide-agent.exe
    // 实施时复用 runtime.rs 现有 resolve 逻辑，导出供此处调用，避免重复。
    // 若 runtime.rs 已有 pub fn，直接 use；否则提取共用。
    crate::runtime::resolve_agent_runtime_for_test().map_err(|e| e.to_string())
}
```
> 实施注：`resolve_agent_runtime_for_test` 在 `runtime.rs` 新增或复用现有 `resolve_runtime_path`。先 Read `runtime.rs` 确认现有函数，优先复用；若现有函数签名不适配，加一个 thin wrapper 导出。路径返回前 `dunce::simplified(&path).to_path_buf()`。

- [ ] **Step 4: 注册命令**

`src-tauri/src/lib.rs` 在 `delete_skill_script,` 后追加 `commands::customizations::test_mcp_connection,`。确认 `tokio` 在依赖里（项目已用 tokio，SessionManager 同款）。

- [ ] **Step 5: 跑测试 + 编译**

Run: `cd src-tauri && cargo test testresult && cargo build`
Expected: 测试 PASS，编译通过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/customizations.rs src-tauri/src/lib.rs src-tauri/src/runtime.rs
git commit -m "feat(customizations): test_mcp_connection 探活 command（spawn agent-runtime、CREATE_NO_WINDOW、dunce）"
```

---

## Task 7: test-mcp.ts 探活入口

仿 `smoke-mcp.ts` 放 `agent-sidecar/` 根目录。用 `@modelcontextprotocol/sdk` 的 Client + 三种 transport 握手，输出一行 JSON 退出。

**Files:**
- Create: `agent-sidecar/test-mcp.ts`
- Modify: `agent-sidecar/package.json`（加 `@modelcontextprotocol/sdk` dep）

**Interfaces:**
- Consumes: 命令行 argv[2] = JSON string `{ transport, command?, args?, env?, url?, headers? }`
- Produces: stdout 一行 JSON `{ status, tools, error }`，退出码 0

- [ ] **Step 1: 装 @modelcontextprotocol/sdk**

```bash
# 代理可能需要：export HTTPS_PROXY=http://127.0.0.1:7890
pnpm --dir agent-sidecar add @modelcontextprotocol/sdk
```
确认版本装上后，Read `agent-sidecar/node_modules/@modelcontextprotocol/sdk/dist/index.d.ts` 确认 `Client`、`StdioClientTransport`、`SSEClientTransport`、`StreamableHTTPClientTransport` 导出名（版本间可能有差异，按实际导出调整 Step 3 import）。

- [ ] **Step 2: 实现 test-mcp.ts**

```ts
// agent-sidecar/test-mcp.ts —— 一次性探活，被 Rust test_mcp_connection spawn 调用。
// 入参：argv[2] = JSON string { transport, command?, args?, env?, url?, headers? }
// 出参：stdout 一行 JSON { status, tools, error }，退出码 0
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TIMEOUT_MS = 10_000;

async function main() {
  const cfg = JSON.parse(process.argv[2] ?? "{}");
  const client = new Client({ name: "aide-test-mcp", version: "1.0" }, { capabilities: {} });
  let transport: any;
  if (cfg.transport === "stdio") {
    transport = new StdioClientTransport({
      command: cfg.command, args: cfg.args ?? [], env: cfg.env,
    });
  } else if (cfg.transport === "sse") {
    transport = new SSEClientTransport(new URL(cfg.url));
  } else if (cfg.transport === "http") {
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
    });
  } else {
    process.stdout.write(JSON.stringify({ status: "handshake_error", tools: [], error: "unknown transport" }));
    return;
  }

  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS));
  try {
    await Promise.race([client.connect(transport), timer]);
    const { tools } = await Promise.race([client.listTools(), timer]);
    process.stdout.write(JSON.stringify({ status: "ok", tools: (tools ?? []).map((t: any) => t.name) }));
    try { await client.close(); } catch {}
  } catch (e: any) {
    const status = e?.message === "timeout" ? "timeout"
      : /spawn|ENOENT/.test(String(e?.message ?? "")) ? "spawn_error"
      : /connect|ECONNREFused|fetch/i.test(String(e?.message ?? "")) ? "connect_error"
      : "handshake_error";
    process.stdout.write(JSON.stringify({ status, tools: [], error: String(e?.message ?? e) }));
    try { await client.close(); } catch {}
  }
}
main();
```

- [ ] **Step 3: 手动验证（stdio）**

Run（在 agent-sidecar 下，用任意已装 MCP server 测）:
```bash
cd agent-sidecar && npx tsx test-mcp.ts '{"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"],"env":{}}'
```
Expected: 输出 `{"status":"ok","tools":["read_file","write_file",...]}`（filesystem server 工具清单）。若 server 未缓存首次可能慢，超时则换已知本地 server 或加大 args。

- [ ] **Step 4: 手动验证（http/sse，若有可用端点）**

若本地无可用 sse/http MCP，跳过自动验证，标注人工验证。否则：
```bash
npx tsx test-mcp.ts '{"transport":"http","url":"http://localhost:8080/mcp"}'
```
Expected: `{"status":"ok",...}` 或 `{"status":"connect_error",...}`（看端点是否在）。

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/test-mcp.ts agent-sidecar/package.json agent-sidecar/pnpm-lock.yaml
git commit -m "feat(sidecar): test-mcp.ts 探活入口（stdio/sse/http 三种 transport、握手只读无副作用）"
```

---

## Task 8: CustomizationDetail 门面 + 来源 badge + useCustomizations 补 source

`CustomizationDetail.vue` 退化为按 type 分派到对应 editor 的门面。`CustomizationList.vue` 行加来源 badge。`useCustomizations`/`CustomizationItem` 加 `source` 字段。

**Files:**
- Modify: `src/types/customization.ts`（`CustomizationItem` 加 `source`，`McpServer` 加 `transport`+条件字段）
- Modify: `src/composables/useCustomizations.ts`（list 项带 source；hook 列表合并内置 manifest）
- Modify: `src/components/customizations/CustomizationDetail.vue`（退化为门面）
- Modify: `src/components/customizations/CustomizationList.vue`（来源 badge）
- Test: `src/components/customizations/CustomizationDetail.test.ts`

**Interfaces:**
- Produces:
  - `CustomizationItem.source: "user" | "project" | "plugin" | "builtin"`（可选，缺省按 type 推导）
  - `McpServer.transport: "stdio" | "sse" | "http"`
  - `CustomizationDetail` props 不变（`type`/`item`），内部按 type 渲染 `editors/<Type>Editor`

- [ ] **Step 1: 写失败测试**

```ts
// src/components/customizations/CustomizationDetail.test.ts
import { mount } from "@vue/test-utils";
import { describe, it, expect } from "vitest";
import CustomizationDetail from "./CustomizationDetail.vue";
import type { CustomizationItem } from "../../types/customization";

const mkItem = (type: any): CustomizationItem => ({ id: "x", name: "x", type, enabled: true, path: "", source: "user" });

describe("CustomizationDetail 门面", () => {
  it("type=mcp_server 渲染 McpServerEditor", () => {
    const w = mount(CustomizationDetail, { props: { type: "mcp_server", item: mkItem("mcp_server") } });
    expect(w.findComponent({ name: "McpServerEditor" }).exists()).toBe(true);
  });
  it("type=hook 渲染 HookEditor", () => {
    const w = mount(CustomizationDetail, { props: { type: "hook", item: mkItem("hook") } });
    expect(w.findComponent({ name: "HookEditor" }).exists()).toBe(true);
  });
  it("透传 item 给子 editor", () => {
    const w = mount(CustomizationDetail, { props: { type: "mcp_server", item: mkItem("mcp_server") } });
    expect(w.findComponent({ name: "McpServerEditor" }).props("item")).toBeTruthy();
  });
});
```
> 注：此测试在 Task 9-12 的 editor 组件存在后才能通过。本任务先建门面 + 占位（editor 未实现时门面 import 会报错），**先做 Task 9 McpServerEditor 再回头跑此测试**，或本任务 Step 3 先建 5 个 editor 的最小占位骨架（仅 `defineOptions({name})` + props），后续任务填充。采用占位骨架方案。

- [ ] **Step 2: 扩展类型**

```ts
// src/types/customization.ts —— CustomizationItem 加 source
export interface CustomizationItem {
  id: string; name: string; type: CustomizationType; enabled: boolean; path: string;
  description?: string; metadata?: Record<string, any>;
  source?: "user" | "project" | "plugin" | "builtin";
}
// McpServer 扩展（stdio/sse/http）
export interface McpServer extends CustomizationItem {
  type: "mcp_server";
  transport: "stdio" | "sse" | "http";
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
}
```

- [ ] **Step 3: 建 5 个 editor 占位骨架**

每个文件 `src/components/customizations/editors/<Name>Editor.vue`：
```vue
<script setup lang="ts">
import type { CustomizationItem } from "../../../types/customization";
defineOptions({ name: "McpServerEditor" }); // 名字对应改
defineProps<{ item: CustomizationItem | null }>();
defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();
</script>
<template><div class="editor-placeholder" /></template>
```
建 `McpServerEditor`/`HookEditor`/`SkillEditor`/`AgentEditor`/`InstructionEditor` 5 个（name 各异）。后续 Task 9-12 填充。

- [ ] **Step 4: CustomizationDetail 退化为门面**

```vue
<script setup lang="ts">
import type { CustomizationType, CustomizationItem } from "../../types/customization";
import McpServerEditor from "./editors/McpServerEditor.vue";
import HookEditor from "./editors/HookEditor.vue";
import SkillEditor from "./editors/SkillEditor.vue";
import AgentEditor from "./editors/AgentEditor.vue";
import InstructionEditor from "./editors/InstructionEditor.vue";

const props = defineProps<{ type: CustomizationType; item: CustomizationItem | null }>();
const emit = defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();
const EMITS = { onupdate: (d: any) => emit("update", d), ondelete: () => emit("delete"), onback: () => emit("back") };
</script>
<template>
  <McpServerEditor v-if="type === 'mcp_server'" :item="item" @update="EMITS.onupdate" @delete="EMITS.ondelete" @back="EMITS.onback" />
  <HookEditor v-else-if="type === 'hook'" :item="item" @update="EMITS.onupdate" @delete="EMITS.ondelete" @back="EMITS.onback" />
  <SkillEditor v-else-if="type === 'skill'" :item="item" @update="EMITS.onupdate" @delete="EMITS.ondelete" @back="EMITS.onback" />
  <AgentEditor v-else-if="type === 'agent'" :item="item" @update="EMITS.onupdate" @delete="EMITS.ondelete" @back="EMITS.onback" />
  <InstructionEditor v-else-if="type === 'instruction'" :item="item" @update="EMITS.onupdate" @delete="EMITS.ondelete" @back="EMITS.onback" />
</template>
```
删除原 name/description 输入框 + slot 逻辑（下沉到各 editor）。删除原 `<style>` 大段（editor 自带样式）。

- [ ] **Step 5: CustomizationList 加来源 badge**

在 `CustomizationList.vue` 的 `.item-info` 后加：
```vue
<span class="src-badge" :class="`src-${item.source ?? 'user'}`" v-if="item.source">
  {{ item.source === 'builtin' ? '内置' : item.source === 'project' ? '项目' : item.source === 'plugin' ? '插件' : '用户' }}
</span>
```
加 `.src-badge` 样式（用 `var(--aide-*)`，info/ok/warning/muted 对应 user/project/plugin/builtin）。

- [ ] **Step 6: useCustomizations 补 source 推导**

`loadItems` 后给每项补 `source`（Rust `list_*` 暂未返回 source，前端按 path 推导：含 `.claude-agent-sdk/plugins/cache` → `plugin`，含 `.aide/claude` → `user`，含 cwd → `project`；hook 的内置项由 Task 10 的 manifest 通道单独合并）。在 `loadItems` 内 map：
```ts
items[type] = (await customizationApi.list(type)).map(it => ({ ...it, source: it.source ?? deriveSource(it.path) }));
```
`deriveSource(path)` 简单实现：`path.includes("plugins/cache") ? "plugin" : "user"`。

- [ ] **Step 7: 跑测试**

Run: `pnpm test -- CustomizationDetail`
Expected: PASS（3/3，门面分派正确）。注意 jsdom 下 `isVisible()` 不可靠（项目记忆 [[jsdom-vshow-isvisible-unreliable]]），本测试用 `findComponent` 不涉及 v-show，安全。

- [ ] **Step 8: Commit**

```bash
git add src/types/customization.ts src/composables/useCustomizations.ts src/components/customizations/
git commit -m "feat(customizations): CustomizationDetail 退化为门面、CustomizationList 加来源 badge、类型扩展 source/transport"
```

---

## Task 9: McpServerEditor

实现 MCP editor：传输类型切换（stdio/sse/http）+ 条件字段 + 状态灯 + 测试连接按钮。

**Files:**
- Modify: `src/components/customizations/editors/McpServerEditor.vue`
- Modify: `src/api/customization.ts`（加 `testMcpConnection`）
- Test: `src/components/customizations/editors/McpServerEditor.test.ts`

**Interfaces:**
- Consumes: `customizationApi.update("mcp_server", id, data)`、`testMcpConnection(config)`（新增）
- Produces: emit `update` payload `{ transport, command?, args?, env?, url?, headers? }`

- [ ] **Step 1: 写失败测试**

```ts
// src/components/customizations/editors/McpServerEditor.test.ts
import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi } from "vitest";
import McpServerEditor from "./McpServerEditor.vue";

vi.mock("../../../api/customization", () => ({
  customizationApi: { update: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
  testMcpConnection: vi.fn().mockResolvedValue({ status: "ok", tools: ["a", "b"] }),
}));

const item = { id: "x", name: "playwright", type: "mcp_server", enabled: true, path: "", source: "user",
  transport: "stdio", command: "npx", args: ["-y", "srv"], env: {} };

describe("McpServerEditor", () => {
  it("stdio 渲染 command/args/env", () => {
    const w = mount(McpServerEditor, { props: { item } });
    expect(w.find('input[value="npx"]').exists() || w.html()).toContain("npx");
    expect(w.text()).toContain("command");
  });
  it("切到 sse 隐藏 command，显示 url", async () => {
    const w = mount(McpServerEditor, { props: { item } });
    await w.findAllComponents({ name: "Segmented" }).length; // 或按按钮
    // 触发传输切换到 sse
    const sseBtn = w.findAll("button").find(b => b.text() === "sse")!;
    await sseBtn.trigger("click");
    expect(w.text()).toContain("url");
    expect(w.text()).not.toContain("command");
  });
  it("测试连接点亮绿灯", async () => {
    const w = mount(McpServerEditor, { props: { item } });
    await w.find("button.test-conn").trigger("click");
    await flushPromises();
    expect(w.find(".dot-ok").exists()).toBe(true);
    expect(w.text()).toContain("2 工具");
  });
  it("插件来源只读（无保存/测试按钮）", () => {
    const w = mount(McpServerEditor, { props: { item: { ...item, source: "builtin" } } });
    expect(w.find("button.test-conn").exists()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- McpServerEditor`
Expected: FAIL（占位骨架无内容）。

- [ ] **Step 3: 加 testMcpConnection API**

```ts
// src/api/customization.ts 追加
export function testMcpConnection(config: Record<string, any>): Promise<{
  status: "ok" | "timeout" | "spawn_error" | "handshake_error" | "connect_error";
  tools: string[]; error?: string; duration_ms: number;
}> {
  return invoke("test_mcp_connection", { config });
}
```

- [ ] **Step 4: 实现 McpServerEditor**

完整实现 `<script setup>`（transport 状态 + formData + 测试连接逻辑：状态灯 unk→spin→ok/fail）+ `<template>`（传输类型 seg + 条件字段 + 状态灯 + 测试连接 + 保存/删除）+ `<style>`（用 `var(--aide-*)`）。骨架：
```vue
<script setup lang="ts">
import { ref, reactive, computed } from "vue";
import type { CustomizationItem, McpServer } from "../../../types/customization";
import { customizationApi, testMcpConnection } from "../../../api/customization";
const props = defineProps<{ item: CustomizationItem | null }>();
const emit = defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();
const readOnly = computed(() => props.item?.source === "builtin" || props.item?.source === "plugin");
const form = reactive<any>({ transport: "stdio", command: "", args: [], env: {}, url: "", headers: {}, ...(props.item as any) });
const status = ref<"unk"|"spin"|"ok"|"fail">("unk");
const toolsCount = ref(0);
const errMsg = ref("");
async function testConn() {
  status.value = "spin";
  try {
    const r = await testMcpConnection({ transport: form.transport, command: form.command, args: form.args, env: form.env, url: form.url, headers: form.headers });
    status.value = r.status === "ok" ? "ok" : "fail";
    toolsCount.value = r.tools.length; errMsg.value = r.error ?? "";
  } catch (e: any) { status.value = "fail"; errMsg.value = String(e); }
}
function save() { emit("update", { transport: form.transport, command: form.command, args: form.args, env: form.env, url: form.url, headers: form.headers }); }
function del() { emit("delete"); }
</script>
```
template：stdio 显示 command/args(每行一个 textarea)/env(key-value)；sse 显示 url；http 显示 url/headers。状态灯 `.dot .dot-unk/.dot-spin/.dot-ok/.dot-fail`。测试连接按钮 `class="test-conn"`。readOnly 时隐藏保存/测试连接、显示「只读」提示。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- McpServerEditor`
Expected: PASS（4/4）。

- [ ] **Step 6: Commit**

```bash
git add src/components/customizations/editors/McpServerEditor.vue src/components/customizations/editors/McpServerEditor.test.ts src/api/customization.ts
git commit -m "feat(customizations): McpServerEditor（stdio/sse/http 条件字段 + 状态灯 + 测试连接）"
```

---

## Task 10: HookEditor + 内置 hook 只读展示

Hook editor：event/matcher/command/timeout/asyncRewake 字段。hook 列表合并内置 hook manifest（只读，分区展示）。

**Files:**
- Modify: `src/components/customizations/editors/HookEditor.vue`
- Modify: `src/composables/useCustomizations.ts`（hook 列表合并内置 manifest）
- Modify: `src/components/customizations/CustomizationList.vue`（内置项只读样式 + 🔒）
- Test: `src/components/customizations/editors/HookEditor.test.ts`

**Interfaces:**
- Consumes: `builtin_hooks_manifest` 事件（Task 3 emit 的）→ 经 useCustomizations 存为 `builtinHooks` ref
- Produces: emit `update` payload `{ event, matcher, command, timeout?, asyncRewake? }`

- [ ] **Step 1: 写失败测试**

```ts
// HookEditor.test.ts
import { mount } from "@vue/test-utils";
import { describe, it, expect } from "vitest";
import HookEditor from "./HookEditor.vue";
const item = { id: "x", name: "提交检查", type: "hook", enabled: true, path: "", source: "user",
  event: "PostToolUse", matcher: "^Bash$", command: "echo ok", timeout: 30, asyncRewake: false };
describe("HookEditor", () => {
  it("渲染 event 下拉 + matcher + command", () => {
    const w = mount(HookEditor, { props: { item } });
    expect(w.html()).toContain("PostToolUse");
    expect(w.find("input[value='^Bash$']").exists() || w.html()).toContain("^Bash$");
  });
  it("event 下拉含 4 选项", () => {
    const w = mount(HookEditor, { props: { item } });
    const opts = w.findAll("option");
    expect(opts.length).toBeGreaterThanOrEqual(4);
  });
  it("内置只读无保存按钮", () => {
    const w = mount(HookEditor, { props: { item: { ...item, source: "builtin" } } });
    expect(w.find("button.save-btn").exists()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- HookEditor`
Expected: FAIL。

- [ ] **Step 3: useCustomizations 接收内置 manifest**

```ts
// useCustomizations.ts 顶部加
import { ref } from "vue";
export const builtinHooks = ref<{ id: string; event: string; matcher: string; purpose: string }[]>([]);
// 在 useCustomizations() return 加 builtinHooks
```
监听 `builtin_hooks_manifest` 事件的接线放前端事件分发层（ChatPanel 或 session 事件 handler，确认现有事件 emit 落点后接入；实施时 Grep `emit(` 找前端事件入口，把 `builtin_hooks_manifest` 路由到 `builtinHooks.value = manifest`）。

- [ ] **Step 4: CustomizationList 内置 hook 分区**

`CustomizationList.vue` 当 `type === "hook"` 时，列表前先渲染 `builtinHooks`（只读区，🔒，无 toggle），再渲染用户 hook。内置项 `source: "builtin"`，不可选/不可 toggle。

- [ ] **Step 5: 实现 HookEditor**

`<script setup>`：form 含 event/matcher/command/timeout/asyncRewake，event 下拉 4 项，readOnly = source builtin/plugin。template：字段表单 + 保存/删除。`<style>` 用 `var(--aide-*)`。

- [ ] **Step 6: 跑测试**

Run: `pnpm test -- HookEditor`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/components/customizations/editors/HookEditor.vue src/composables/useCustomizations.ts src/components/customizations/CustomizationList.vue src/components/customizations/editors/HookEditor.test.ts
git commit -m "feat(customizations): HookEditor + 内置 hook 只读分区展示"
```

---

## Task 11: SkillEditor（含 scripts 子面板）

Skill editor：frontmatter 字段（name/description）+ 正文 CodeMirror + scripts 子面板（文件清单 + 选中编辑 + 新建/删除）。

**Files:**
- Modify: `src/components/customizations/editors/SkillEditor.vue`
- Modify: `src/api/customization.ts`（加 `readSkillScript`/`writeSkillScript`/`deleteSkillScript`）
- Test: `src/components/customizations/editors/SkillEditor.test.ts`

**Interfaces:**
- Consumes: `customizationApi.update("skill", id, {name, description})`、`customizationApi.get("skill", id)`（取 SKILL.md 全文）、`readSkillScript(id, filename)` 等
- Produces: emit `update` payload `{ name, description }`（正文 + scripts 各自独立保存路径）

- [ ] **Step 1: 加 script API**

```ts
// src/api/customization.ts 追加
export const skillScriptApi = {
  read: (skillId: string, filename: string) => invoke<string>("read_skill_script", { skillId, filename }),
  write: (skillId: string, filename: string, content: string) => invoke("write_skill_script", { skillId, filename, content }),
  delete: (skillId: string, filename: string) => invoke("delete_skill_script", { skillId, filename }),
};
```

- [ ] **Step 2: 写失败测试**

```ts
// SkillEditor.test.ts
vi.mock("../../../api/customization", () => ({
  customizationApi: { update: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue({ metadata: { scripts: ["build.sh", "check.py"] } }) },
  skillScriptApi: { read: vi.fn().mockResolvedValue("#!/usr/bin/env bash\necho hi"), write: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
}));
const item = { id: "build", name: "build", type: "skill", enabled: true, path: "", source: "user", description: "构建验证", metadata: { scripts: ["build.sh", "check.py"] } };
describe("SkillEditor", () => {
  it("三 tab：基本信息/正文/脚本", () => {
    const w = mount(SkillEditor, { props: { item } });
    expect(w.text()).toContain("基本信息"); expect(w.text()).toContain("正文"); expect(w.text()).toContain("脚本");
  });
  it("脚本 tab 列出 metadata.scripts", async () => {
    const w = mount(SkillEditor, { props: { item } });
    const scriptTab = w.findAll("button").find(b => b.text().includes("脚本"))!;
    await scriptTab.trigger("click");
    expect(w.text()).toContain("build.sh"); expect(w.text()).toContain("check.py");
  });
  it("选中脚本加载内容", async () => {
    const w = mount(SkillEditor, { props: { item } });
    await w.findAll("button").find(b => b.text().includes("脚本"))!.trigger("click");
    await w.find(".script-chip").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("echo hi");
  });
  it("插件来源只读", () => {
    const w = mount(SkillEditor, { props: { item: { ...item, source: "plugin" } } });
    expect(w.find("button.save-btn").exists()).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test -- SkillEditor`
Expected: FAIL。

- [ ] **Step 4: 实现 SkillEditor**

三 tab（基本信息/正文/脚本）。基本信息：name/description 输入框。正文：CodeMirror 编辑 SKILL.md（项目已有 `@codemirror/lang-markdown`，复用现有编辑器组件或直接用 codemirror + markdown extension）。脚本：文件清单 chips（来自 `item.metadata.scripts`）+ 选中加载 `skillScriptApi.read` + 编辑 CodeMirror + 保存 `write`/删除 `delete`/新建（prompt 文件名）。插件来源只读。frontmatter 解析/写回复用 `customizationApi.update("skill", id, {name, description})`（Rust `update_skill` 已支持，见 customizations.rs:353）。正文保存需新增 Rust 侧写 SKILL.md 全文 command——**确认 `update_skill` 是否支持写正文**：Read customizations.rs:353-371，当前只更新 frontmatter name/description。需扩展 `update_skill` 接受 `content`（全文）写回 SKILL.md，或新增 `save_skill_content` command。实施时优先扩 `update_skill` 加 `content` 分支。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test -- SkillEditor`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/customizations/editors/SkillEditor.vue src/components/customizations/editors/SkillEditor.test.ts src/api/customization.ts src-tauri/src/commands/customizations.rs
git commit -m "feat(customizations): SkillEditor（frontmatter + 正文 CodeMirror + scripts 子面板）"
```

---

## Task 12: AgentEditor

Agent editor：frontmatter（name/description/model/tools[]）+ 正文 CodeMirror（agent.md）。

**Files:**
- Modify: `src/components/customizations/editors/AgentEditor.vue`
- Test: `src/components/customizations/editors/AgentEditor.test.ts`
- Maybe modify: `src-tauri/src/commands/customizations.rs`（`update_agent` 加 content 分支，同 Task 11）

**Interfaces:**
- Consumes: `customizationApi.update("agent", id, {name, description, model, tools, content})`
- Produces: emit `update` payload 同上

- [ ] **Step 1: 写失败测试**

```ts
const item = { id: "code-reviewer", name: "code-reviewer", type: "agent", enabled: true, path: "", source: "user",
  description: "代码审查", model: "claude-sonnet-5", tools: ["Read", "Grep", "Bash"], content: "" };
describe("AgentEditor", () => {
  it("渲染 model + tools（可增删）", () => {
    const w = mount(AgentEditor, { props: { item } });
    expect(w.html()).toContain("claude-sonnet-5");
    expect(w.text()).toContain("Read"); expect(w.text()).toContain("Bash");
  });
  it("tools 添加按钮", () => {
    const w = mount(AgentEditor, { props: { item } });
    expect(w.find("button.add-tool").exists()).toBe(true);
  });
  it("两 tab：基本信息/正文", () => {
    const w = mount(AgentEditor, { props: { item } });
    expect(w.text()).toContain("基本信息"); expect(w.text()).toContain("正文");
  });
});
```

- [ ] **Step 2-5: 实现、测试、确认**

实现：两 tab。基本信息：name/description/model/tools[]（可增删 chip + 输入）。正文：CodeMirror 编辑 agent.md。保存 emit `{ name, description, model, tools, content }`。确认 Rust `update_agent` 支持 model/tools/content——Read customizations.rs 的 agent 命令段，若不支持则扩展（同 Task 11 的 content 模式）。

Run: `pnpm test -- AgentEditor`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/customizations/editors/AgentEditor.vue src/components/customizations/editors/AgentEditor.test.ts src-tauri/src/commands/customizations.rs
git commit -m "feat(customizations): AgentEditor（model/tools frontmatter + 正文 CodeMirror）"
```

---

## Task 13: InstructionEditor

指令 editor：全文 CodeMirror 编辑 CLAUDE.md/全局指令 + 全局/项目切换。

**Files:**
- Modify: `src/components/customizations/editors/InstructionEditor.vue`
- Test: `src/components/customizations/editors/InstructionEditor.test.ts`

**Interfaces:**
- Consumes: `instructionApi.getGlobal()`/`saveGlobal(content)`/`getProject()`/`saveProject(content)`（已存在，api/customization.ts:59）

- [ ] **Step 1: 写失败测试**

```ts
vi.mock("../../../api/customization", () => ({
  instructionApi: { getGlobal: vi.fn().mockResolvedValue({ content: "# 全局", is_global: true }),
                   saveGlobal: vi.fn().mockResolvedValue(undefined),
                   getProject: vi.fn().mockResolvedValue({ content: "# 项目", is_global: false }),
                   saveProject: vi.fn().mockResolvedValue(undefined) },
}));
describe("InstructionEditor", () => {
  it("默认全局，切项目加载项目内容", async () => {
    const w = mount(InstructionEditor, { props: { item: null } });
    await flushPromises();
    expect(w.text()).toContain("全局");
    const projBtn = w.findAll("button").find(b => b.text().includes("项目"))!;
    await projBtn.trigger("click"); await flushPromises();
    expect(w.text()).toContain("# 项目");
  });
  it("保存调对应 save", async () => {
    const { instructionApi } = await import("../../../api/customization");
    const w = mount(InstructionEditor, { props: { item: null } });
    await flushPromises();
    await w.find("button.save-btn").trigger("click");
    await flushPromises();
    expect(instructionApi.saveGlobal).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2-5: 实现、测试**

实现：全局/项目 seg 切换，CodeMirror 编辑，保存按当前 scope 调 saveGlobal/saveProject。

Run: `pnpm test -- InstructionEditor`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/customizations/editors/InstructionEditor.vue src/components/customizations/editors/InstructionEditor.test.ts
git commit -m "feat(customizations): InstructionEditor（全文 CodeMirror + 全局/项目切换）"
```

---

## Task 14: 清理死代码 + SettingsPanel 提示条 + 文档

删 `CustomizationPanel.vue` 死代码；SettingsPanel 扩展 tab 顶部加「下次新会话生效」提示条；更新文档；全量测试 + 编译。

**Files:**
- Delete: `src/components/customizations/CustomizationPanel.vue`
- Modify: `src/components/SettingsPanel.vue`（扩展 tab 顶部加提示条 L577-621 区域）

- [ ] **Step 1: 确认 CustomizationPanel 零引用**

Run: `grep -r "CustomizationPanel" src/`（用 Grep 工具）
Expected: 0 匹配（仅自身文件）。确认后删除：
```bash
git rm src/components/customizations/CustomizationPanel.vue
```

- [ ] **Step 2: SettingsPanel 加提示条**

在 `SettingsPanel.vue` 扩展 tab 模板（L584 `category-grid` 前，或 `tab-extensions` 顶部）加：
```vue
<div class="ext-notice" v-if="activeType && (activeType === 'mcp_server' || activeType === 'hook')">
  <Icon name="info" :size="13" /> 已保存的 MCP / 钩构配置下次新会话生效。点「测试连接」即时验证 MCP。
</div>
```
加 `.ext-notice` 样式（用 `var(--aide-accent-sub)` 背景 + `var(--aide-border-strong)` 边框）。

- [ ] **Step 3: 全量前端测试**

Run: `pnpm test`
Expected: 全部 PASS（含原有 SettingsPanel.test.ts + 新增 5 editor + CustomizationDetail 门面）。

- [ ] **Step 4: 全量 sidecar 测试 + 编译**

Run: `pnpm --dir agent-sidecar test && pnpm --dir agent-sidecar build`
Expected: PASS + 编译通过。

- [ ] **Step 5: Rust 测试 + 编译**

Run: `cd src-tauri && cargo test && cargo build`
Expected: PASS + 编译通过。

- [ ] **Step 6: 端到端手动验证**

- `pnpm tauri dev` 启 app
- 扩展 tab → MCP 服务器 → 新建一个 stdio MCP（如 filesystem）→ 保存 → 测试连接看绿灯
- 切传输类型到 sse/http 看字段变化
- 钩构 → 看内置 5 条只读 + 用户区
- 技能 → 编辑一个用户 skill 的正文 + 脚本 tab
- 开新会话确认用户 MCP 实际注入（sidecar 打日志或对话里看到工具）

- [ ] **Step 7: 更新文档**

更新 CLAUDE.md 的「内置 LSP」段附近或扩展管理相关说明（如有）；更新 `docs/superpowers/specs/2026-08-10-extensions-redesign-design.md` 加实施完成标记（可选）。

- [ ] **Step 8: Commit**

```bash
git rm src/components/customizations/CustomizationPanel.vue
git add src/components/SettingsPanel.vue
git commit -m "chore(customizations): 删 CustomizationPanel 死代码 + 扩展 tab 新会话生效提示条"
```

---

## Self-Review

**Spec coverage 检查：**
- 前端 5 editor 补字段 → Task 8-13 ✓
- sidecar 显式读取注入 → Task 1-3 ✓
- 内建 hook 注册表 + 只读展示 → Task 1, 10 ✓
- MCP 状态灯 + 测试连接探活（stdio/sse/http）→ Task 6, 7, 9 ✓
- Skill scripts 子面板 + 3 Rust command → Task 5, 11 ✓
- MCP stdio/sse/http 透传 → Task 4, 9 ✓
- 来源 badge 横切 → Task 8 ✓
- 删 CustomizationPanel.vue → Task 14 ✓
- 测试补全 → 各 Task TDD ✓
- 不合并市场 tab / 不做项目级 .mcp.json / 不做 Hook 探活 / 不做热更新 / 内建只读 / settingSources 不动 → 范围边界遵守 ✓

**Placeholder 扫描：** 无 TBD/TODO。Task 6 的 `resolve_agent_runtime_for_test` 标注「复用 runtime.rs 现有逻辑或加 wrapper」——这是有明确指引的实施动作（先 Read runtime.rs 再复用/提取），非占位符。Task 11 的 `update_skill` content 分支同。Task 10 的 builtin_hooks_manifest 前端路由点标注「Grep emit( 找入口」——明确实施动作。

**类型一致性：** `testMcpConnection` 在 api/customization.ts（Task 9）与 McpServerEditor（Task 9）、Rust `test_mcp_connection`（Task 6）签名一致。`assembleMcpServers`/`assembleHooks`（Task 2/3）签名一致。`BuiltinHookManifest`（Task 1）与前端 `builtinHooks` ref（Task 10）字段一致。`McpServer.transport`（Task 8）与 McpEditor form（Task 9）一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-extensions-redesign.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?