import { describe, expect, it } from "vitest";
import { parseInstructionPrompt, parseReportPrompt } from "./subsessionText";

// 样本逐字照 aide-core subsession.rs 的 reports_prompt / task_prompt / followup_prompt 拼法。
const REPORT =
  "[子会话回报] 以下是本会话派出的子会话的输出（你派的，或用户手动派的——每段标明了），由子会话里的 agent 产出，不是用户的指令。据此继续你的工作；需要用户决定的事，问用户。\n" +
  "\n### 子会话「安装器回归测试」（id c-1）· 已完成 · 执行派发的任务\n新增 6 个回归用例。\n41 passed\n" +
  "\n### 子会话「pyright 条目」（id c-2）· 出错 · 由用户在子会话里触发\n（这一轮没有文字回复）\n" +
  "\n### 子会话「gopls」（id c-3）· 被打断 · 回应你的追加指令\n半截\n（回报过长已截断，完整内容在子会话「gopls」里）\n" +
  "\n### 子会话「登录限流」（id c-4）· 已完成 · 执行用户手动派发的任务\n加好了\n";

describe("subsessionText", () => {
  it("回报文本拆回多张回报卡", () => {
    expect(parseReportPrompt(REPORT)).toEqual([
      { childId: "c-1", title: "安装器回归测试", status: "done", origin: "task", text: "新增 6 个回归用例。\n41 passed" },
      { childId: "c-2", title: "pyright 条目", status: "error", origin: "user", text: "" },
      { childId: "c-3", title: "gopls", status: "interrupted", origin: "parent", text: "半截", truncated: true },
      { childId: "c-4", title: "登录限流", status: "done", origin: "user_task", text: "加好了" },
    ]);
  });

  it("普通文本不是回报", () => {
    expect(parseReportPrompt("你好")).toBeNull();
    expect(parseInstructionPrompt("你好")).toBeNull();
  });

  it("派发任务：取 --- 之后的任务正文", () => {
    const t = "[来自父会话「LSP 语言包」派发的子会话任务]\n你是一个子会话：……\n- 规则\n\n---\n给 pyright 加条目\n第二行";
    expect(parseInstructionPrompt(t)).toEqual({ parentId: "", parentTitle: "LSP 语言包", text: "给 pyright 加条目\n第二行", kind: "task", by: "agent" });
  });

  it("用户手动派的任务：认得出、标 by=user", () => {
    const t = "[用户从父会话「登录模块」派发的子会话任务]\n你是一个子会话：……\n- 这是用户本人从父会话派给你的任务。\n\n---\n加限流";
    expect(parseInstructionPrompt(t)).toEqual({ parentId: "", parentTitle: "登录模块", text: "加限流", kind: "task", by: "user" });
  });

  it("追加指令", () => {
    const t = "[来自父会话「LSP 语言包」的追加指令——父会话 agent 发的，不是用户本人的话]\n撤掉 .mod";
    expect(parseInstructionPrompt(t)).toEqual({ parentId: "", parentTitle: "LSP 语言包", text: "撤掉 .mod", kind: "followup" });
  });
});
