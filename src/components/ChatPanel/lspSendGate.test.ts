import { describe, it, expect } from "vitest";
import { lspPromptModel } from "./lspSendGate";

describe("lspSendGate 文案", () => {
  it("有要装的语言包：主按钮说清会先装", () => {
    expect(lspPromptModel([{ lang: "python", installed: false, packId: "python" }]).primaryLabel).toBe("安装并开启");
  });
});

describe("lspPromptModel", () => {
  it("列出语言名，不带内存说明（实际占用看「语言环境」面板）", () => {
    const m = lspPromptModel([{ lang: "java", installed: true }]);
    expect(m.primaryLabel).toBe("开启");
    expect(Object.keys(m)).not.toContain("memory");
  });
});
