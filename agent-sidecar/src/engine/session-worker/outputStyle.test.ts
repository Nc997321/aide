import { describe, it, expect, vi, afterEach } from "vitest";
import { applyOutputStyle, normalizeOutputStyle } from "./outputStyle.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeOutputStyle", () => {
  it("四个内置样式原样返回", () => {
    expect(normalizeOutputStyle("Proactive")).toBe("Proactive");
    expect(normalizeOutputStyle("Concise")).toBe("Concise");
    expect(normalizeOutputStyle("Explanatory")).toBe("Explanatory");
    expect(normalizeOutputStyle("Learning")).toBe("Learning");
  });

  it("首尾空白归一后仍命中", () => {
    expect(normalizeOutputStyle("  Explanatory  ")).toBe("Explanatory");
  });

  it("default / 未知值 / 空 → null（不下发）", () => {
    expect(normalizeOutputStyle("default")).toBeNull();
    expect(normalizeOutputStyle("")).toBeNull();
    expect(normalizeOutputStyle("   ")).toBeNull();
    expect(normalizeOutputStyle(undefined)).toBeNull();
    expect(normalizeOutputStyle(null)).toBeNull();
    expect(normalizeOutputStyle("Turbo")).toBeNull();
  });

  it("大小写敏感：CLI 的样式名是 CamelCase，小写拼错算未知值", () => {
    expect(normalizeOutputStyle("explanatory")).toBeNull();
    expect(normalizeOutputStyle("PROACTIVE")).toBeNull();
  });
});

describe("applyOutputStyle", () => {
  it("null（默认/未知）直接跳过，不发控制请求", async () => {
    const applyFlagSettings = vi.fn(() => Promise.resolve());
    await applyOutputStyle(null, { applyFlagSettings });
    expect(applyFlagSettings).not.toHaveBeenCalled();
  });

  it("命中样式：调 applyFlagSettings({ outputStyle })", async () => {
    const applyFlagSettings = vi.fn(() => Promise.resolve());
    await applyOutputStyle("Explanatory", { applyFlagSettings });
    expect(applyFlagSettings).toHaveBeenCalledWith({ outputStyle: "Explanatory" });
  });

  it("CLI 驳回：只告警不抛（会话照常跑）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const applyFlagSettings = vi.fn(() => Promise.reject(new Error("unknown style")));

    await expect(applyOutputStyle("Learning", { applyFlagSettings })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("Learning");
  });
});
