import { describe, it, expect } from "vitest";
import { pickModelValue, isModelInList } from "./modelSelect";
import type { ModelOption } from "../types/chat";

const opts = (vals: string[]): ModelOption[] =>
  vals.map((v) => ({ value: v, displayName: v }));

describe("pickModelValue", () => {
  // ── 根因 1：第三方 provider，sidecar 回报的 current 是 Claude 别名，
  //    但下拉列表装的是真实模型 id。采信别名会写下拉没有的值 → 显示空。
  it("第三方：sdkCurrent 别名不在列表里时，保留用户已选的真实 id，不写空", () => {
    const models = opts(["deepseek-v4-flash", "deepseek-reasoner"]);
    // 用户选了 deepseek-v4-flash；SDK 回报 current="sonnet"（别名，不在列表）
    expect(
      pickModelValue(models, "deepseek-v4-flash", "sonnet", "deepseek-v4-flash"),
    ).toBe("deepseek-v4-flash");
  });

  // ── 根因 2：系统默认 Claude，会话启动后 displayModels 从静态兜底切到 SDK 真实列表，
  //    用户选的 fable 不在 SDK 列表里。applyDefaultModel 走 sdkCurrent="" 路径，
  //    必须退化到 provider 默认 / 第一项，不能保留不在列表的 fable → 空下拉。
  it("系统默认：existing 不在新列表里、无 sdkCurrent 时，退化到列表第一项", () => {
    const sdkList = opts(["sonnet", "opus", "haiku"]);
    expect(pickModelValue(sdkList, "fable", "", "")).toBe("sonnet");
  });

  it("系统默认：existing 不在新列表、provider 默认在列表时，退化到 provider 默认", () => {
    const sdkList = opts(["sonnet", "opus", "haiku"]);
    expect(pickModelValue(sdkList, "fable", "", "haiku")).toBe("haiku");
  });

  // ── 正常路径：SDK 坐实的当前模型在列表里 → 采信，反映真实在跑的模型
  it("sdkCurrent 在列表里时采信它（反映 SDK 真实模型）", () => {
    const models = opts(["sonnet", "opus", "haiku"]);
    // existing=sonnet，但 SDK 回报 current=opus（运行时 setModel 切过）
    expect(pickModelValue(models, "sonnet", "opus", "sonnet")).toBe("opus");
  });

  it("运行时 setModel：existing 与 sdkCurrent 同值时返回该值", () => {
    const models = opts(["sonnet", "opus"]);
    expect(pickModelValue(models, "opus", "opus", "sonnet")).toBe("opus");
  });

  // ── 边界
  it("空列表返回空串", () => {
    expect(pickModelValue([], "sonnet", "opus", "haiku")).toBe("");
  });

  it("existing 在列表里、无 sdkCurrent 时保留 existing（尊重用户已选）", () => {
    const models = opts(["sonnet", "opus"]);
    expect(pickModelValue(models, "opus", "", "sonnet")).toBe("opus");
  });

  it("都没命中时返回列表第一项", () => {
    const models = opts(["sonnet", "opus"]);
    expect(pickModelValue(models, "fable", "fable", "fable")).toBe("sonnet");
  });

  it("sdkCurrent 为空串时不采信，退化到 existing/provider/first", () => {
    const models = opts(["sonnet", "opus"]);
    expect(pickModelValue(models, "", "", "")).toBe("sonnet");
  });

  // ── 回归：会话模型记忆恢复。existing 优先级高于 providerDefault 槽位——
  //    恢复 remembered 时若先落过占位默认（existing 被占），remembered 会永远
  //    输掉（停止会话切回来选择器停在默认模型的根因）。所以 ChatPanel 的恢复
  //    通道必须用 isModelInList 校验后直接选中，而不是再过一遍 pickModelValue。
  it("existing 优先级高于 providerDefault 槽位（恢复通道不能直接复用此函数）", () => {
    const models = opts(["default-model", "kimi-for-coding"]);
    expect(pickModelValue(models, "default-model", "", "kimi-for-coding")).toBe("default-model");
    // 正确姿势：existing 为空时 providerDefault 槽位才生效
    expect(pickModelValue(models, "", "", "kimi-for-coding")).toBe("kimi-for-coding");
  });
});

describe("isModelInList", () => {
  it("在列表里（含 remembered 恢复场景的真实 id）", () => {
    const models = opts(["default-model", "kimi-for-coding"]);
    expect(isModelInList(models, "kimi-for-coding")).toBe(true);
  });

  it("不在列表里（换过 provider 的旧记忆）→ false，调用方退默认", () => {
    const models = opts(["new-provider-model"]);
    expect(isModelInList(models, "kimi-for-coding")).toBe(false);
  });

  it("空值/空列表 → false", () => {
    expect(isModelInList(opts(["sonnet"]), "")).toBe(false);
    expect(isModelInList(opts(["sonnet"]), null)).toBe(false);
    expect(isModelInList(opts(["sonnet"]), undefined)).toBe(false);
    expect(isModelInList([], "sonnet")).toBe(false);
  });
});