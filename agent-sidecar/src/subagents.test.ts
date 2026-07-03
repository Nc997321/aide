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
  it("extracts agentName/description from input on handleToolUse", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", {
      subagent_type: "general-purpose",
      description: "调研 XXX 的实现方式",
    });
    expect(result).toEqual({ agentName: "general-purpose", description: "调研 XXX 的实现方式" });
  });

  it("defaults agentName to 'agent' and description to '' when input is missing fields", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", {});
    expect(result).toEqual({ agentName: "agent", description: "" });
  });

  it("defaults safely when input is not an object", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", null);
    expect(result).toEqual({ agentName: "agent", description: "" });
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
