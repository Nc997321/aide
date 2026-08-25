import { describe, it, expect } from "vitest";
import { resolveEffectiveModel, resolveEffectiveProvider } from "./resolver";

describe("resolver (L2 纯函数)", () => {
  describe("resolveEffectiveModel", () => {
    it("draft 在列表 → 优先", () => {
      expect(resolveEffectiveModel({ draft: "d", runtime: "r", restored: "s" }, ["d", "r", "s", "L1"])).toBe("d");
    });
    it("draft 不在列表 → 跳过到 runtime", () => {
      expect(resolveEffectiveModel({ draft: "d", runtime: "r", restored: "s" }, ["r", "s", "L1"])).toBe("r");
    });
    it("runtime 在列表 → 次之（draft 空/不在列表）", () => {
      expect(resolveEffectiveModel({ draft: "", runtime: "r", restored: "s" }, ["r", "s", "L1"])).toBe("r");
    });
    it("runtime 别名不在列表 → 跳过（不污染下拉）", () => {
      expect(resolveEffectiveModel({ draft: "", runtime: "sonnet", restored: "deepseek-v4-flash" }, ["deepseek-v4-flash", "k2"])).toBe("deepseek-v4-flash");
    });
    it("restored 在列表 → 再次（draft/runtime 不在列表）", () => {
      expect(resolveEffectiveModel({ draft: "", runtime: "", restored: "s" }, ["s", "L1"])).toBe("s");
    });
    it("全不在列表 → currentList[0]", () => {
      expect(resolveEffectiveModel({ draft: "d", runtime: "r", restored: "s" }, ["L1", "L2"])).toBe("L1");
    });
    it("全空 + currentList 空 → ''", () => {
      expect(resolveEffectiveModel({ draft: "", runtime: "", restored: "" }, [])).toBe("");
    });
  });

  describe("resolveEffectiveProvider", () => {
    it("bound 优先", () => {
      expect(resolveEffectiveProvider("p_a", "p_b")).toBe("p_a");
    });
    it("bound null → active", () => {
      expect(resolveEffectiveProvider(null, "p_b")).toBe("p_b");
    });
  });
});