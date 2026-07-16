import { describe, it, expect } from "vitest";
import { pickModelValue } from "./modelSelect";
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
});