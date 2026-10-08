import { describe, it, expect } from "vitest";
import { parseGitError } from "./errors";

describe("parseGitError", () => {
  it("未知错误码：多行 stderr 完整保留，不止第一行（真正原因在 fatal: 那几行）", () => {
    const raw =
      "UNKNOWN_ERROR: Cloning into '/x/claude-community'...\nfatal: unable to access 'https://github.com/a/b.git/': GnuTLS recv error (-110)";
    const e = parseGitError(raw);
    expect(e.code).toBe("UNKNOWN_ERROR");
    expect(e.message).toContain("Cloning into");
    expect(e.message).toContain("fatal: unable to access");
  });

  it("已知错误码仍给友好文案与动作", () => {
    const e = parseGitError("NETWORK_FAILURE: fatal: Could not resolve host: github.com");
    expect(e.code).toBe("NETWORK_FAILURE");
    expect(e.actions.map((a) => a.kind)).toContain("go-proxy-settings");
  });

  it("无错误码前缀：原样展示", () => {
    expect(parseGitError("boom").message).toBe("boom");
  });
});
