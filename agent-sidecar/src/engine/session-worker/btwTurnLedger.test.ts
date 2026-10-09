import { describe, it, expect } from "vitest";
import { BtwTurnLedger, BTW_LEDGER_MAX_CHARS } from "./btwTurnLedger.js";

const assistant = (content: unknown[], parent: string | null = null) =>
  ({ type: "assistant", parent_tool_use_id: parent, message: { content } }) as any;
const toolResult = (text: string, parent: string | null = null) =>
  ({ type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }] }] } }) as any;
const result = (subtype = "success", is_error = false) => ({ type: "result", subtype, is_error }) as any;

describe("BtwTurnLedger", () => {
  it("没有补遗时问题原样返回", () => {
    expect(new BtwTurnLedger().augment("Q")).toBe("Q");
  });

  it("记下本轮用户消息、助手文字、工具调用与结果，问题放在最后", () => {
    const l = new BtwTurnLedger();
    l.recordUser("修登录页");
    l.recordSdkMessage(assistant([{ type: "text", text: "先看代码" }, { type: "tool_use", name: "Read", input: { file_path: "a.ts" } }]));
    l.recordSdkMessage(toolResult("export const x = 1"));
    const out = l.augment("它在干嘛");
    expect(out).toContain("User: 修登录页");
    expect(out).toContain("Assistant: 先看代码");
    expect(out).toContain('Assistant called tool Read({"file_path":"a.ts"})');
    expect(out).toContain("Tool result: export const x = 1");
    expect(out.endsWith("\n它在干嘛")).toBe(true);
  });

  it("子代理内部消息不记", () => {
    const l = new BtwTurnLedger();
    l.recordSdkMessage(assistant([{ type: "text", text: "inner" }], "tool-1"));
    l.recordSdkMessage(toolResult("inner result", "tool-1"));
    expect(l.size).toBe(0);
  });

  it("回合成功收尾清账（快照已刷新）；出错/打断的回合不清", () => {
    const l = new BtwTurnLedger();
    l.recordUser("甲");
    l.recordSdkMessage(result("error_during_execution", true));
    expect(l.size).toBe(1);
    l.recordSdkMessage(result());
    expect(l.size).toBe(0);
  });

  it("超长时从最早的条目丢起，保留最新进展并注明省略", () => {
    const l = new BtwTurnLedger();
    for (let i = 0; i < 40; i++) l.recordUser(`msg-${i} ` + "x".repeat(400));
    const out = l.augment("Q");
    expect(out).toContain("msg-39");
    expect(out).not.toContain("msg-0 ");
    expect(out).toMatch(/\(\d+ earlier entries omitted\)/);
    expect(out.length).toBeLessThan(BTW_LEDGER_MAX_CHARS + 1000);
  });
});
