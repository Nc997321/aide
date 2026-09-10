import { describe, it, expect, vi } from "vitest";
import { applyModelSwitch, type ModelSettable } from "./modelSwitch.js";
import type { ChatEvent, ModelOption } from "./types.js";

const MODELS: ModelOption[] = [
  { value: "sonnet", displayName: "Sonnet" },
  { value: "opus", displayName: "Opus" },
];

function setup(currentModel = "sonnet", query: ModelSettable | null = null) {
  const events: ChatEvent[] = [];
  const committed: string[] = [];
  applyModelSwitch({
    model: "opus",
    query,
    models: MODELS,
    currentModel,
    emit: (e) => events.push(e),
    commit: (m) => committed.push(m),
  });
  return { events, committed };
}

/** 等 setModel 的 .then/.catch 微任务链跑完。 */
const flush = () => new Promise((r) => setImmediate(r));

describe("applyModelSwitch", () => {
  it("query 未起：本地落账 + 广播同步下拉，不发切换回执", () => {
    const { events, committed } = setup("sonnet", null);
    expect(committed).toEqual(["opus"]);
    expect(events).toEqual([
      { type: "models_available", models: MODELS, current: "opus" },
    ]);
  });

  it("切换成功：零本地副作用（坐实/广播/回执全部交给 PostModelSwitch 的 model_committed 链——SDK 不保证 hook deny 后 setModel 必 reject，.then 的坐实会把被拒模型写进账面）", async () => {
    const setModel = vi.fn(() => Promise.resolve());
    const { events, committed } = setup("sonnet", { setModel });
    expect(setModel).toHaveBeenCalledWith("opus");
    await flush();
    expect(committed).toEqual([]);
    expect(events).toEqual([]);
  });

  it("切换失败（CLI 驳回）：不坐实、回滚广播拉回旧值、失败回执带原因", async () => {
    const setModel = vi.fn(() => Promise.reject(new Error("model_not_found")));
    const { events, committed } = setup("sonnet", { setModel });
    await flush();
    expect(committed).toEqual([]);
    expect(events).toEqual([
      { type: "models_available", models: MODELS, current: "sonnet" },
      {
        type: "model_switch_result",
        ok: false,
        model: "opus",
        display: "Opus",
        error: "model_not_found",
      },
    ]);
  });

  it("模型不在已知列表里：成功链路零副作用（display 组装随回执一并移至 model_committed 链路）", async () => {
    const events: ChatEvent[] = [];
    applyModelSwitch({
      model: "some-third-party-id",
      query: { setModel: () => Promise.resolve() },
      models: MODELS,
      currentModel: "sonnet",
      emit: (e) => events.push(e),
      commit: () => {},
    });
    await flush();
    expect(events).toEqual([]);
  });

  it("同值/空值守卫：不坐实、不广播、不回执", () => {
    const setModel = vi.fn(() => Promise.resolve());
    const events: ChatEvent[] = [];
    const commit = vi.fn();
    const base = {
      query: { setModel } as ModelSettable,
      models: MODELS,
      emit: (e: ChatEvent) => events.push(e),
      commit,
    };
    applyModelSwitch({ ...base, model: "sonnet", currentModel: "sonnet" });
    applyModelSwitch({ ...base, model: "", currentModel: "sonnet" });
    expect(setModel).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
