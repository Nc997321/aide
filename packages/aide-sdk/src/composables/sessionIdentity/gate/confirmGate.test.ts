import { describe, it, expect } from "vitest";
import { needsConfirm, buildConfirmDecision } from "./confirmGate";
import type { Identity } from "./confirmGate";

const id = (provider: string, model: string): Identity => ({ provider, model });

describe("confirmGate (L3 gate)", () => {
  describe("needsConfirm", () => {
    it("last=null → false（无基线不弹，本次 bug 回归点）", () => {
      expect(needsConfirm(id("p", "deepseek-v4-flash:0731-cloud"), null)).toBe(false);
    });

    it("provider 变 → true", () => {
      expect(needsConfirm(id("p_b", "m"), id("p_a", "m"))).toBe(true);
    });

    it("model 变 → true", () => {
      expect(needsConfirm(id("p", "m_b"), id("p", "m_a"))).toBe(true);
    });

    it("provider 和 model 都变 → true", () => {
      expect(needsConfirm(id("p_b", "m_b"), id("p_a", "m_a"))).toBe(true);
    });

    it("全同 → false", () => {
      expect(needsConfirm(id("p", "m"), id("p", "m"))).toBe(false);
    });

    it("空模型基线幂等：last.model='' 与 effective.model='' 同 → false（不自我误弹）", () => {
      expect(needsConfirm(id("p", ""), id("p", ""))).toBe(false);
    });

    it("空模型基线切到非空 → true（确实从无模型切到有模型）", () => {
      expect(needsConfirm(id("p", "deepseek-v4-flash:0731-cloud"), id("p", ""))).toBe(true);
    });
  });

  describe("buildConfirmDecision", () => {
    it("last=null → null", () => {
      expect(buildConfirmDecision(id("p", "m"), null)).toBeNull();
    });

    it("全同 → null", () => {
      expect(buildConfirmDecision(id("p", "m"), id("p", "m"))).toBeNull();
    });

    it("provider 变 model 同 → { changed: 'provider' }", () => {
      expect(buildConfirmDecision(id("p_b", "m"), id("p_a", "m"))).toEqual({
        changed: "provider",
        effective: id("p_b", "m"),
        last: id("p_a", "m"),
      });
    });

    it("model 变 provider 同 → { changed: 'model' }", () => {
      expect(buildConfirmDecision(id("p", "m_b"), id("p", "m_a"))).toEqual({
        changed: "model",
        effective: id("p", "m_b"),
        last: id("p", "m_a"),
      });
    });

    it("都变 → { changed: 'both' }", () => {
      expect(buildConfirmDecision(id("p_b", "m_b"), id("p_a", "m_a"))).toEqual({
        changed: "both",
        effective: id("p_b", "m_b"),
        last: id("p_a", "m_a"),
      });
    });
  });
});