import { describe, it, expect } from "vitest";
import { ModelRoster, versionedLabel } from "./modelRoster.js";
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
    const models = await r.adoptFromInit(fakeQuery(INIT_MODELS), "");
    expect(models).toEqual([
      { value: "claude-sonnet-5", displayName: "Sonnet" },
      { value: "claude-opus-5", displayName: "Opus" },
    ]);
    expect(r.models).toEqual(models);
    // 真名 → SDK 别名互译
    expect(r.toSdkModel("claude-sonnet-5")).toBe("sonnet");
    expect(r.toSdkModel("unknown-model")).toBe("unknown-model"); // 无别名回退真名
  });

  // 现场回放（2026-09-13）：deepseek provider 四个映射槽（opus/sonnet/haiku/subagent）
  // 全填同一个模型时，CLI 按「槽位」回报三行同真名条目 → 下拉多行同时打勾。
  it("多槽同真名 → 按真名去重只留首条（value 是下拉的身份，不许重复）", async () => {
    const r = new ModelRoster();
    const models = await r.adoptFromInit(fakeQuery([
      { value: "default", displayName: "Default (recommended)", resolvedModel: "deepseek-flash[1m]" },
      { value: "opus", displayName: "deepseek-flash", resolvedModel: "deepseek-flash" },
      { value: "sonnet", displayName: "deepseek-flash", resolvedModel: "deepseek-flash" },
      { value: "haiku", displayName: "deepseek-flash", resolvedModel: "deepseek-flash" },
    ]), "");
    // 真名不同的行必须原样保留（去重不能把 default 那行也吞掉）
    expect(models).toEqual([
      { value: "deepseek-flash[1m]", displayName: "Default (recommended)" },
      { value: "deepseek-flash", displayName: "deepseek-flash" },
    ]);
    // 别名表同口径：重复行不再互相覆盖（原先最后一条 haiku 胜出）
    expect(r.toSdkModel("deepseek-flash")).toBe("opus");
    expect(r.toSdkModel("deepseek-flash[1m]")).toBe("default");
  });

  it("无 resolvedModel 的模型（第三方 provider）：value 即真名，无别名回退", async () => {
    const r = new ModelRoster();
    const models = await r.adoptFromInit(fakeQuery([
      { value: "glm-5", displayName: "GLM 5" }, // 无 resolvedModel → ?? 回退臂
    ]), "");
    expect(models).toEqual([{ value: "glm-5", displayName: "GLM 5" }]);
    expect(r.toSdkModel("glm-5")).toBe("glm-5");
  });

  it("init 失败（SDK 不支持）→ null，名册不动", async () => {
    const r = new ModelRoster();
    const q = { initializationResult: async () => { throw new Error("unsupported"); } } as unknown as Query;
    expect(await r.adoptFromInit(q, "")).toBeNull();
    expect(r.models).toEqual([]);
  });
});

describe("ModelRoster.resolveDropdownValue", () => {
  it("无法匹配的实际模型加入选项，UI 不会误选列表首项", async () => {
    const r = new ModelRoster();
    await r.adoptFromInit(fakeQuery(INIT_MODELS), "claude-sonnet-5");
    expect(r.adoptConcreteModel("gateway-model-261017")).toBe("gateway-model-261017");
    r.adoptConcreteModel("gateway-model-261017");
    expect(r.models.filter(m => m.value === "gateway-model-261017")).toEqual([
      { value: "gateway-model-261017", displayName: "gateway-model-261017" },
    ]);
  });
  it("运行时数字版本用横杠并带日期：匹配配置中的点号版本，不落到默认 Kimi", async () => {
    const r = new ModelRoster();
    await r.adoptFromInit(fakeQuery([
      { value: "default", displayName: "Kimi", resolvedModel: "kimi-k3.1-pro[1m]" },
      { value: "sonnet", displayName: "DeepSeek", resolvedModel: "deepseek-v4.1-flash" },
    ]), "deepseek-v4.1-flash");
    expect(r.resolveDropdownValue("deepseek-v4-1-flash-261017")).toBe("deepseek-v4.1-flash");
  });

  it("多个数字版本写法同时存在时不猜测，保留实际回报", async () => {
    const r = new ModelRoster();
    await r.adoptFromInit(fakeQuery([
      { value: "a", displayName: "A", resolvedModel: "model-v4.1" },
      { value: "b", displayName: "B", resolvedModel: "model-v4-1" },
    ]), "model-v4.1");
    expect(r.resolveDropdownValue("model-v4-1-261017")).toBe("model-v4-1");
    expect(r.resolveDropdownValue("model-v4.1-261017")).toBe("model-v4.1");
    expect(r.resolveDropdownValue("another-model-261017")).toBe("another-model-261017");
  });
  it("精确命中 / 变体后缀前缀归一 / 未知原样", async () => {
    const r = new ModelRoster();
    await r.adoptFromInit(fakeQuery(INIT_MODELS), "");
    expect(r.resolveDropdownValue("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(r.resolveDropdownValue("claude-sonnet-5-20260101")).toBe("claude-sonnet-5");
    expect(r.resolveDropdownValue("glm-5.3-flash")).toBe("glm-5.3-flash");
  });

  it("空名册：wire id 原样返回", () => {
    expect(new ModelRoster().resolveDropdownValue("any")).toBe("any");
  });
});

// 两代 CLI 的真实回报（2026-10-12 用 initializationResult 现取）：版本一代在 description
// 首段、一代在 displayName。两种都要落成带版本的显示名。
describe("versionedLabel", () => {
  it("旧形态：版本在 description 首段 → 取首段", () => {
    expect(versionedLabel({ value: "opus", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks" })).toBe("Opus 5.5");
    expect(versionedLabel({ value: "claude-fable-5-1[1m]", displayName: "Fable", description: "Fable 5.1 · Most capable · $10/$50 per Mtok" })).toBe("Fable 5.1");
  });

  it("新形态：displayName 自带版本 → 原样（description 只剩一句介绍）", () => {
    expect(versionedLabel({ value: "haiku", displayName: "Haiku 5.5", description: "Fastest for quick answers" })).toBe("Haiku 5.5");
  });

  it("默认槽 → 实际指向的模型名 +（默认）", () => {
    expect(versionedLabel({ value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" })).toBe("Opus 5.5（默认）");
  });

  it("配了模型映射的供应商：默认槽取 (currently …) 里的真名", () => {
    expect(versionedLabel({ value: "default", displayName: "Default (recommended)", description: "Use the default model (currently glm-5.3:cloud[1m])" })).toBe("glm-5.3:cloud[1m]（默认）");
    // 认不出指向谁 → 原样
    expect(versionedLabel({ value: "default", displayName: "Default (recommended)", description: "Use the default model" })).toBe("Default (recommended)");
  });

  it("认不出版本就不动：第三方真名、无 description、首段与显示名不是一回事", () => {
    expect(versionedLabel({ value: "opus", displayName: "deepseek-flash" })).toBe("deepseek-flash");
    expect(versionedLabel({ value: "sonnet", displayName: "Sonnet" })).toBe("Sonnet");
    expect(versionedLabel({ value: "sonnet", displayName: "Sonnet", description: "Efficient for routine tasks" })).toBe("Sonnet");
    expect(versionedLabel({ value: "x", displayName: "Custom", description: "Uses 2x credits · beta" })).toBe("Custom");
    // 一句话介绍碰巧带数字，不是模型名
    expect(versionedLabel({ value: "opus", displayName: "Opus", description: "Opus is 2x faster than before (beta)" })).toBe("Opus");
  });
});

describe("ModelRoster.sdkRoster", () => {
  it("保留 SDK 自己的 value 且不去重——默认槽与 opus 同真名时 opus 行仍在", async () => {
    const r = new ModelRoster();
    await r.adoptFromInit(fakeQuery([
      { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5-5", description: "Opus 5.5 · Best" },
      { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5", description: "Opus 5.5 · Best" },
      { value: "<default>", displayName: "<default>" },
    ]), "");
    expect(r.models).toEqual([{ value: "claude-opus-5-5", displayName: "Opus 5.5（默认）" }]);
    expect(r.sdkRoster).toEqual([
      { value: "default", displayName: "Opus 5.5（默认）" },
      { value: "opus", displayName: "Opus 5.5" },
    ]);
  });
});

// CLI 0.3.296 的真实回报（2026-10-12 现取，节选）：槽位行之外还有一串钉死的旧型号。
describe("ModelRoster：钉死型号行只留当前在用的", () => {
  const OFFICIAL = [
    { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5-5", description: "Opus 5.5 · Best for everyday, complex tasks" },
    { value: "opus", displayName: "Opus 5.5", resolvedModel: "claude-opus-5-5", description: "For complex work and everyday tasks" },
    { value: "sonnet", displayName: "Sonnet 5.5", resolvedModel: "claude-sonnet-5-5", description: "Most efficient for simpler tasks" },
    { value: "fable", displayName: "Fable 5.1", resolvedModel: "claude-fable-5-1", description: "For your toughest challenges" },
    { value: "haiku", displayName: "Haiku 5.5", resolvedModel: "claude-haiku-5-5", description: "Fastest for quick answers" },
    { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", resolvedModel: "claude-haiku-4-5-20251001", description: "Fastest for quick answers" },
    { value: "claude-opus-4-8", displayName: "Opus 4.8", resolvedModel: "claude-opus-4-8", description: "Best for everyday, complex tasks" },
  ];

  it("新会话：下拉只有槽位行，旧型号不进", async () => {
    const r = new ModelRoster();
    const models = await r.adoptFromInit(fakeQuery(OFFICIAL), "claude-opus-5-5");
    expect(models!.map((m) => m.displayName)).toEqual(["Opus 5.5（默认）", "Sonnet 5.5", "Fable 5.1", "Haiku 5.5"]);
    // 给宿主的清单同样不含旧型号（否则别名会被首词同名的旧型号贴错标签）
    expect(r.sdkRoster.map((m) => m.value)).toEqual(["default", "opus", "sonnet", "fable", "haiku"]);
  });

  it("老会话正用着旧型号：它留在自己的下拉里", async () => {
    const r = new ModelRoster();
    const models = await r.adoptFromInit(fakeQuery(OFFICIAL), "claude-opus-4-8");
    expect(models!.map((m) => m.value)).toContain("claude-opus-4-8");
    expect(models!.map((m) => m.value)).not.toContain("claude-haiku-4-5-20251001");
  });

  it("第三方供应商：混进来的官方 Fable（钉死行）不进下拉，映射槽都在", async () => {
    const r = new ModelRoster();
    const models = await r.adoptFromInit(fakeQuery([
      { value: "default", displayName: "Default (recommended)", resolvedModel: "glm-5.3:cloud[1m]", description: "Use the default model (currently glm-5.3:cloud[1m])" },
      { value: "opus", displayName: "glm-5.3:cloud", resolvedModel: "glm-5.3:cloud", description: "Custom Opus model" },
      { value: "claude-fable-5-1[1m]", displayName: "Fable", resolvedModel: "claude-fable-5-1[1m]", description: "Fable 5.1 · Most capable" },
      { value: "sonnet", displayName: "deepseek-v4.1-flash:cloud", resolvedModel: "deepseek-v4.1-flash:cloud", description: "Custom Sonnet model" },
    ]), "glm-5.3:cloud");
    expect(models!.map((m) => m.displayName)).toEqual(["glm-5.3:cloud[1m]（默认）", "glm-5.3:cloud", "deepseek-v4.1-flash:cloud"]);
  });
});
