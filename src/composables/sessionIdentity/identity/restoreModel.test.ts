import { describe, it, expect } from "vitest";
import { restoreModel } from "./restoreModel";
import type { ModelOption } from "@/types/chat";

const models = (vals: string[]): ModelOption[] => vals.map((v) => ({ value: v, displayName: v }));

describe("restoreModel (L2 恢复通道)", () => {
  it("remembered 在列表 → 直选（不走 pickModelValue）", () => {
    expect(restoreModel(models(["kimi", "k2"]), "kimi")).toBe("kimi");
  });
  it("remembered 不在列表 → 列表首项（applyDefault 语义）", () => {
    expect(restoreModel(models(["kimi", "k2"]), "deepseek")).toBe("kimi");
  });
  it("remembered null → 列表首项", () => {
    expect(restoreModel(models(["kimi", "k2"]), null)).toBe("kimi");
  });
  it("空列表 + remembered → ''（pickModelValue 空列表返回空）", () => {
    expect(restoreModel([], "kimi")).toBe("");
  });
  it("空列表 + null → ''", () => {
    expect(restoreModel([], null)).toBe("");
  });
});