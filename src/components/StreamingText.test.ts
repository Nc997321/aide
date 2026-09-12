// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

// 只测**模式判定与分块追加**，不测 markdown 出 HTML——那是 markdown.ts 的事。
// 打桩让断言锚在"走了哪条路"上，而不是锚在 marked 的输出上。
// 标记用小写：wrapper.html() 会把标签名规范化成小写，写 <md> 会永远断言不上。
vi.mock("@/utils/markdown", () => ({
  renderMarkdown: (t: string) => `<md>${t}</md>`,
  renderStreaming: (t: string) => `<st>${t}</st>`,
}));

import { mount } from "@vue/test-utils";
import StreamingText from "./StreamingText.vue";
import { TAIL_MAX_CHARS } from "@aide/sdk/utils/streamSplit";

/** 挂载并返回 wrapper；text 默认给一段还没跨段落的流式正文。 */
function mountText(text: string, streaming = true) {
  return mount(StreamingText, { props: { text, streaming } });
}

/** 取出尾巴各块的 style（动画延迟）与文本。
 *  文本走 textContent 而不是 wrapper.text()——后者会 trim，把块首尾的空格吃掉
 *  （`**重点**` 前后本来各有一个空格，trim 后拼起来就少一个空格）。 */
function chunksOf(wrapper: ReturnType<typeof mountText>) {
  return wrapper.findAll(".aide-wave-chunk").map((s) => ({
    text: (s.element as HTMLElement).textContent ?? "",
    delay: s.attributes("style") ?? "",
  }));
}

describe("StreamingText · 模式判定", () => {
  it("非流式块 → 整块 renderMarkdown（final）", () => {
    const w = mountText("第一段\n\n第二段", false);
    expect(w.html()).toContain("<md>");
    expect(w.find(".msg-tail").exists()).toBe(false);
  });

  it("流式 + 尾巴可动画 → 前缀定格 + 波形尾巴（split）", () => {
    const w = mountText("第一段。\n\n第二段还在写");
    expect(w.find(".msg-tail").exists()).toBe(true);
    // 前缀走 renderMarkdown，且只装已定稿的那段——正在写的第二段在尾巴里
    const frozen = w.find(".msg-frozen").element as HTMLElement;
    expect(frozen.textContent).toBe("第一段。\n\n");
    expect(w.find(".msg-tail").element.textContent).toBe("第二段还在写");
    expect(w.html()).not.toContain("<st>");
  });

  it("首段还没跨段落 → 没有前缀，只有尾巴", () => {
    const w = mountText("第一段还在写");
    expect(w.find(".msg-tail").exists()).toBe(true);
    expect(w.find(".msg-frozen").exists()).toBe(false);
  });

  // 以下三种「尾巴不可动画」：尾巴整段走 markdown 保住结构，只是不出波形。
  // 关键是不能退回「整段 renderStreaming」——正文逐字流式后那就是每条 delta 全量
  // 重解析，正是历史 O(n²) 的形状。
  it.each([
    ["尾巴超长", "x".repeat(TAIL_MAX_CHARS + 1)],
    ["尾巴含代码围栏", "前言。\n\n```rust\nlet a = 1;"],
    ["尾巴含列表", "前言。\n\n- 第一点"],
  ])("%s → 尾巴整段 markdown、无波形块", (_name, text) => {
    const w = mountText(text);
    expect(w.find(".aide-wave-chunk").exists()).toBe(false);
    expect(w.find(".msg-tail").html()).toContain("<st>");
    // 前缀仍是分段渲染，没有退回全量
    if (text.includes("\n\n")) expect(w.find(".msg-frozen").exists()).toBe(true);
  });

  it("正段以空行收尾（尾巴为空）→ 不留空尾巴 div", () => {
    const w = mountText("第一段。\n\n");
    expect(w.find(".msg-tail").exists()).toBe(false);
    expect(w.find(".msg-frozen").exists()).toBe(true);
  });

  it("空文本不炸，且无尾巴", () => {
    const w = mountText("");
    expect(w.find(".msg-tail").exists()).toBe(false);
  });

  it("从流式切到定稿 → 尾巴撤掉换回整块 renderMarkdown", async () => {
    const w = mountText("第一段还在写");
    expect(w.find(".msg-tail").exists()).toBe(true);
    await w.setProps({ streaming: false });
    expect(w.find(".msg-tail").exists()).toBe(false);
    expect(w.html()).toContain("<md>");
  });
});

describe("StreamingText · 尾巴分块", () => {
  it("按 2 字切块", () => {
    const w = mountText("甲乙丙丁戊");
    expect(chunksOf(w).map((c) => c.text)).toEqual(["甲乙", "丙丁", "戊"]);
  });

  it("藏起行内标记符号", () => {
    const w = mountText("这里是 **重点** 和 `代码`");
    const joined = chunksOf(w).map((c) => c.text).join("");
    expect(joined).toBe("这里是 重点 和 代码");
  });

  it("尾巴增长 → 只追加新块，已有块的延迟不变", async () => {
    const w = mountText("甲乙");
    const before = chunksOf(w);
    await w.setProps({ text: "甲乙丙丁" });
    const after = chunksOf(w);
    expect(after.map((c) => c.text)).toEqual(["甲乙", "丙丁"]);
    expect(after[0].delay).toBe(before[0].delay);
  });

  it("一次到达很多字 → 块延迟递增错峰，总摊开不超过上限", async () => {
    const w = mountText("x".repeat(60));
    const delays = chunksOf(w).map((c) => Number(/animation-delay:\s*(\d+)ms/.exec(c.delay)?.[1] ?? -1));
    expect(delays.length).toBe(30);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(0);
    // 单调不减，且最后一块的延迟在错峰上限内
    expect(delays.at(-1)).toBeLessThanOrEqual(200);
    expect(delays.at(-1)).toBeGreaterThan(delays[0]);
  });

  it("跨过段落边界 → 尾巴重建，旧块不残留", async () => {
    const w = mountText("第一段\n\n尾巴甲");
    expect(chunksOf(w).map((c) => c.text)).toEqual(["尾巴", "甲"]);
    await w.setProps({ text: "第一段\n\n尾巴甲\n\n新尾巴乙" });
    expect(chunksOf(w).map((c) => c.text)).toEqual(["新尾", "巴乙"]);
  });

  it("正文被整体替换（历史重放/切会话）→ 整表重建", async () => {
    const w = mountText("甲乙丙");
    await w.setProps({ text: "另起一段话" });
    expect(chunksOf(w).map((c) => c.text).join("")).toBe("另起一段话");
  });
});
