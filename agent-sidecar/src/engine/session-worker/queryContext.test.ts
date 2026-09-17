// prepareQueryContext 直测：临时配置根隔离盘上副作用（settings.json 缺席 = 无用户
// MCP/hooks），钉住装配臂：CLAUDE_CONFIG_DIR ?? 兜底、taskTools 跳过内建注册、
// automation 白名单过滤。session 适配器用桩（policy hook 语义归 sessionHook.test）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareQueryContext } from "./queryContext.js";
import type { HookBuildContext } from "../../extensions/builtinHooks/index.js";

const sessionStub: HookBuildContext["session"] = {
  makePolicyHook: () => async () => ({}),
  makeStopEffortHook: () => async () => ({}),
  makeModelSwitchGuard: () => null,
  metadata: () => ({}),
};

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aide-qctx-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

function deps(over: Partial<Parameters<typeof prepareQueryContext>[0]> = {}) {
  return {
    cwd: dir,
    trusted: false,
    codegraphEnabled: false,
    processEnv: {} as NodeJS.ProcessEnv,
    emit: () => {},
    taskTools: undefined,
    automationConfig: undefined,
    mcpHeaders: undefined,
    session: sessionStub,
    ...over,
  };
}

describe("prepareQueryContext", () => {
  it("CLAUDE_CONFIG_DIR 缺席 → 指令加载走空串根（?? 臂）；hooks 恒 policy 打头", async () => {
    const ctx = await prepareQueryContext(deps());
    expect(typeof ctx.instructions).toBe("string");
    expect(ctx.hooks.PreToolUse[0].matcher).toBe(".*");
    expect(ctx.hookManifest.some((m) => m.id === "policy")).toBe(true);
    expect(ctx.mcpServers).toEqual({}); // 无用户配置、内建未注册
  });

  it("CLAUDE_CONFIG_DIR 在场透传；!trusted → codegraph/docs 全不注册", async () => {
    const ctx = await prepareQueryContext(
      deps({
        trusted: false,
        codegraphEnabled: true,
        processEnv: { CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
      }),
    );
    expect(ctx.mcpServers["aide-codegraph"]).toBeUndefined();
    expect(ctx.mcpServers["aide-docs"]).toBeUndefined();
    // 浏览器工具同样受 trusted 门控（它带着用户的登录态，受限模式不该有）
    expect(ctx.mcpServers["aide-browser"]).toBeUndefined();
  });

  it("trusted → 内建 MCP 挂载（含 aide-browser）；AIDE_BROWSER_TOOLS=off → 单独摘除", async () => {
    const on = await prepareQueryContext(
      deps({ trusted: true, processEnv: { CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv }),
    );
    expect(on.mcpServers["aide-browser"]).toBeDefined();

    const off = await prepareQueryContext(
      deps({
        trusted: true,
        processEnv: { CLAUDE_CONFIG_DIR: dir, AIDE_BROWSER_TOOLS: "off" } as NodeJS.ProcessEnv,
      }),
    );
    expect(off.mcpServers["aide-browser"]).toBeUndefined();
    // 开关是**单点**的：关掉浏览器不该顺带关掉别的内建 MCP（那会变成一个隐藏的全局开关）
    expect(off.mcpServers["aide-docs"]).toBeDefined();
  });

  it("automation：mcpServers 按白名单收口——空白名单 = 连接器全不挂载（docs 也被滤掉）", async () => {
    const ctx = await prepareQueryContext(
      deps({
        trusted: true,
        processEnv: { CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
        automationConfig: {
          taskId: "t", runId: "r", preset: "auto", tools: ["*"],
          mcpAllowlist: [], taskDir: "", sessionDir: "",
        },
      }),
    );
    // trusted 下 docs 会注册，但白名单为空 → 终装后一个不剩
    expect(Object.keys(ctx.mcpServers)).toHaveLength(0);
  });
});
