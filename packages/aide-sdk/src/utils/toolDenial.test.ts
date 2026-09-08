import { describe, expect, it } from "vitest";
import { parseToolDenial } from "./toolDenial";

// 正文样本取自真实转录（2026-09-08 会话 3b366d2d）：CLI 原样落盘的 tool_result
// content，外框由 agent-sidecar 的 userDenyMessage 写入。
const REAL_USER_DENIAL = `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:
写入2，不要1`;

describe("parseToolDenial", () => {
  it("reads the real user-denial transcript shape back into kind + feedback", () => {
    expect(parseToolDenial(REAL_USER_DENIAL)).toEqual({
      kind: "user",
      reason: "写入2，不要1",
    });
  });

  it("returns user without a reason when the template carries no feedback", () => {
    // nhe 形态：用户点了拒绝但没填理由
    const content =
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
    expect(parseToolDenial(content)).toEqual({ kind: "user" });
  });

  it("separates a multi-line feedback from the template", () => {
    const content =
      "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\n别删目录\n改成只清 .tmp";
    expect(parseToolDenial(content)).toEqual({
      kind: "user",
      reason: "别删目录\n改成只清 .tmp",
    });
  });

  it("reads policy denials with the rule reason appended after a blank line", () => {
    const content =
      "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.\n\n策略禁止写入 .env";
    expect(parseToolDenial(content)).toEqual({
      kind: "policy",
      reason: "策略禁止写入 .env",
    });
  });

  it("returns policy without a reason when the rule carries none", () => {
    const content = "Permission for this tool use was denied. The tool use was rejected.";
    expect(parseToolDenial(content)).toEqual({ kind: "policy" });
  });

  it("stays null for ordinary output, real errors, and empty content", () => {
    expect(parseToolDenial("file created")).toBeNull();
    // 真报错：is_error 但正文是工具自己的错误信息
    expect(parseToolDenial("ENOENT: no such file or directory")).toBeNull();
    expect(parseToolDenial("")).toBeNull();
    expect(parseToolDenial(undefined)).toBeNull();
    expect(parseToolDenial(null)).toBeNull();
  });

  it("stays null for pre-2026-08-18 denial records (no frame → do not guess)", () => {
    // 历史转录里旧形态的槽位内容：裸的「用户拒绝」四字。没有外框就不认，
    // 调用方退回常规错误态——宁可少认，不可把正文当拒绝理由渲染出来。
    expect(parseToolDenial("用户拒绝")).toBeNull();
    expect(parseToolDenial("写入2")).toBeNull();
  });

  it("tolerates leading whitespace before the frame", () => {
    expect(parseToolDenial(`\n  ${REAL_USER_DENIAL}`)?.reason).toBe("写入2，不要1");
  });
});
