import { describe, expect, it } from "vitest";
import { applyEvent, historyToMessages, newSessionId } from "./session";

describe("applyEvent 流式增量", () => {
  it("text_delta 追加到末条 assistant 文本块（无则新建）", () => {
    let msgs = applyEvent([], { type: "text_delta", session_id: "s1", delta: "你" });
    msgs = applyEvent(msgs, { type: "text_delta", session_id: "s1", delta: "好" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks).toEqual([{ type: "text", text: "你好" }]);
  });

  it("thinking_delta 追加到 thinking 块", () => {
    let msgs = applyEvent([], { type: "thinking_delta", session_id: "s1", delta: "想" });
    msgs = applyEvent(msgs, { type: "thinking_delta", session_id: "s1", delta: "法" });
    expect(msgs[0].blocks).toEqual([{ type: "thinking", text: "想法" }]);
  });

  it("thinking 整块事件（历史回放）也追加", () => {
    const msgs = applyEvent([], { type: "thinking", session_id: "s1", text: "整块" });
    expect(msgs[0].blocks).toEqual([{ type: "thinking", text: "整块" }]);
  });

  it("tool_use_start 推 tool_call 块，tool_result 按 id 填结果", () => {
    let msgs = applyEvent([], {
      type: "tool_use_start",
      session_id: "s1",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(msgs[0].blocks).toEqual([
      { type: "tool_call", id: "t1", name: "Bash", input: { command: "ls" }, isPending: true },
    ]);
    msgs = applyEvent(msgs, {
      type: "tool_result",
      session_id: "s1",
      id: "t1",
      content: "file.txt",
      is_error: false,
    });
    expect(msgs[0].blocks[0]).toMatchObject({
      result: "file.txt",
      isError: false,
      isPending: false,
    });
  });

  it("message_stop 标记 done 并挂 usage/effort", () => {
    let msgs = applyEvent([], { type: "text_delta", session_id: "s1", delta: "答" });
    msgs = applyEvent(msgs, {
      type: "message_stop",
      session_id: "s1",
      usage: { input_tokens: 10 },
      effort: "medium",
    });
    expect(msgs[0].done).toBe(true);
    expect(msgs[0].usage).toEqual({ input_tokens: 10 });
    expect(msgs[0].effort).toBe("medium");
  });

  it("subagent 事件创建子代理块，delta 追加文本", () => {
    let msgs = applyEvent([], {
      type: "subagent",
      session_id: "s1",
      id: "a1",
      agentName: "explorer",
      description: "搜索代码",
    });
    expect(msgs[0].blocks[0]).toMatchObject({
      type: "subagent",
      id: "a1",
      agentName: "explorer",
      description: "搜索代码",
    });
    msgs = applyEvent(msgs, {
      type: "subagent_text_delta",
      session_id: "s1",
      id: "a1",
      delta: "找到",
    });
    expect(msgs[0].blocks[0]).toMatchObject({ text: "找到" });
  });

  it("error 事件推错误块", () => {
    const msgs = applyEvent([], { type: "error", session_id: "s1", message: "崩了" });
    expect(msgs[0].blocks).toEqual([{ type: "error", text: "Error: 崩了" }]);
  });

  it("未知事件忽略", () => {
    const msgs = applyEvent([], {
      type: "usage",
      session_id: "s1",
      total_tokens: 1,
    } as unknown as Parameters<typeof applyEvent>[1]);
    expect(msgs).toEqual([]);
  });

  it("用户消息后 text_delta 新建 assistant 消息", () => {
    const user: Parameters<typeof applyEvent>[0] = [
      { id: "u1", role: "user", blocks: [{ type: "text", text: "hi" }], timestamp: 1, done: true },
    ];
    const msgs = applyEvent(user, { type: "text_delta", session_id: "s1", delta: "答" });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe("assistant");
  });
});

describe("historyToMessages 历史转换", () => {
  it("HistoryBlock 转 Block，tool_call 带 result/isError", () => {
    const msgs = historyToMessages([
      {
        role: "user",
        timestamp: 1,
        blocks: [{ type: "text", text: "hi" }],
      },
      {
        role: "assistant",
        timestamp: 2,
        blocks: [
          { type: "thinking", text: "想" },
          { type: "text", text: "答" },
          {
            type: "tool_call",
            id: "t1",
            name: "Bash",
            input: { command: "ls" },
            result: "out",
            isError: false,
          },
        ],
      },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "user", done: true });
    expect(msgs[1].blocks).toEqual([
      { type: "thinking", text: "想" },
      { type: "text", text: "答" },
      {
        type: "tool_call",
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
        result: "out",
        isError: false,
        isPending: false,
      },
    ]);
  });

  it("非 user/assistant 角色归为 assistant", () => {
    const msgs = historyToMessages([
      { role: "system", timestamp: 1, blocks: [{ type: "text", text: "x" }] },
    ]);
    expect(msgs[0].role).toBe("assistant");
  });
});

describe("newSessionId", () => {
  it("remote- 前缀", () => {
    expect(newSessionId()).toMatch(/^remote-/);
  });
});
