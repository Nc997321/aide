import { describe, it, expect } from "vitest";
import { ModelRoster } from "./modelRoster.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

/** 最小 init 桩：只喂 initializationResult（Query 重型类型，桩可辩护）。 */
function fakeQuery(models: unknown[]): Query {
  return { initializationResult: async () => ({ models }) } as unknown as Query;
}

const INIT_MODELS = [
  { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5" },
  { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5" },
  // 占位 id 形如 <…>（isPlaceholderModelId 的尖括号语义）→ 被 filterSelectableModels 滤掉
  { value: "<default>", displayName: "<default>" },
];

describe("ModelRoster.adoptFromInit", () => {
  it("采纳 resolvedModel 真名列表 + 建别名表；占位模型被滤除", async () => {
    const r = new ModelRoster();
    const models = await r.adoptFromInit(fakeQuery(INIT_MODELS));
    expect(models).toEqual([
      { value: "claude-sonnet-5", displayName: "Sonnet" },
      { value: "claude-opus-5", displayName: "Opus" },
    ]);
    expect(r.models).toEqual(models);
    // 真名 → SDK 别名互译
    expect(r.toSdkModel("claude-sonnet-5")).toBe("sonnet");
    expect(r.toSdkModel("unknown-model")).toBe("unknown-model"); // 无别名回退真名
  });

  it("无 resolvedModel 的模型（第三方 provider）：value 即真名，无别名回退", async () => {
    const r = new ModelRoster();
    const models = await r.adoptFromInit(fakeQuery([
      { value: "glm-5", displayName: "GLM 5" }, // 无 resolvedModel → ?? 回退臂
    ]));
    expect(models).toEqual([{ value: "glm-5", displayName: "GLM 5" }]);
    expect(r.toSdkModel("glm-5")).toBe("glm-5");
  });

  it("init 失败（SDK 不支持）→ null，名册不动", async () => {
    const r = new ModelRoster();
    const q = { initializationResult: async () => { throw new Error("unsupported"); } } as unknown as Query;
    expect(await r.adoptFromInit(q)).toBeNull();
    expect(r.models).toEqual([]);
  });
});

describe("ModelRoster.resolveDropdownValue", () => {
  it("精确命中 / 变体后缀前缀归一 / 未知原样", async () => {
    const r = new ModelRoster();
    await r.adoptFromInit(fakeQuery(INIT_MODELS));
    expect(r.resolveDropdownValue("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(r.resolveDropdownValue("claude-sonnet-5-20260101")).toBe("claude-sonnet-5");
    expect(r.resolveDropdownValue("glm-5.3-flash")).toBe("glm-5.3-flash");
  });

  it("空名册：wire id 原样返回", () => {
    expect(new ModelRoster().resolveDropdownValue("any")).toBe("any");
  });
});
