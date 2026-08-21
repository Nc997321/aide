import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolveClaudeExe } from "./claudeExe.js";

describe("resolveClaudeExe", () => {
  it("prefers AIDE_CLAUDE_EXE env var", () => {
    process.env.AIDE_CLAUDE_EXE = "C:/fake/claude.exe";
    expect(resolveClaudeExe()).toBe("C:/fake/claude.exe");
    delete process.env.AIDE_CLAUDE_EXE;
  });

  it("falls back to resolving the platform package from the SDK", () => {
    delete process.env.AIDE_CLAUDE_EXE;
    const exe = resolveClaudeExe();
    expect(exe).toBeTruthy();
    expect(existsSync(exe!)).toBe(true);
  });
});
