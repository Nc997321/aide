# 散装 Skills/Agents 经 plugins 旁路注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Aide 用户级 `~/.aide/claude/` 与受信任项目级 `{cwd}/.aide/claude/` 下的散装 skills/agents 经 SDK `options.plugins` 旁路注入 agent，补齐「UI 展示了但 agent 调不到」的脱节。

**Architecture:** 新增独立模块 `agent-sidecar/src/dispatchPlugins.ts`（纯函数：`ensureDispatchManifest` 幂等写清单 + `buildDispatchPluginsOption` 构建注入配置）；`session-worker.ts` 在 `plugins:` 处拼接一行。保持 `settingSources:[]` 隔离不动；散装 plugin 全部 `skipMcpDiscovery:true` 隔离 MCP；项目级仅 `trusted` 时注入；清单写进 `.aide/claude/.claude-plugin/plugin.json`（`.aide/` gitignore 不进版本库）。清理 moot 的 `managedSettings.skillOverrides`/`buildProjectSkillOverrides`/`skillsDiscovery.ts`。

**Tech Stack:** TypeScript（ESNext/bundler，strict），Claude Agent SDK 0.3.197，vitest 4.1.9，Node `fs`/`path`/`os`。

## Global Constraints

- `settingSources: []` 必须保持为 `[]`（不读 `.claude/settings*.json`，Aide 独立设置体系）
- 散装 plugin 全部 `skipMcpDiscovery: true`（不贡献 MCP，与 Aide `strictMcpConfig` 门控隔离）
- 项目级仅 `trusted` 时注入（与现有 trust 机制一致）
- plugin name 硬编码常量 `aide-user`/`aide-project`（符合 SDK 正则 `^[A-Za-z0-9][-A-Za-z0-9._]*$`，不读外部输入）
- 路径用 `node:path.join`，不硬编码分隔符；claude home = `process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".aide", "claude")`（与 `codegraphSkill.ts:50` 同源）
- 永不阻塞会话：目录不存在/清单写失败 → catch 返回 false 跳过，不抛
- 新逻辑全部在 `dispatchPlugins.ts`（<120 行）；`session-worker.ts`（1146 行）只改必要行不增肥
- 测试：项目根 `pnpm test`（vitest run，`vitest.config.ts` include `agent-sidecar/src/**/*.test.ts`）；typecheck：`pnpm --dir agent-sidecar typecheck`
- 在 `master` 主分支提交，每个 commit message 结尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`

## File Structure

| 文件 | 职责 | 动作 |
|------|------|------|
| `agent-sidecar/src/dispatchPlugins.ts` | `ensureDispatchManifest`（幂等写清单）+ `buildDispatchPluginsOption`（构建注入配置）+ `USER_PLUGIN_NAME`/`PROJECT_PLUGIN_NAME` 常量。纯函数，叶子模块 | Create |
| `agent-sidecar/src/dispatchPlugins.test.ts` | vitest 单测：清单幂等/降级 + 注入门控/skipMcpDiscovery/路径 | Create |
| `agent-sidecar/src/session-worker.ts` | 加 `buildDispatchPluginsOption` import + 改 `plugins:` 拼接；删 `buildProjectSkillOverrides` import + `projectSkillOverrides` 变量 + `managedSettings.skillOverrides` 注入 + 改注释 | Modify |
| `agent-sidecar/src/skillsDiscovery.ts` | 现有 58 行，moot 后废弃 | Delete |
| `agent-sidecar/src/skillsDiscovery.test.ts` | 现有单测，随源码删 | Delete |
| `agent-sidecar/smoke-dispatch.ts` | 集成验收脚本：跑 SDK 查 init 消息 skills/plugins/mcp_servers，参考 `smoke-mcp.ts` | Create |

---

## Task 1: dispatchPlugins.ts — ensureDispatchManifest（TDD）

**Files:**
- Create: `agent-sidecar/src/dispatchPlugins.ts`
- Test: `agent-sidecar/src/dispatchPlugins.test.ts`

**Interfaces:**
- Consumes: 无（叶子函数）
- Produces:
  - `USER_PLUGIN_NAME = "aide-user"`（const string）
  - `PROJECT_PLUGIN_NAME = "aide-project"`（const string）
  - `ensureDispatchManifest(pluginRoot: string, name: string): boolean` — 幂等写 `{pluginRoot}/.claude-plugin/plugin.json` = `{"name": name}\n`；内容已匹配跳过；损坏 JSON 重写；IO 异常返回 false 不抛
  - `SdkPluginConfig`（本地 interface `{ type: "local"; path: string; skipMcpDiscovery?: boolean }`）

- [ ] **Step 1: Write the failing tests**

Create `agent-sidecar/src/dispatchPlugins.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDispatchManifest,
  USER_PLUGIN_NAME,
  PROJECT_PLUGIN_NAME,
} from "./dispatchPlugins.js";

describe("ensureDispatchManifest", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aide-dispatch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const manifestPath = (r: string) => join(r, ".claude-plugin", "plugin.json");

  it("首次写 .claude-plugin/plugin.json 含 name", () => {
    expect(ensureDispatchManifest(root, USER_PLUGIN_NAME)).toBe(true);
    const content = JSON.parse(readFileSync(manifestPath(root), "utf8"));
    expect(content).toEqual({ name: USER_PLUGIN_NAME });
  });

  it("幂等：已存在且 name 匹配时不重写（mtime 不变）", () => {
    ensureDispatchManifest(root, USER_PLUGIN_NAME);
    const file = manifestPath(root);
    const before = statSync(file).mtimeMs;
    expect(ensureDispatchManifest(root, USER_PLUGIN_NAME)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("name 不匹配时重写为新 name", () => {
    ensureDispatchManifest(root, USER_PLUGIN_NAME);
    expect(ensureDispatchManifest(root, PROJECT_PLUGIN_NAME)).toBe(true);
    const content = JSON.parse(readFileSync(manifestPath(root), "utf8"));
    expect(content).toEqual({ name: PROJECT_PLUGIN_NAME });
  });

  it("损坏 JSON 重写为正确内容", () => {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(manifestPath(root), "not json {{{");
    expect(ensureDispatchManifest(root, USER_PLUGIN_NAME)).toBe(true);
    const content = JSON.parse(readFileSync(manifestPath(root), "utf8"));
    expect(content).toEqual({ name: USER_PLUGIN_NAME });
  });

  it("pluginRoot 是文件而非目录时 mkdir 失败返回 false 不抛", () => {
    writeFileSync(join(root, "blocker"), "i am a file");
    expect(ensureDispatchManifest(join(root, "blocker"), USER_PLUGIN_NAME)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run agent-sidecar/src/dispatchPlugins.test.ts`
Expected: FAIL — `Failed to resolve import "./dispatchPlugins.js"`（模块不存在）

- [ ] **Step 3: Write minimal implementation**

Create `agent-sidecar/src/dispatchPlugins.ts`:

```ts
// 散装 skills/agents 经 SDK options.plugins 旁路注入 agent。
//
// 背景：Aide 用 settingSources:[] 隔离 SDK 文件系统 settings 体系，副作用是 SDK
// 文件系统 skill 发现被断掉，且 SDK 发现机制只认 .claude/skills，覆盖不到 Aide
// 的 .aide/claude/ 命名空间。SDK 文档给的唯一旁路：options.plugins 从特定路径
// 加载。本模块把用户级 ~/.aide/claude/ 与受信任项目级 {cwd}/.aide/claude/ 当
// 无清单 local plugin 注入，Aide 自动写 .claude-plugin/plugin.json 指定唯一 name
// （用户级/项目级目录名都叫 claude，无清单会撞名）。.aide/ gitignore，清单不
// 进版本库。全部 skipMcpDiscovery:true，散装 plugin 不贡献 MCP（与 Aide
// strictMcpConfig 门控隔离）。永不阻塞会话：目录不存在/写失败 → 跳过降级。
// 设计：docs/superpowers/specs/2026-08-03-dispatch-skills-plugins-injection-design.md

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 用户级 plugin name（skill 命名空间前缀 aide-user:）。符合 SDK 正则 ^[A-Za-z0-9][-A-Za-z0-9._]*$。 */
export const USER_PLUGIN_NAME = "aide-user";
/** 项目级 plugin name（skill 命名空间前缀 aide-project:）。单会话仅一个 cwd，固定名不撞用户级。 */
export const PROJECT_PLUGIN_NAME = "aide-project";

/** SDK plugin 配置（与 sdk.d.ts SdkPluginConfig 结构一致，本地定义避免耦合 SDK 内部类型）。 */
export interface SdkPluginConfig {
  type: "local";
  path: string;
  skipMcpDiscovery?: boolean;
}

const MANIFEST_DIR = ".claude-plugin";
const MANIFEST_FILE = "plugin.json";

/**
 * 幂等写 {pluginRoot}/.claude-plugin/plugin.json = {"name": name}。
 * - 文件已存在且 JSON.parse 后 name 匹配 → 跳过写，返回 true
 * - 文件不存在 / 损坏 / name 不匹配 → mkdir + 写入，成功返回 true
 * - 任何 IO 异常 → catch 返回 false，不抛（调用方降级跳过该 plugin）
 */
export function ensureDispatchManifest(pluginRoot: string, name: string): boolean {
  const manifestDir = join(pluginRoot, MANIFEST_DIR);
  const manifestFile = join(manifestDir, MANIFEST_FILE);
  const desired = JSON.stringify({ name }) + "\n";

  if (existsSync(manifestFile)) {
    try {
      const cur = readFileSync(manifestFile, "utf8");
      if (JSON.parse(cur)?.name === name) return true;
    } catch {
      // 损坏 JSON → 落到下面重写
    }
  }

  try {
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(manifestFile, desired, "utf8");
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run agent-sidecar/src/dispatchPlugins.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/dispatchPlugins.ts agent-sidecar/src/dispatchPlugins.test.ts
git commit -m "feat(sidecar): dispatchPlugins ensureDispatchManifest 幂等写 plugin 清单

散装 skills/agents 经 plugins 旁路注入的清单维护函数：幂等写
.aide/claude/.claude-plugin/plugin.json 指定 name，损坏 JSON 重写，
IO 失败降级返回 false 不阻塞会话。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: dispatchPlugins.ts — buildDispatchPluginsOption（TDD）

**Files:**
- Modify: `agent-sidecar/src/dispatchPlugins.ts`（追加函数）
- Test: `agent-sidecar/src/dispatchPlugins.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `ensureDispatchManifest`、`USER_PLUGIN_NAME`、`PROJECT_PLUGIN_NAME`、`SdkPluginConfig`（来自 Task 1）
- Produces:
  - `buildDispatchPluginsOption(cwd: string, trusted: boolean, lightweight: boolean): SdkPluginConfig[]` — lightweight→[]；用户级 = `CLAUDE_CONFIG_DIR`（fallback `~/.aide/claude`）始终（非 lightweight）；项目级 = `{cwd}/.aide/claude` 仅 `trusted`；每条先 `ensureDispatchManifest` 再返回 `{type:"local", path, skipMcpDiscovery:true}`；目录不存在/ensure 失败 → 跳过

- [ ] **Step 1: Write the failing tests**

Append to `agent-sidecar/src/dispatchPlugins.test.ts`（在文件末尾、现有 `describe` 之后追加；并在顶部 import 行加 `buildDispatchPluginsOption`）。

顶部 import 改为:

```ts
import {
  ensureDispatchManifest,
  buildDispatchPluginsOption,
  USER_PLUGIN_NAME,
  PROJECT_PLUGIN_NAME,
} from "./dispatchPlugins.js";
```

追加:

```ts
describe("buildDispatchPluginsOption", () => {
  let homeDir: string;
  let cwdDir: string;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "aide-dispatch-home-"));
    cwdDir = mkdtempSync(join(tmpdir(), "aide-dispatch-cwd-"));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  /** 临时设 process.env.CLAUDE_CONFIG_DIR 跑 fn，结束后还原。 */
  function withConfigDir(dir: string, fn: () => void): void {
    const old = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      fn();
    } finally {
      process.env.CLAUDE_CONFIG_DIR = old;
    }
  }

  it("lightweight 返回 []（即便目录存在）", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    withConfigDir(homeDir, () => {
      expect(buildDispatchPluginsOption(cwdDir, true, true)).toEqual([]);
    });
  });

  it("!trusted 仅用户级（项目级不注入）", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(homeDir, () => {
      const res = buildDispatchPluginsOption(cwdDir, false, false);
      expect(res).toHaveLength(1);
      expect(res[0]).toEqual({ type: "local", path: homeDir, skipMcpDiscovery: true });
    });
  });

  it("trusted 含用户级 + 项目级两条", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(homeDir, () => {
      const res = buildDispatchPluginsOption(cwdDir, true, false);
      expect(res).toHaveLength(2);
      expect(res[0]).toEqual({ type: "local", path: homeDir, skipMcpDiscovery: true });
      expect(res[1]).toEqual({
        type: "local",
        path: join(cwdDir, ".aide", "claude"),
        skipMcpDiscovery: true,
      });
    });
  });

  it("用户级目录不存在 → 跳过用户级，仅项目级", () => {
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(join(homeDir, "nope"), () => {
      const res = buildDispatchPluginsOption(cwdDir, true, false);
      expect(res).toHaveLength(1);
      expect(res[0].path).toBe(join(cwdDir, ".aide", "claude"));
    });
  });

  it("项目级目录不存在 → 跳过项目级，仅用户级", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    withConfigDir(homeDir, () => {
      const res = buildDispatchPluginsOption(cwdDir, true, false);
      expect(res).toHaveLength(1);
      expect(res[0].path).toBe(homeDir);
    });
  });

  it("每条都带 skipMcpDiscovery:true", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(homeDir, () => {
      const res = buildDispatchPluginsOption(cwdDir, true, false);
      expect(res.every((r) => r.skipMcpDiscovery === true)).toBe(true);
    });
  });

  it("注入会 ensureDispatchManifest 写清单（用户级 aide-user）", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    withConfigDir(homeDir, () => {
      buildDispatchPluginsOption(cwdDir, false, false);
      const m = JSON.parse(
        readFileSync(join(homeDir, ".claude-plugin", "plugin.json"), "utf8"),
      );
      expect(m).toEqual({ name: USER_PLUGIN_NAME });
    });
  });

  it("trusted 注入会写项目级清单 aide-project", () => {
    mkdirSync(join(homeDir, "skills", "x"), { recursive: true });
    mkdirSync(join(cwdDir, ".aide", "claude", "skills", "y"), { recursive: true });
    withConfigDir(homeDir, () => {
      buildDispatchPluginsOption(cwdDir, true, false);
      const m = JSON.parse(
        readFileSync(join(cwdDir, ".aide", "claude", ".claude-plugin", "plugin.json"), "utf8"),
      );
      expect(m).toEqual({ name: PROJECT_PLUGIN_NAME });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run agent-sidecar/src/dispatchPlugins.test.ts`
Expected: FAIL — `buildDispatchPluginsOption is not a function`（未导出）

- [ ] **Step 3: Write minimal implementation**

先在 `agent-sidecar/src/dispatchPlugins.ts` 顶部 import 区确保有 `import { homedir } from "node:os";`（Task 1 的 `ensureDispatchManifest` 不用 `homedir`，Task 1 fix 后该 import 已删；本函数 `buildDispatchPluginsOption` 需要 `homedir()`。若已存在则跳过）。

然后追加到 `agent-sidecar/src/dispatchPlugins.ts`（在 `ensureDispatchManifest` 之后）:

```ts
/**
 * 构建散装 plugin 注入配置：用户级 + 项目级（仅 trusted）。
 *
 * - lightweight → []
 * - 用户级：claude home = process.env.CLAUDE_CONFIG_DIR（fallback ~/.aide/claude，
 *   与 codegraphSkill.ts:50 同源）。目录存在 + ensureDispatchManifest 成功 → 注入
 * - 项目级：{cwd}/.aide/claude，仅 trusted。同样门控
 * - 每条 skipMcpDiscovery:true（散装 plugin 不贡献 MCP，与 Aide strictMcpConfig 隔离）
 * - 目录不存在 / ensure 失败 → 跳过该条（降级，不阻塞）
 */
export function buildDispatchPluginsOption(
  cwd: string,
  trusted: boolean,
  lightweight: boolean,
): SdkPluginConfig[] {
  if (lightweight) return [];
  const out: SdkPluginConfig[] = [];

  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".aide", "claude");
  if (existsSync(claudeHome) && ensureDispatchManifest(claudeHome, USER_PLUGIN_NAME)) {
    out.push({ type: "local", path: claudeHome, skipMcpDiscovery: true });
  }

  if (trusted) {
    const projectRoot = join(cwd, ".aide", "claude");
    if (existsSync(projectRoot) && ensureDispatchManifest(projectRoot, PROJECT_PLUGIN_NAME)) {
      out.push({ type: "local", path: projectRoot, skipMcpDiscovery: true });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run agent-sidecar/src/dispatchPlugins.test.ts`
Expected: PASS（全部用例绿，含 Task 1 的 5 个 + Task 2 的 9 个）

- [ ] **Step 5: Run full suite to confirm no regression**

Run: `pnpm test`
Expected: PASS（所有现有测试 + dispatchPlugins 全绿）

- [ ] **Step 6: Typecheck**

Run: `pnpm --dir agent-sidecar typecheck`
Expected: 无错（`tsc --noEmit` 通过）

- [ ] **Step 7: Commit**

```bash
git add agent-sidecar/src/dispatchPlugins.ts agent-sidecar/src/dispatchPlugins.test.ts
git commit -m "feat(sidecar): buildDispatchPluginsOption 散装 plugin 注入配置

构建用户级 + 受信任项目级 .aide/claude 的 local plugin 注入配置，
全部 skipMcpDiscovery:true 隔离 MCP；目录不存在/清单写失败降级跳过。
claude home 经 CLAUDE_CONFIG_DIR（fallback ~/.aide/claude）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: session-worker.ts 集成拼接

**Files:**
- Modify: `agent-sidecar/src/session-worker.ts:39`（加 import）
- Modify: `agent-sidecar/src/session-worker.ts:883`（plugins 拼接）

**Interfaces:**
- Consumes: `buildDispatchPluginsOption(cwd, trusted, lightweight): SdkPluginConfig[]`（来自 Task 2）
- Produces: sidecar 启动会话时 `options.plugins` 含散装 plugin（用户级 + 受信任项目级）

- [ ] **Step 1: Add import**

In `agent-sidecar/src/session-worker.ts`，找到第 39 行附近现有 import 区:

```ts
import { loadAideInstructions } from "./instructions.js";
import { buildProjectSkillOverrides } from "./skillsDiscovery.js";
import { evaluatePolicy } from "./policy/evaluate.js";
import type { PermissionPolicySnapshot } from "./policy/types.js";
```

在 `import { buildProjectSkillOverrides } from "./skillsDiscovery.js";` 下一行追加（不改原有行）:

```ts
import { buildDispatchPluginsOption } from "./dispatchPlugins.js";
```

- [ ] **Step 2: Splice into plugins option**

找到第 883 行（`startLoop` 内）:

```ts
              skills: this.lightweightMode ? [] : "all",
              plugins: this.lightweightMode ? [] : buildPluginsOption(),
              hooks: {
```

将 `plugins:` 那行替换为:

```ts
              plugins: this.lightweightMode
                ? []
                : [...buildPluginsOption(), ...buildDispatchPluginsOption(effectiveCwd, trusted, this.lightweightMode)],
```

> `effectiveCwd`（第 833 行定义 `const effectiveCwd = cwd ?? this.cwd ?? "";`）、`trusted`（`startLoop` 参数，第 798 行 `async startLoop(cwd?: string, trusted = true)`）、`this.lightweightMode`（实例属性）均在作用域内。外层 `lightweightMode ? []` 已挡轻量模式，传 `this.lightweightMode` 给函数作双保险。

- [ ] **Step 3: Run full suite to confirm no regression**

Run: `pnpm test`
Expected: PASS（现有测试不受影响；`buildProjectSkillOverrides` 仍在但 moot 无害）

- [ ] **Step 4: Typecheck**

Run: `pnpm --dir agent-sidecar typecheck`
Expected: 无错

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/session-worker.ts
git commit -m "feat(sidecar): session-worker 拼接散装 plugin 注入

options.plugins 在 marketplace 插件之外追加用户级 + 受信任项目级
.aide/claude 散装 plugin，补齐 UI 展示-可用脱节。settingSources:[] 不动。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 清理 moot 的 skillOverrides / skillsDiscovery.ts

**背景**：Task 3 注入后，`trusted` 时项目 skill 真进 agent（不需隐藏），`!trusted` 时项目级不注入（没 skill 不需隐藏）。两种情况都不再需要 `managedSettings.skillOverrides` 隐藏项目 skill。`buildProjectSkillOverrides`/`skillsDiscovery.ts` 变为死代码。`managedSettings` 在 `session-worker.ts` 唯一用途就是 `skillOverrides`（grep 实锤仅第 870 行），可连同移除。`strictMcpConfig`（第 868 行）保留，那是 MCP 门控独立逻辑。

**Files:**
- Modify: `agent-sidecar/src/session-worker.ts`（删 import + 变量 + managedSettings 注入 + 改注释）
- Delete: `agent-sidecar/src/skillsDiscovery.ts`
- Delete: `agent-sidecar/src/skillsDiscovery.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 移除 moot 死代码；`strictMcpConfig` 保留

- [ ] **Step 1: Remove buildProjectSkillOverrides import**

In `agent-sidecar/src/session-worker.ts`，删除第 39 行:

```ts
import { buildProjectSkillOverrides } from "./skillsDiscovery.js";
```

（`buildDispatchPluginsOption` import 保留）

- [ ] **Step 2: Remove projectSkillOverrides variable and its comment**

找到第 834-837 行:

```ts
          // 受限模式（!trusted）：项目 .aide/claude/skills/ 里的 skill 经
          // managedSettings.skillOverrides 从模型列表/Skill 工具隐藏——
          // user/plugin skill 不受影响（skills 仍为 "all"）。
          const projectSkillOverrides = trusted ? {} : buildProjectSkillOverrides(effectiveCwd);
```

整段删除（4 行）。

- [ ] **Step 3: Remove managedSettings injection, keep strictMcpConfig, fix comment**

找到第 865-871 行:

```ts
              // 受限模式（!trusted）：strictMcpConfig 忽略项目 .mcp.json 等外部 MCP
              // 配置；managedSettings.skillOverrides 隐藏项目 .aide/claude/skills/ 里的 skill。
              // user 级 / plugin 级不受影响（plugins 经 AIDE_ENABLED_PLUGINS_FILE 注入）。
              ...(trusted ? {} : { strictMcpConfig: true }),
              ...(projectSkillOverrides && Object.keys(projectSkillOverrides).length > 0
                ? { managedSettings: { skillOverrides: projectSkillOverrides } as any }
                : {}),
```

替换为:

```ts
              // 受限模式（!trusted）：strictMcpConfig 忽略项目 .mcp.json 等外部 MCP 配置；
              // buildDispatchPluginsOption 不注入项目级散装 plugin（项目 skills/agents
              // 不进 agent）。user 级不受影响。
              ...(trusted ? {} : { strictMcpConfig: true }),
```

- [ ] **Step 4: Delete skillsDiscovery files**

```bash
git rm agent-sidecar/src/skillsDiscovery.ts agent-sidecar/src/skillsDiscovery.test.ts
```

- [ ] **Step 5: Run full suite to confirm no regression**

Run: `pnpm test`
Expected: PASS（`skillsDiscovery.test.ts` 已删不跑；`dispatchPlugins` 测试绿；其他不受影响）

- [ ] **Step 6: Typecheck**

Run: `pnpm --dir agent-sidecar typecheck`
Expected: 无错（确认 `session-worker.ts` 无悬空引用）

- [ ] **Step 7: Grep verify no dangling references**

Run: `grep -rn "skillsDiscovery\|buildProjectSkillOverrides\|projectSkillOverrides\|skillOverrides\|managedSettings" agent-sidecar/src/`
Expected: 无输出（全部清干净；若 `managedSettings` 在别处有别的用途会显示，需人工判断——但 grep 前已实锤仅第 870 行）

- [ ] **Step 8: Commit**

```bash
git add agent-sidecar/src/session-worker.ts
git commit -m "refactor(sidecar): 清理 moot 的 skillOverrides/skillsDiscovery

Task 3 注入项目级散装 plugin 后，!trusted 时不注入即不需 skillOverrides
隐藏，buildProjectSkillOverrides/skillsDiscovery.ts 变死代码。移除
projectSkillOverrides 变量、managedSettings.skillOverrides 注入、
skillsDiscovery 模块。strictMcpConfig 保留（MCP 门控独立）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

（`git rm` 已 staged 删除，`git add` session-worker 改动，一起 commit）

---

## Task 5: 集成验收 smoke 脚本

**背景**：单测覆盖不了 SDK native 行为（plugin 是否真被加载、skill 是否真以 `aide-user:`/`aide-project:` 前缀出现、`skipMcpDiscovery` 是否真隔离 MCP）。写一个 smoke 脚本跑真 SDK，打印 init 消息的 `plugins`/`skills`/`slash_commands`/`mcp_servers`，按 spec §12 验收清单逐项核对。手动跑（依赖 claude.exe + API key，非 CI）。

**Files:**
- Create: `agent-sidecar/smoke-dispatch.ts`

**Interfaces:**
- Consumes: `buildDispatchPluginsOption`（来自 Task 2）
- Produces: 可重复的集成验证命令 `npx tsx smoke-dispatch.ts`

- [ ] **Step 1: Write smoke script**

Create `agent-sidecar/smoke-dispatch.ts`:

```ts
// 冒烟：验证散装 skills/agents 经 plugins 旁路真正注入 agent。
// 用法（agent-sidecar 目录）：
//   npx tsx smoke-dispatch.ts            # trusted（默认），验证 aide-user: + aide-project:
//   SMOKE_TRUSTED=0 npx tsx smoke-dispatch.ts   # !trusted，验证无 aide-project:
//   SMOKE_CWD=/path/to/project npx tsx smoke-dispatch.ts  # 指定项目目录
// 依赖：claude.exe（优先 AIDE_CLAUDE_EXE，否则 SDK 平台包内）+ API key。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDispatchPluginsOption } from "./src/dispatchPlugins.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// claude.exe：优先 AIDE_CLAUDE_EXE，否则 SDK 平台包（win32-x64）内
const DEFAULT_CLAUDE_EXE = join(
  __dirname,
  "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
);
const claudeExe =
  process.env.AIDE_CLAUDE_EXE ??
  (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);

// CLAUDE_CONFIG_DIR：让 buildDispatchPluginsOption 与 SDK 子进程都拿到同一个 claude home
const home = process.env.CLAUDE_CONFIG_DIR ??
  join(process.env.USERPROFILE || process.env.HOME || "", ".aide/claude");
process.env.CLAUDE_CONFIG_DIR = home;

const cwd = process.env.SMOKE_CWD ?? process.cwd();
const trusted = (process.env.SMOKE_TRUSTED ?? "1") !== "0";

const plugins = buildDispatchPluginsOption(cwd, trusted, false);
console.log("=== dispatch plugins ===");
console.log(JSON.stringify(plugins, null, 2));
console.log("claude home:", home, "cwd:", cwd, "trusted:", trusted);
if (plugins.length === 0) {
  console.log("⚠ 没有散装 plugin 注入——检查 ~/.aide/claude/skills/ 和 {cwd}/.aide/claude/skills/ 是否有 SKILL.md");
}

const env: Record<string, string | undefined> = { ...process.env };

const q = query({
  prompt: "What skills do you have available? List the names only, briefly.",
  options: {
    plugins,
    skills: "all",
    settingSources: [],
    cwd,
    env,
    allowedTools: [],
    permissionMode: "dontAsk",
    maxTurns: 1,
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
  },
});

for await (const msg of q as any) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("=== INIT ===");
    console.log("plugins:", JSON.stringify(msg.plugins));
    console.log("skills:", JSON.stringify(msg.skills));
    console.log("slash_commands:", JSON.stringify(msg.slash_commands));
    console.log("mcp_servers:", JSON.stringify(msg.mcp_servers));
  } else if (msg.type === "assistant") {
    for (const b of msg.message?.content ?? []) {
      if (b.type === "text" && b.text?.trim()) console.log("TEXT:", b.text.slice(0, 300));
    }
  } else if (msg.type === "result") {
    console.log("=== RESULT ===", msg.subtype, "cost:", msg.total_cost_usd);
    break;
  }
}
```

- [ ] **Step 2: Prepare a test project skill（若项目无 .aide/claude/skills）**

确保有可验证的散装 skill。用户级 `~/.aide/claude/skills/` 实测已有 `image-analysis` 等。项目级若 `{cwd}/.aide/claude/skills/` 为空，建一个临时:

```bash
mkdir -p .aide/claude/skills/smoke-probe
cat > .aide/claude/skills/smoke-probe/SKILL.md <<'EOF'
---
name: smoke-probe
description: smoke test probe skill, ignore
---
# smoke-probe
EOF
```

- [ ] **Step 3: Run smoke (trusted) and verify init skills**

Run: `cd agent-sidecar && npx tsx smoke-dispatch.ts`
Expected: init 消息输出中
- `plugins` 含 `{name:"aide-user", path:...}` 和 `{name:"aide-project", path:...}`
- `skills` 列表含 `aide-user:image-analysis`（或用户级已有 skill）和 `aide-project:smoke-probe`
- `mcp_servers` 不含因散装 plugin 引入的新 server（`skipMcpDiscovery` 生效）

- [ ] **Step 4: Run smoke (!trusted) and verify no project-level**

Run: `cd agent-sidecar && SMOKE_TRUSTED=0 npx tsx smoke-dispatch.ts`
Expected:
- `plugins` 仅 `{name:"aide-user", path:...}`，无 `aide-project`
- `skills` 含 `aide-user:*`，无 `aide-project:smoke-probe`

- [ ] **Step 5: Verify ~/.aide/claude/plugins/ CLI cache not pulled in**

检查 Step 3 的 init `plugins`/`skills`/`slash_commands` 列表，确认没有来自 `~/.aide/claude/plugins/`（CLI 缓存目录）的意外 plugin/skill/command 混入。`~/.aide/claude/plugins/` 含 `installed_plugins.json`/`marketplaces`/`cache`，SDK 应忽略（非固定组件名）。

- [ ] **Step 6: Verify plugin agent tool calls go through Aide policy（手动）**

构造一个带危险工具的临时 agent，确认其工具调用被 Aide policy 拦截:

```bash
mkdir -p .aide/claude/agents
cat > .aide/claude/agents/smoke-danger.md <<'EOF'
---
name: smoke-danger
description: probe agent that tries to run bash, ignore
tools: Bash
model: haiku
---
Run: rm -rf /tmp/nonexistent-probe
EOF
```

在 Aide app（`pnpm tauri dev`）里让 model 调用 `smoke-danger` agent，确认 Bash `rm` 调用经 Aide `canUseTool`/policy hook 拦截（弹出权限请求或按策略拒绝），而非直接执行。验证后删 `smoke-danger.md`。

- [ ] **Step 7: Cleanup probe files**

```bash
rm -f .aide/claude/skills/smoke-probe/SKILL.md
rmdir .aide/claude/skills/smoke-probe 2>/dev/null || true
rm -f .aide/claude/agents/smoke-danger.md
```

- [ ] **Step 8: Commit smoke script**

```bash
git add agent-sidecar/smoke-dispatch.ts
git commit -m "test(sidecar): 散装 plugin 注入 smoke 验证脚本

跑真 SDK 查 init 消息 skills/plugins/mcp_servers，按 spec §12 验收清单
逐项核对：aide-user:/aide-project: 前缀、!trusted 不含项目级、
skipMcpDiscovery 隔离 MCP、CLI 缓存目录不混入。手动跑，非 CI。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验收对齐（spec §12）

| spec 验收项 | 对应 task |
|------|------|
| 用户级 skill 以 `aide-user:` 进 agent | Task 5 Step 3 |
| 项目级 skill 以 `aide-project:` 进 agent（仅 trusted） | Task 5 Step 3 + Step 4 |
| agents 进 agent | Task 5 Step 6 |
| `!trusted` 项目级不注入 | Task 5 Step 4 |
| `lightweightMode` 散装不注入 | Task 2 测试 `lightweight 返回 []` + Task 3 外层 ternary |
| `skipMcpDiscovery` 隔离 MCP | Task 2 测试 + Task 5 Step 3 mcp_servers |
| `~/.aide/claude/plugins/` 不混入 | Task 5 Step 5 |
| 清单幂等写、进 .aide/（gitignore） | Task 1 测试 + Task 2 ensure 写清单测试 |
| 写失败/目录不存在降级零回归 | Task 1 `pluginRoot 是文件` 测试 + Task 2 跳过测试 |
| plugin agent 工具走 Aide policy | Task 5 Step 6 |
| session-worker 只改必要行、dispatchPlugins <120 行 | Task 3 + Task 1/2 实现 |
| `buildProjectSkillOverrides`/`skillsDiscovery.ts` 废弃 | Task 4 |
| `settingSources:[]` 不变、marketplace 插件不受影响 | Task 3（settingSources:[] 保留）、Task 3/4 不动 buildPluginsOption |