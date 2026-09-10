import { describe, it, expect } from "vitest";
import { SubagentTracker } from "./subagents.js";

describe("SubagentTracker.isSubagentTool", () => {
  it("recognizes Agent and Task (pre/post CC v2.1.63 rename)", () => {
    expect(SubagentTracker.isSubagentTool("Agent")).toBe(true);
    expect(SubagentTracker.isSubagentTool("Task")).toBe(true);
  });

  it("rejects other tool names", () => {
    expect(SubagentTracker.isSubagentTool("Bash")).toBe(false);
    expect(SubagentTracker.isSubagentTool("TaskCreate")).toBe(false);
  });
});

describe("SubagentTracker lifecycle", () => {
  it("extracts agentName/description/prompt from input on handleToolUse", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", {
      subagent_type: "general-purpose",
      description: "调研 XXX 的实现方式",
      prompt: "调研 XXX 的实现方式，给出可行方案与文件清单",
    });
    expect(result).toEqual({
      agentName: "general-purpose",
      description: "调研 XXX 的实现方式",
      prompt: "调研 XXX 的实现方式，给出可行方案与文件清单",
    });
  });

  it("defaults agentName to 'agent' and description/prompt to '' when input is missing fields", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", {});
    expect(result).toEqual({ agentName: "agent", description: "", prompt: "" });
  });

  it("defaults safely when input is not an object", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", null);
    expect(result).toEqual({ agentName: "agent", description: "", prompt: "" });
  });

  it("handleToolResult returns true and clears a tracked id", () => {
    const t = new SubagentTracker();
    t.handleToolUse("u1", { subagent_type: "general-purpose", description: "x" });
    expect(t.handleToolResult("u1")).toBe(true);
    // 同一个 id 第二次不再算 tracked（已被消费）
    expect(t.handleToolResult("u1")).toBe(false);
  });

  it("handleToolResult returns false for an id it never saw", () => {
    const t = new SubagentTracker();
    expect(t.handleToolResult("ghost")).toBe(false);
  });
});

describe("SubagentTracker.isActive / claimModelReport", () => {
  it("isActive is true only between handleToolUse and handleToolResult", () => {
    const t = new SubagentTracker();
    expect(t.isActive("u1")).toBe(false);
    t.handleToolUse("u1", { subagent_type: "general-purpose", description: "x" });
    expect(t.isActive("u1")).toBe(true);
    t.handleToolResult("u1");
    expect(t.isActive("u1")).toBe(false);
  });

  it("claimModelReport grants the report exactly once for an active id", () => {
    const t = new SubagentTracker();
    t.handleToolUse("u1", { subagent_type: "general-purpose", description: "x" });
    expect(t.claimModelReport("u1")).toBe(true);
    expect(t.claimModelReport("u1")).toBe(false);
  });

  it("claimModelReport refuses ids that are not active", () => {
    const t = new SubagentTracker();
    expect(t.claimModelReport("ghost")).toBe(false);
  });

  it("a new tool_use with the same id after a prior result can claim the report again", () => {
    const t = new SubagentTracker();
    t.handleToolUse("u1", { subagent_type: "general-purpose", description: "x" });
    expect(t.claimModelReport("u1")).toBe(true);
    t.handleToolResult("u1");
    t.handleToolUse("u1", { subagent_type: "general-purpose", description: "y" });
    expect(t.claimModelReport("u1")).toBe(true);
  });
});

// 回归：权限弹窗要标注"这是哪个子代理在问"（见 permissions.ts 的 fromSubagent），
// 靠 canUseTool 收到的 agentID 反查这里存的 agentName——getAgentName 就是这条反查路径。
describe("SubagentTracker.getAgentName", () => {
  it("returns the agentName recorded at handleToolUse while the id is active", () => {
    const t = new SubagentTracker();
    t.handleToolUse("u1", { subagent_type: "code-reviewer", description: "审查 PR" });
    expect(t.getAgentName("u1")).toBe("code-reviewer");
  });

  it("returns undefined for an id it never saw (调用方应兜底成通用文案，而不是报错)", () => {
    const t = new SubagentTracker();
    expect(t.getAgentName("ghost")).toBeUndefined();
  });

  it("forgets the name once the subagent call resolves (handleToolResult)", () => {
    const t = new SubagentTracker();
    t.handleToolUse("u1", { subagent_type: "code-reviewer", description: "审查 PR" });
    t.handleToolResult("u1");
    expect(t.getAgentName("u1")).toBeUndefined();
  });
});
