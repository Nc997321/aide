// turnMessages 直测：拆分后回合分派是纯函数（状态全经 TurnContext 注入）。
// mapper/imageRollback 打桩——本文件只钉「分派与顺序语义」，消息内容映射归 mapper.test。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// 桩签名带形参：vi.fn() 零参签名会导致调用点 TS2554（Expected 0 arguments）
const mapSdkMessage = vi.fn((..._args: unknown[]) => undefined);
// isErrorResult 桩：缺省 false（良性/成功），terminate 臂测试里翻 true——
// 真实谓词的形状判别归 mapper.test.ts 直测，这里只钉「分派语义」。
const isErrorResult = vi.fn((_msg: unknown) => false);
vi.mock("../mapper.js", () => ({
  mapSdkMessage: (...args: unknown[]) => mapSdkMessage(...args),
  isErrorResult: (msg: unknown) => isErrorResult(msg),
}));
const detectImageUnsupported = vi.fn((_msg: unknown) => false);
vi.mock("../imageRollback.js", () => ({
  detectImageUnsupported: (msg: unknown) => detectImageUnsupported(msg),
}));

import { handleQueryMessage, type TurnContext } from "./turnMessages.js";

function stubCtx(over: Partial<TurnContext> = {}): TurnContext {
  return {
    isAutomation: () => false,
    markImageRollback: vi.fn(),
    setTurnActive: vi.fn(),
    applyPlanMode: vi.fn(),
    emit: vi.fn(),
    mapperDeps: {} as TurnContext["mapperDeps"],
    onUserReplay: vi.fn(),
    onCommandLifecycle: vi.fn(),
    onSessionInit: vi.fn(),
    onMainThreadAssistant: vi.fn(),
    onResult: vi.fn(),
    ...over,
  } as TurnContext;
}

const q = {} as Query;
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

beforeEach(() => {
  mapSdkMessage.mockClear();
  detectImageUnsupported.mockReset().mockReturnValue(false);
  isErrorResult.mockReset().mockReturnValue(false);
});

describe("handleQueryMessage", () => {
  it("图片 400：普通会话命中检测 → markImageRollback；automation 一次性会话不标", () => {
    detectImageUnsupported.mockReturnValue(true);
    const ctx = stubCtx();
    handleQueryMessage(msg({ type: "assistant" }), q, ctx);
    expect(ctx.markImageRollback).toHaveBeenCalled();

    const autCtx = stubCtx({ isAutomation: () => true });
    handleQueryMessage(msg({ type: "assistant" }), q, autCtx);
    expect(autCtx.markImageRollback).not.toHaveBeenCalled();
  });

  it("用户消息回显 → onUserReplay(uuid) + continue，不进 mapper；子代理回显不认", () => {
    const ctx = stubCtx();
    const out = handleQueryMessage(msg({ type: "user", isReplay: true, uuid: "q-1", parent_tool_use_id: null, message: { content: "hi" } }), q, ctx);
    expect(out).toBe("continue");
    expect(ctx.onUserReplay).toHaveBeenCalledWith("q-1");
    expect(mapSdkMessage).not.toHaveBeenCalled();
    handleQueryMessage(msg({ type: "user", isReplay: true, uuid: "q-2", parent_tool_use_id: "t", message: { content: "x" } }), q, ctx);
    expect(ctx.onUserReplay).toHaveBeenCalledTimes(1);
  });

  it("命令生命周期帧 → onCommandLifecycle(uuid, state) + continue，不进 mapper", () => {
    const ctx = stubCtx();
    const out = handleQueryMessage(msg({ type: "command_lifecycle", command_uuid: "u1", state: "started" }), q, ctx);
    expect(out).toBe("continue");
    expect(ctx.onCommandLifecycle).toHaveBeenCalledWith("u1", "started");
    expect(mapSdkMessage).not.toHaveBeenCalled();
  });

  it("result → 正常走 mapSdkMessage + onResult", () => {
    const ctx = stubCtx();
    const out = handleQueryMessage(msg({ type: "result" }), q, ctx);
    expect(out).toBeUndefined();
    expect(mapSdkMessage).toHaveBeenCalled();
    expect(ctx.onResult).toHaveBeenCalledWith(q);
  });

  it("错误终态 result → terminate（F3：先 map 错误帧 + onResult，再发终止信号）", () => {
    isErrorResult.mockReturnValue(true);
    const ctx = stubCtx();
    const out = handleQueryMessage(msg({ type: "result", subtype: "error_during_execution" }), q, ctx);
    expect(out).toBe("terminate");
    expect(mapSdkMessage).toHaveBeenCalled();          // 错误帧必须先发出去
    expect(ctx.onResult).toHaveBeenCalledWith(q);      // 遥测/自毁调度不受影响
  });

  it("良性打断（interrupt）result 不 terminate——isErrorResult 为 false 即原 query 存活（B5 契约）", () => {
    const ctx = stubCtx();
    const out = handleQueryMessage(msg({ type: "result", subtype: "error_during_execution" }), q, ctx);
    expect(out).toBeUndefined();
    expect(isErrorResult).toHaveBeenCalled();
  });

  it("主线程 assistant 带 EnterPlanMode tool_use → applyPlanMode；子代理/无块不触发", () => {
    const planMsg = msg({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "EnterPlanMode" }] },
    });
    const ctx = stubCtx();
    handleQueryMessage(planMsg, q, ctx);
    expect(ctx.applyPlanMode).toHaveBeenCalledTimes(1);

    const subMsg = msg({
      type: "assistant",
      parent_tool_use_id: "p1",
      message: { content: [{ type: "tool_use", name: "EnterPlanMode" }] },
    });
    handleQueryMessage(subMsg, q, ctx);
    expect(ctx.applyPlanMode).toHaveBeenCalledTimes(1); // 子代理不污染主线程模式

    const strCtx = stubCtx();
    handleQueryMessage(msg({ type: "assistant", message: { content: "plain-string" } }), q, strCtx);
    expect(strCtx.applyPlanMode).not.toHaveBeenCalled(); // 字符串 content 防御
  });

  it("每条消息都过 mapSdkMessage（emit + mapperDeps 原样传）", () => {
    const ctx = stubCtx();
    handleQueryMessage(msg({ type: "stream_event" }), q, ctx);
    expect(mapSdkMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "stream_event" }),
      ctx.emit,
      ctx.mapperDeps,
    );
  });

  it("system/init → onSessionInit(session_id, q)；不走 assistant/result 分支", () => {
    const ctx = stubCtx();
    handleQueryMessage(msg({ type: "system", subtype: "init", session_id: "sid-9" }), q, ctx);
    expect(ctx.onSessionInit).toHaveBeenCalledWith("sid-9", q);
    expect(ctx.onMainThreadAssistant).not.toHaveBeenCalled();
  });

  it("主线程 assistant → onMainThreadAssistant；带 parent_tool_use_id 不分派", () => {
    const ctx = stubCtx();
    const m = msg({ type: "assistant", message: { content: [] } });
    handleQueryMessage(m, q, ctx);
    expect(ctx.onMainThreadAssistant).toHaveBeenCalledWith(m);
    handleQueryMessage(msg({ type: "assistant", parent_tool_use_id: "p", message: { content: [] } }), q, ctx);
    expect(ctx.onMainThreadAssistant).toHaveBeenCalledTimes(1);
  });
});
