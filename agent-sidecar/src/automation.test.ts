import { describe, expect, it } from "vitest";
import {
  automationHookVerdict,
  automationQueryOverrides,
  filterMcpServers,
  isUnderTaskDir,
  parseMcpServerKey,
  type AutomationConfig,
} from "./automation.js";

const cfg = (over: Partial<AutomationConfig> = {}): AutomationConfig => ({
  taskId: "aut_x",
  runId: "run_x",
  preset: "auto",
  tools: ["*"],
  mcpAllowlist: ["aide-codegraph"],
  taskDir: "C:\\Users\\h\\.aide\\automations\\aut_x",
  ...over,
});

describe("parseMcpServerKey", () => {
  it("parses standard mcp tool names", () => {
    expect(parseMcpServerKey("mcp__aide-codegraph__find_symbol")).toBe("aide-codegraph");
    expect(parseMcpServerKey("mcp__aide-docs__read_docx")).toBe("aide-docs");
  });
  it("server key with single underscore is preserved", () => {
    expect(parseMcpServerKey("mcp__my_server__do_thing")).toBe("my_server");
  });
  it("non-mcp tools return null", () => {
    expect(parseMcpServerKey("Read")).toBeNull();
    expect(parseMcpServerKey("mcp_")).toBeNull();
    expect(parseMcpServerKey("Bash")).toBeNull();
  });
});

describe("automationHookVerdict", () => {
  it("auto 预设：内建工具一律 defer（交还 CLI auto 裁决）", () => {
    expect(automationHookVerdict("Read", {}, cfg())).toBe("defer");
    expect(automationHookVerdict("Bash", { command: "ls" }, cfg())).toBe("defer");
    expect(automationHookVerdict("Write", { file_path: "C:\\ws\\x.md" }, cfg())).toBe("defer");
  });
  it("full 预设：内建工具全 allow", () => {
    expect(automationHookVerdict("Bash", { command: "ls" }, cfg({ preset: "full" }))).toBe("allow");
    expect(automationHookVerdict("Read", {}, cfg({ preset: "full" }))).toBe("allow");
  });
  it("MCP 工具按连接器白名单，与预设无关", () => {
    expect(automationHookVerdict("mcp__aide-codegraph__find_symbol", {}, cfg())).toBe("allow");
    expect(automationHookVerdict("mcp__evil-server__pwn", {}, cfg())).toBe("deny");
    // full 预设也不能白拿未预授权的连接器
    expect(automationHookVerdict("mcp__evil-server__pwn", {}, cfg({ preset: "full" }))).toBe("deny");
    expect(automationHookVerdict("mcp__aide-docs__read_docx", {}, cfg({ preset: "full" }))).toBe("deny");
  });
  it("任务目录写例外：auto 预设下写任务目录内文件放行", () => {
    const c = cfg();
    expect(
      automationHookVerdict("Write", { file_path: "C:\\Users\\h\\.aide\\automations\\aut_x\\playbook.md" }, c),
    ).toBe("allow");
    expect(
      automationHookVerdict("Edit", { file_path: "C:/Users/h/.aide/automations/aut_x/scripts/x.mjs" }, c),
    ).toBe("allow");
  });
  it("写例外不越界：目录外、非写工具、类前缀目录都不放行", () => {
    const c = cfg();
    // 目录外 → defer
    expect(automationHookVerdict("Write", { file_path: "C:\\Users\\h\\.aide\\automations\\aut_y\\p.md" }, c)).toBe("defer");
    // 前缀相似的兄弟目录（aut_x2）不能命中
    expect(
      automationHookVerdict("Write", { file_path: "C:\\Users\\h\\.aide\\automations\\aut_x2\\p.md" }, c),
    ).toBe("defer");
    // 非写工具即使路径在任务目录内也不走写例外
    expect(automationHookVerdict("Bash", { command: "rm x" }, c)).toBe("defer");
    // full 预设下目录外写入仍 allow（full 语义就是全放行）
    expect(automationHookVerdict("Write", { file_path: "C:\\ws\\x.md" }, cfg({ preset: "full" }))).toBe("allow");
  });
});

describe("isUnderTaskDir", () => {
  it("normalize separators and trailing slash", () => {
    expect(isUnderTaskDir("C:\\a\\b\\c.md", "C:/a/b")).toBe(true);
    expect(isUnderTaskDir("C:/a/b/c.md", "C:\\a\\b\\")).toBe(true);
    expect(isUnderTaskDir("C:/a/b2/c.md", "C:/a/b")).toBe(false);
  });
  it("rejects empty/non-string input", () => {
    expect(isUnderTaskDir("", "C:/a")).toBe(false);
    expect(isUnderTaskDir(undefined, "C:/a")).toBe(false);
    expect(isUnderTaskDir("C:/a/b", "")).toBe(false);
  });
});

describe("automationQueryOverrides", () => {
  it("no config → empty overrides", () => {
    expect(automationQueryOverrides(null)).toEqual({});
    expect(automationQueryOverrides(undefined)).toEqual({});
  });
  it("guardrails pass through; '*' keeps tools option untouched", () => {
    expect(automationQueryOverrides(cfg({ maxTurns: 50, maxBudgetUsd: 0.25 }))).toEqual({
      maxTurns: 50,
      maxBudgetUsd: 0.25,
    });
  });
  it("explicit builtin list narrows visibility (protocol kept for future presets)", () => {
    expect(automationQueryOverrides(cfg({ tools: ["Read"] }))).toEqual({ tools: ["Read"] });
  });
  it("zero/undefined guardrails are dropped", () => {
    expect(automationQueryOverrides(cfg({ maxTurns: 0, maxBudgetUsd: 0 }))).toEqual({});
  });
});

describe("filterMcpServers", () => {
  it("keeps only allowlisted servers", () => {
    const servers = {
      "aide-codegraph": { type: "sdk" },
      "aide-docs": { type: "sdk" },
      "user-server": { command: "x" },
    };
    expect(Object.keys(filterMcpServers(servers, ["aide-codegraph"]))).toEqual(["aide-codegraph"]);
    expect(filterMcpServers(servers, [])).toEqual({});
  });
});
