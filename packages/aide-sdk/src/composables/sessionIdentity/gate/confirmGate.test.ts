import { describe, it, expect } from "vitest";
import { needsConfirm, buildConfirmDecision } from "./confirmGate";

/**
 * L3 门控（provider respawn 维度）的分支覆盖。模型维度的门控已废除
 * （切换确认在 SDK PreModelSwitch hook 的切换前弹窗，见 2026-09-01 设计稿 §2），
 * 本文件只断言供应商维度的「要不要弹」与决策包形状。
 */

describe("needsConfirm（provider 维度）", () => {
  it("同供应商 → false", () => {
    expect(needsConfirm("p-a", "p-a")).toBe(false);
  });
  it("供应商不同 → true", () => {
    expect(needsConfirm("p-b", "p-a")).toBe(true);
  });
  it("last=null（无基线）→ false（首次 spawn / 未知，不弹）", () => {
    expect(needsConfirm("p-a", null)).toBe(false);
  });
});

describe("buildConfirmDecision（provider 维度）", () => {
  it("全同 → null", () => {
    expect(buildConfirmDecision("p-a", "p-a")).toBeNull();
  });
  it("last=null → null", () => {
    expect(buildConfirmDecision("p-a", null)).toBeNull();
  });
  it("供应商变化 → 决策包含新旧 id", () => {
    expect(buildConfirmDecision("p-b", "p-a")).toEqual({ effective: "p-b", last: "p-a" });
  });
});