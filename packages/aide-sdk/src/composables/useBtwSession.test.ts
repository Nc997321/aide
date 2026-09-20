import { describe, it, expect, beforeEach, vi } from "vitest";
import { useBtwSession, __resetBtwForTest } from "./useBtwSession";

// ── api 门面 mock（btw 侧问现在只经这一条命令出去） ──
const btwAskMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../api", () => ({
  api: {
    btwAsk: (...args: unknown[]) => btwAskMock(...args),
    stopChatSession: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  __resetBtwForTest();
  btwAskMock.mockClear();
  btwAskMock.mockResolvedValue(undefined);
});

/** 起一条 btw 并让它处于「等事件」态。 */
async function startBtwForTest(ownerSid: string, question: string) {
  const btw = useBtwSession();
  await btw.startBtw({ ownerSid, question });
  return btw;
}

describe("useBtwSession — 发起与事件渲染", () => {
  it("startBtw 调 btwAsk(sessionId=主会话, history=本地记忆)，且不下发正文", async () => {
    const { store } = await startBtwForTest("sid-1", "问题");
    expect(btwAskMock).toHaveBeenCalledWith({ sessionId: "sid-1", question: "问题", history: [] });
    // 正文一律等事件——命令已受理不等于有答案
    expect(store.value.messages).toEqual([]);
    expect(store.value.status).toBe("running");
  });

  it("btw_answer 事件才落正文，并完成收尾 + 批注回插", async () => {
    const done = vi.fn();
    const { store, setOnDone, handleBtwAnswer } = await startBtwForTest("sid-1", "问题");
    setOnDone(done);

    handleBtwAnswer({
      type: "btw_answer",
      session_id: "sid-1",
      question: "问题",
      response: "答案",
      synthetic: false,
    });

    expect(store.value.messages.join("")).toBe("答案");
    expect(store.value.isBusy).toBe(false);
    expect(store.value.done).toBe(true);
    expect(store.value.status).toBe("done");
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "btw", label: "问题", body: "答案" }),
    );
  });

  it("不属于本抽屉的事件被忽略（session 或 question 不匹配）", async () => {
    const { store, handleBtwAnswer } = await startBtwForTest("sid-1", "问题");
    handleBtwAnswer({
      type: "btw_answer",
      session_id: "别的会话",
      question: "问题",
      response: "不该出现",
    });
    handleBtwAnswer({
      type: "btw_answer",
      session_id: "sid-1",
      question: "别的问题",
      response: "也不该出现",
    });
    expect(store.value.messages).toEqual([]);
    expect(store.value.done).toBe(false);
  });

  it("btw_answer 带 error：进 error 态并露出抽屉（最小化也要弹回来）", async () => {
    const { store, handleBtwAnswer, minimize } = await startBtwForTest("sid-1", "问题");
    minimize();
    expect(store.value.minimized).toBe(true);

    handleBtwAnswer({
      type: "btw_answer",
      session_id: "sid-1",
      question: "问题",
      error: "会话未运行，先发一条消息再问",
    });

    expect(store.value.error).toContain("会话未运行");
    expect(store.value.status).toBe("error");
    expect(store.value.minimized).toBe(false);
    expect(store.value.isBusy).toBe(false);
  });

  it("btwAsk 被拒（命令没写进 sidecar）→ error 态", async () => {
    btwAskMock.mockRejectedValueOnce(new Error("Runtime 不可用"));
    const { store } = await startBtwForTest("sid-1", "问题");
    expect(store.value.status).toBe("error");
    expect(store.value.error).toContain("Runtime 不可用");
    expect(store.value.isBusy).toBe(false);
  });

  it("单实例：新 btw 替换旧的（旧抽屉不再吃事件）", async () => {
    const btw = await startBtwForTest("sid-1", "第一问");
    await btw.startBtw({ ownerSid: "sid-1", question: "第二问" });

    btw.handleBtwAnswer({
      type: "btw_answer",
      session_id: "sid-1",
      question: "第一问",
      response: "迟到的旧答案",
    });
    expect(btw.store.value.messages).toEqual([]); // 旧答案被 question 匹配挡住
    expect(btw.store.value.question).toBe("第二问");
  });
});

describe("useBtwSession — 跨问记忆（封顶 20 轮）", () => {
  it("下一轮 btw 把此前问答作为 history 参数传出去", async () => {
    const { handleBtwAnswer } = await startBtwForTest("sid-1", "第一问");
    handleBtwAnswer({
      type: "btw_answer",
      session_id: "sid-1",
      question: "第一问",
      response: "第一答",
    });

    await useBtwSession().startBtw({ ownerSid: "sid-1", question: "第二问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({
      sessionId: "sid-1",
      question: "第二问",
      history: [{ question: "第一问", response: "第一答" }],
    });
  });

  it("记忆按主会话隔离：另一个会话的 btw 看不到", async () => {
    const { handleBtwAnswer } = await startBtwForTest("sid-1", "问");
    handleBtwAnswer({ type: "btw_answer", session_id: "sid-1", question: "问", response: "答" });

    await useBtwSession().startBtw({ ownerSid: "sid-2", question: "别处问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({
      sessionId: "sid-2",
      question: "别处问",
      history: [],
    });
  });

  it("synthetic 兜底答复渲染但不入历史", async () => {
    const { handleBtwAnswer } = await startBtwForTest("sid-1", "问");
    handleBtwAnswer({
      type: "btw_answer",
      session_id: "sid-1",
      question: "问",
      response: "兜底答复",
      synthetic: true,
    });
    expect(useBtwSession().store.value.messages.join("")).toBe("兜底答复");

    await useBtwSession().startBtw({ ownerSid: "sid-1", question: "再问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({ sessionId: "sid-1", question: "再问", history: [] });
  });

  it("失败轮不入历史", async () => {
    const { handleBtwAnswer } = await startBtwForTest("sid-1", "问");
    handleBtwAnswer({ type: "btw_answer", session_id: "sid-1", question: "问", error: "挂了" });

    await useBtwSession().startBtw({ ownerSid: "sid-1", question: "再问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({ sessionId: "sid-1", question: "再问", history: [] });
  });

  it("超 20 轮丢最老（唯一护栏）", async () => {
    const btw = useBtwSession();
    for (let i = 1; i <= 22; i++) {
      await btw.startBtw({ ownerSid: "sid-1", question: `问${i}` });
      btw.handleBtwAnswer({
        type: "btw_answer",
        session_id: "sid-1",
        question: `问${i}`,
        response: `答${i}`,
      });
    }
    await btw.startBtw({ ownerSid: "sid-1", question: "最后一问" });
    const history = (btwAskMock.mock.calls.at(-1)![0] as any).history as {
      question: string;
    }[];
    expect(history).toHaveLength(20);
    expect(history[0].question).toBe("问3"); // 问1、问2 被挤掉
    expect(history.at(-1)!.question).toBe("问22");
  });

  it("clearBtwHistory 清空某主会话的记忆", async () => {
    const { handleBtwAnswer } = await startBtwForTest("sid-1", "问");
    handleBtwAnswer({ type: "btw_answer", session_id: "sid-1", question: "问", response: "答" });

    useBtwSession().clearBtwHistory("sid-1");
    await useBtwSession().startBtw({ ownerSid: "sid-1", question: "再问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({ sessionId: "sid-1", question: "再问", history: [] });
  });
});

describe("useBtwSession — 抽屉可见性与绑定迁移", () => {
  it("最小化不杀任何东西；重开只清标志", async () => {
    const { store, minimize, reopen } = await startBtwForTest("sid-1", "问");
    minimize();
    expect(store.value.minimized).toBe(true);
    reopen();
    expect(store.value.minimized).toBe(false);
    expect(store.value.status).toBe("running"); // 仍在等事件
  });

  it("rebindOwner 跟随主会话 temp→real：抽屉绑定与记忆 key 一起迁", async () => {
    const { store, handleBtwAnswer, rebindOwner } = await startBtwForTest("temp-1", "问");
    handleBtwAnswer({ type: "btw_answer", session_id: "temp-1", question: "问", response: "答" });

    rebindOwner("temp-1", "real-1");
    expect(store.value.ownerSessionId).toBe("real-1");

    await useBtwSession().startBtw({ ownerSid: "real-1", question: "再问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({
      sessionId: "real-1",
      question: "再问",
      history: [{ question: "问", response: "答" }],
    });
  });

  it("rebindOwner 对无关 id 是 no-op", async () => {
    const { store, rebindOwner } = await startBtwForTest("sid-1", "问");
    rebindOwner("别的", "另一个");
    expect(store.value.ownerSessionId).toBe("sid-1");
  });
});
