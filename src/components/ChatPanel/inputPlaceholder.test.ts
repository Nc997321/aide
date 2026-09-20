import { describe, it, expect } from "vitest";
import { inputPlaceholder } from "./inputPlaceholder";

const base = { btw: false, busy: false, hero: false, daily: false };

describe("inputPlaceholder", () => {
  it("优先级 btw > busy > hero > 普通（先把话说清楚的排前面）", () => {
    expect(inputPlaceholder({ ...base, btw: true, busy: true, hero: true, daily: true })).toBe(
      "顺便问一下,不进入主对话…",
    );
    expect(inputPlaceholder({ ...base, busy: true, hero: true, daily: true })).toBe(
      "生成中，发送的消息将排队…",
    );
  });

  it("hero 分模式：日常与工程文案不同", () => {
    expect(inputPlaceholder({ ...base, hero: true, daily: true })).toBe("今天想聊点什么？");
    expect(inputPlaceholder({ ...base, hero: true, daily: false })).toBe("你正在解决什么问题？");
  });

  it("非 hero 时模式不泄漏（对话进行中不按模式改文案）", () => {
    expect(inputPlaceholder({ ...base, daily: true })).toBe("输入消息…");
    expect(inputPlaceholder({ ...base, daily: false })).toBe("输入消息…");
  });
});
