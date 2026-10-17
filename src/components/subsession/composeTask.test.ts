import { describe, expect, it } from "vitest";
import { composeSubsessionTask, quoteMarkdown } from "./composeTask";

describe("composeSubsessionTask", () => {
  it("只有原文：原文就是任务", () => {
    expect(composeSubsessionTask("  ", "登录失败没有限流。")).toBe("登录失败没有限流。");
  });

  it("一句话 + 原文：话在前（标题取它），原文作为引用跟在后面", () => {
    expect(composeSubsessionTask("按这个实现", "第一行\n\n第二行")).toBe("按这个实现\n\n> 第一行\n>\n> 第二行");
  });

  it("只有一句话 / 什么都没有", () => {
    expect(composeSubsessionTask(" 加限流 ")).toBe("加限流");
    expect(composeSubsessionTask("", "")).toBe("");
  });

  it("quoteMarkdown 每行加前缀、空行留 >", () => {
    expect(quoteMarkdown("\na\n\nb\n")).toBe("> a\n>\n> b");
  });
});
