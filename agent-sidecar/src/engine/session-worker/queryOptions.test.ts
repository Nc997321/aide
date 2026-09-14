// buildSpawnQueryOptions 直测：条件展开臂逐条钉住。dispatchPlugins/claudeExe 打桩
//（真实现摸 ~/.aide/claude 与 exe 探测——测试不许有盘上副作用）。
import { describe, it, expect, vi } from "vitest";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

vi.mock("../../extensions/dispatchPlugins.js", () => ({
  buildPluginsOption: () => [{ type: "local", path: "/plugins/market" }],
  buildDispatchPluginsOption: () => [{ type: "local", path: "/plugins/user", skipMcpDiscovery: true }],
}));
vi.mock("../claudeExe.js", () => ({ resolveClaudeExe: vi.fn(() => "") }));

import { buildSpawnQueryOptions, type QuerySpawnParts } from "./queryOptions.js";
import { CODEGRAPH_ALLOW_RULE } from "../../extensions/codegraphTools.js";
import { DOCS_ALLOW_RULE } from "../../extensions/docsMcp.js";

function parts(over: {
  workspace?: Partial<QuerySpawnParts["workspace"]>;
  branch?: Partial<QuerySpawnParts["branch"]>;
  model?: Partial<QuerySpawnParts["model"]>;
  fork?: Partial<QuerySpawnParts["fork"]>;
} = {}): QuerySpawnParts {
  return {
    runtime: {
      abortController: new AbortController(),
      permissionMode: "auto" as PermissionMode,
      canUseTool: (async () => ({ behavior: "allow" })) as QuerySpawnParts["runtime"]["canUseTool"],
      ctx: { instructions: "INST", hooks: { PreToolUse: [] }, hookManifest: [], mcpServers: { biz: { type: "http" } } },
      cliEnv: { PATH: "/bin" },
    },
    workspace: { trusted: true, cwd: "/proj", cwdParam: undefined, cwdWorker: undefined, ...over.workspace },
    branch: { automationConfig: undefined, ...over.branch },
    model: { sdkModel: "", effort: "", thinkingEnabled: true, ...over.model },
    fork: { resumeSource: "", shouldFork: false, ...over.fork },
  };
}

type Opts = Record<string, any>;

describe("buildSpawnQueryOptions", () => {
  it("信任工作区基线：无 strictMcpConfig，instructions/hooks/mcp/env 从 ctx 直通", () => {
    const o = buildSpawnQueryOptions(parts()) as Opts;
    expect(o.strictMcpConfig).toBeUndefined();
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "INST" });
    expect(o.hooks).toEqual({ PreToolUse: [] });
    expect(o.mcpServers).toEqual({ biz: { type: "http" } });
    expect(o.env).toEqual({ PATH: "/bin" });
    expect(o.allowedTools).toContain(CODEGRAPH_ALLOW_RULE);
    expect(o.allowedTools).toContain(DOCS_ALLOW_RULE);
    expect(o.skills).toBe("all");
    expect(o.settingSources).toEqual([]);
    expect(o.allowDangerouslySkipPermissions).toBe(true);
  });

  it("受限工作区（!trusted）→ strictMcpConfig:true", () => {
    const o = buildSpawnQueryOptions(parts({ workspace: { trusted: false } })) as Opts;
    expect(o.strictMcpConfig).toBe(true);
  });

  it("automation：skills+plugins 全关（前缀最小化）", () => {
    const cfg = { taskId: "t", runId: "r", preset: "auto" as const, tools: ["*"], mcpAllowlist: [], taskDir: "", sessionDir: "" };
    const auto = buildSpawnQueryOptions(parts({ branch: { automationConfig: cfg } })) as Opts;
    expect(auto.skills).toEqual([]);
    expect(auto.plugins).toEqual([]);
    expect(auto.includePartialMessages).toBe(false);
  });

  it("问答主会话 plugins：市场 + 散装注入", () => {
    const o = buildSpawnQueryOptions(parts()) as Opts;
    expect(o.plugins).toHaveLength(2);
    expect(o.tools).toBeUndefined();
    expect(o.includePartialMessages).toBe(true);
  });

  it("model/effort 空串不带键；有值带上", () => {
    const empty = buildSpawnQueryOptions(parts()) as Opts;
    expect("model" in empty).toBe(false);
    expect("effort" in empty).toBe(false);
    const set = buildSpawnQueryOptions(parts({ model: { sdkModel: "sonnet", effort: "high" } })) as Opts;
    expect(set.model).toBe("sonnet");
    expect(set.effort).toBe("high");
  });

  it("thinking 三臂：automation 恒 disabled；开关关 disabled；开 adaptive+summarized", () => {
    const cfg = { taskId: "t", runId: "r", preset: "auto" as const, tools: ["*"], mcpAllowlist: [], taskDir: "", sessionDir: "" };
    expect((buildSpawnQueryOptions(parts({ branch: { automationConfig: cfg } })) as Opts).thinking).toEqual({ type: "disabled" });
    expect((buildSpawnQueryOptions(parts({ model: { thinkingEnabled: false } })) as Opts).thinking).toEqual({ type: "disabled" });
    expect((buildSpawnQueryOptions(parts()) as Opts).thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("cwd 优先级：入参 > worker.cwd > 不带键", () => {
    expect((buildSpawnQueryOptions(parts({ workspace: { cwdParam: "/p", cwdWorker: "/w" } })) as Opts).cwd).toBe("/p");
    expect((buildSpawnQueryOptions(parts({ workspace: { cwdWorker: "/w" } })) as Opts).cwd).toBe("/w");
    expect("cwd" in (buildSpawnQueryOptions(parts()) as Opts)).toBe(false);
  });

  it("fork/resume 展开：无源不带键；有源 resume；shouldFork 加 forkSession", () => {
    expect("resume" in (buildSpawnQueryOptions(parts()) as Opts)).toBe(false);
    expect((buildSpawnQueryOptions(parts({ fork: { resumeSource: "sid-1" } })) as Opts).resume).toBe("sid-1");
    const forked = buildSpawnQueryOptions(parts({ fork: { resumeSource: "sid-1", shouldFork: true } })) as Opts;
    expect(forked.resume).toBe("sid-1");
    expect(forked.forkSession).toBe(true);
  });

  it("claudeExe 解析到时带 pathToClaudeCodeExecutable（桩为空 → 不带）", async () => {
    const exe = await import("../claudeExe.js");
    // 实现里 resolveClaudeExe() 被调两次（条件判定 + 取值，原样保留的历史形状）——
    // once 要喂两次；不污染后续用例的缺省 ""。
    vi.mocked(exe.resolveClaudeExe).mockReturnValueOnce("/exe/claude").mockReturnValueOnce("/exe/claude");
    const o = buildSpawnQueryOptions(parts()) as Opts;
    expect(o.pathToClaudeCodeExecutable).toBe("/exe/claude");
    expect("pathToClaudeCodeExecutable" in (buildSpawnQueryOptions(parts()) as Opts)).toBe(false);
  });
});
