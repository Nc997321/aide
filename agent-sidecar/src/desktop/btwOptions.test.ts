import { describe, it, expect } from "vitest";
import { btwQueryOverrides, forkResumeOptions } from "./btwOptions.js";

describe("btwQueryOverrides", () => {
  it("non-btw: no overrides", () => {
    expect(btwQueryOverrides(false)).toEqual({});
  });
  it("btw Q&A (lightweight or full): persistSession false only — 工具列表必须", () => {
    // 与主会话逐字节一致才能命中 prompt cache;「纯问答」由 policy hook 全 deny 实现。
    expect(btwQueryOverrides(true)).toEqual({ persistSession: false });
  });
  it("btw task (git-commit): persistSession false + tools/allowedTools 白名单", () => {
    expect(btwQueryOverrides(true, ["Bash", "Read"])).toEqual({
      persistSession: false,
      tools: ["Bash", "Read"],
      allowedTools: ["Bash", "Read"],
    });
  });
  it("btw task with empty tools: falls back to plain Q&A overrides", () => {
    expect(btwQueryOverrides(true, [])).toEqual({ persistSession: false });
  });
});

describe("forkResumeOptions", () => {
  it("no fork: plain resume", () => {
    expect(forkResumeOptions("s1", false)).toEqual({ resume: "s1" });
  });
  it("fork: resume + forkSession", () => {
    expect(forkResumeOptions("s1", true)).toEqual({ resume: "s1", forkSession: true });
  });
  it("no session id: empty", () => {
    expect(forkResumeOptions("", true)).toEqual({});
  });
});
