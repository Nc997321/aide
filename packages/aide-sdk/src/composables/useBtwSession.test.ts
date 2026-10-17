import { describe, it, expect, beforeEach, vi } from "vitest";
import { useBtwSession, __resetBtwForTest } from "./useBtwSession";

// ── api 门面 mock（btw 侧问只经这一条命令出去） ──
const btwAskMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../api", () => ({
  api: {
    btwAsk: (...args: unknown[]) => btwAskMock(...args),
  },
}));

beforeEach(() => {
  __resetBtwForTest();
  btwAskMock.mockClear();
  btwAskMock.mockResolvedValue(undefined);
});

const answer = (sid: string, question: string, extra: Record<string, unknown>) =>
  useBtwSession().handleBtwAnswer({ type: "btw_answer", session_id: sid, question, ...extra });

/** 问一句并立刻答上（真实回答） */
async function askAndAnswer(sid: string, q: string, a: string) {
  await useBtwSession().ask({ ownerSid: sid, question: q });
  answer(sid, q, { response: a });
}

describe("useBtwSession — 发起与事件落账", () => {
  it("ask 调 btwAsk(sessionId=主会话, history=本线程记忆)，打开侧栏并追加在途一轮", async () => {
    const btw = useBtwSession();
    expect(await btw.ask({ ownerSid: "sid-1", question: "问题" })).toBe(true);
    expect(btwAskMock).toHaveBeenCalledWith({ sessionId: "sid-1", question: "问题", history: [] });
    const t = btw.threadFor("sid-1");
    expect(t.open).toBe(true);
    expect(t.rounds).toHaveLength(1);
    expect(t.rounds[0]).toMatchObject({ question: "问题", status: "pending", answer: null });
  });

  it("btw_answer 才落正文，并经 onDone 回插批注（带书签 id）", async () => {
    const done = vi.fn();
    const btw = useBtwSession();
    btw.setOnDone(done);
    await btw.ask({ ownerSid: "sid-1", question: "问题" });
    answer("sid-1", "问题", { response: "答案" });

    const r = btw.threadFor("sid-1").rounds[0];
    expect(r).toMatchObject({ status: "done", answer: "答案" });
    expect(done).toHaveBeenCalledWith(
      "sid-1",
      expect.objectContaining({ actionId: "btw", label: "问题", body: "答案", btwRoundId: r.id }),
    );
  });

  it("不属于本线程的事件被忽略（session 或 question 不匹配）", async () => {
    const btw = useBtwSession();
    await btw.ask({ ownerSid: "sid-1", question: "问题" });
    answer("别的会话", "问题", { response: "不该出现" });
    answer("sid-1", "别的问题", { response: "也不该出现" });
    expect(btw.threadFor("sid-1").rounds[0].status).toBe("pending");
  });

  it("btw_answer 带 error：这一轮进 error，不回插批注", async () => {
    const done = vi.fn();
    const btw = useBtwSession();
    btw.setOnDone(done);
    await btw.ask({ ownerSid: "sid-1", question: "问题" });
    answer("sid-1", "问题", { error: "会话未运行，先发一条消息再问" });
    expect(btw.threadFor("sid-1").rounds[0]).toMatchObject({ status: "error", error: expect.stringContaining("会话未运行") });
    expect(done).not.toHaveBeenCalled();
  });

  it("btwAsk 被拒（命令没写进 sidecar）→ 这一轮 error", async () => {
    btwAskMock.mockRejectedValueOnce(new Error("Runtime 不可用"));
    const btw = useBtwSession();
    await btw.ask({ ownerSid: "sid-1", question: "问题" });
    expect(btw.threadFor("sid-1").rounds[0]).toMatchObject({ status: "error", error: expect.stringContaining("Runtime 不可用") });
  });

  it("同一线程一次只有一问在途：在途时再问被拒", async () => {
    const btw = useBtwSession();
    await btw.ask({ ownerSid: "sid-1", question: "第一问" });
    expect(await btw.ask({ ownerSid: "sid-1", question: "第二问" })).toBe(false);
    expect(btw.threadFor("sid-1").rounds).toHaveLength(1);
    expect(btwAskMock).toHaveBeenCalledTimes(1);
  });

  it("不同主会话的线程互不阻塞", async () => {
    const btw = useBtwSession();
    await btw.ask({ ownerSid: "sid-1", question: "问" });
    expect(await btw.ask({ ownerSid: "sid-2", question: "问" })).toBe(true);
    answer("sid-2", "问", { response: "二的答" });
    expect(btw.threadFor("sid-1").rounds[0].status).toBe("pending");
    expect(btw.threadFor("sid-2").rounds[0].answer).toBe("二的答");
  });
});

describe("useBtwSession — 侧栏开合与未读", () => {
  it("侧栏关着时答复到达 → 未读；打开即清", async () => {
    const btw = useBtwSession();
    await btw.ask({ ownerSid: "sid-1", question: "问" });
    btw.closePanel("sid-1");
    answer("sid-1", "问", { response: "答" });
    expect(btw.threadFor("sid-1").unread).toBe(true);
    btw.openPanel("sid-1");
    expect(btw.threadFor("sid-1").unread).toBe(false);
  });

  it("侧栏开着时答复到达不算未读", async () => {
    const btw = useBtwSession();
    await askAndAnswer("sid-1", "问", "答");
    expect(btw.threadFor("sid-1").unread).toBe(false);
  });

  it("出错也算未读（关着侧栏时不能把错误吞掉）", async () => {
    const btw = useBtwSession();
    await btw.ask({ ownerSid: "sid-1", question: "问" });
    btw.closePanel("sid-1");
    answer("sid-1", "问", { error: "挂了" });
    expect(btw.threadFor("sid-1").unread).toBe(true);
  });

  it("openPanel(focusInput) 递增输入框聚焦请求", () => {
    const btw = useBtwSession();
    btw.openPanel("sid-1", { focusInput: true });
    btw.openPanel("sid-1", { focusInput: true });
    expect(btw.threadFor("sid-1").focusInputTick).toBe(2);
  });

  it("批注书签 openRound：打开所在线程并请求定位；找不到返回 false", async () => {
    const btw = useBtwSession();
    await askAndAnswer("sid-1", "问", "答");
    btw.closePanel("sid-1");
    const id = btw.threadFor("sid-1").rounds[0].id;
    expect(btw.openRound(id)).toBe(true);
    expect(btw.threadFor("sid-1")).toMatchObject({ open: true, focusRoundId: id });
    btw.consumeFocusRound("sid-1");
    expect(btw.threadFor("sid-1").focusRoundId).toBeNull();
    expect(btw.openRound("不存在")).toBe(false);
    expect(btw.hasRound(id)).toBe(true);
  });

  it("读一个没问过的会话不会凭空建线程", () => {
    const btw = useBtwSession();
    expect(btw.threadFor("sid-x").rounds).toEqual([]);
    expect(btw.hasRound("anything")).toBe(false);
  });
});

describe("useBtwSession — 跨问记忆（封顶 20 轮）", () => {
  it("下一问把此前问答作为 history 参数传出去", async () => {
    await askAndAnswer("sid-1", "第一问", "第一答");
    await useBtwSession().ask({ ownerSid: "sid-1", question: "第二问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({
      sessionId: "sid-1",
      question: "第二问",
      history: [{ question: "第一问", response: "第一答" }],
    });
  });

  it("记忆按主会话隔离", async () => {
    await askAndAnswer("sid-1", "问", "答");
    await useBtwSession().ask({ ownerSid: "sid-2", question: "别处问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({ sessionId: "sid-2", question: "别处问", history: [] });
  });

  it("synthetic 兜底答复展示但不入 history", async () => {
    const btw = useBtwSession();
    await btw.ask({ ownerSid: "sid-1", question: "问" });
    answer("sid-1", "问", { response: "兜底答复", synthetic: true });
    expect(btw.threadFor("sid-1").rounds[0].answer).toBe("兜底答复");
    await btw.ask({ ownerSid: "sid-1", question: "再问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({ sessionId: "sid-1", question: "再问", history: [] });
  });

  it("失败轮不入 history", async () => {
    const btw = useBtwSession();
    await btw.ask({ ownerSid: "sid-1", question: "问" });
    answer("sid-1", "问", { error: "挂了" });
    await btw.ask({ ownerSid: "sid-1", question: "再问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({ sessionId: "sid-1", question: "再问", history: [] });
  });

  it("超 20 轮只带最近 20 轮", async () => {
    for (let i = 1; i <= 22; i++) await askAndAnswer("sid-1", `问${i}`, `答${i}`);
    await useBtwSession().ask({ ownerSid: "sid-1", question: "最后一问" });
    const history = (btwAskMock.mock.calls.at(-1)![0] as { history: { question: string }[] }).history;
    expect(history).toHaveLength(20);
    expect(history[0].question).toBe("问3");
    expect(history.at(-1)!.question).toBe("问22");
  });

  it("clearBtwHistory 清掉整条线程", async () => {
    await askAndAnswer("sid-1", "问", "答");
    useBtwSession().clearBtwHistory("sid-1");
    expect(useBtwSession().threadFor("sid-1").rounds).toEqual([]);
    await useBtwSession().ask({ ownerSid: "sid-1", question: "再问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({ sessionId: "sid-1", question: "再问", history: [] });
  });
});

describe("useBtwSession — 绑定迁移", () => {
  it("rebindOwner 跟随主会话 temp→real：线程整体迁过去", async () => {
    await askAndAnswer("temp-1", "问", "答");
    useBtwSession().rebindOwner("temp-1", "real-1");
    expect(useBtwSession().threadFor("temp-1").rounds).toEqual([]);
    expect(useBtwSession().threadFor("real-1").rounds).toHaveLength(1);

    await useBtwSession().ask({ ownerSid: "real-1", question: "再问" });
    expect(btwAskMock).toHaveBeenLastCalledWith({
      sessionId: "real-1",
      question: "再问",
      history: [{ question: "问", response: "答" }],
    });
  });

  it("迁移后在途一问的答复按新 id 落账", async () => {
    await useBtwSession().ask({ ownerSid: "temp-1", question: "问" });
    useBtwSession().rebindOwner("temp-1", "real-1");
    answer("real-1", "问", { response: "答" });
    expect(useBtwSession().threadFor("real-1").rounds[0].answer).toBe("答");
  });

  it("rebindOwner 对无关 id 是 no-op", async () => {
    await askAndAnswer("sid-1", "问", "答");
    useBtwSession().rebindOwner("别的", "另一个");
    expect(useBtwSession().threadFor("sid-1").rounds).toHaveLength(1);
  });
});
