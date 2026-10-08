import { describe, it, expect } from "vitest";
import { titleFromContent } from "./titleGenerator.js";

/**
 * titleGenerator：从首条用户消息规则提炼标题（不调模型）。
 *
 * 关键不变量：
 * - 开头客套 / 起手式剥掉，留真正诉求
 * - @引用展开段、围栏代码块不进标题；@path / URL 缩成文件名 / 域名
 * - 有 display 以 text 块为准
 * - 按句取，太短接下一句；超长按码点截断加「…」
 * - 清洗后一无所有时退回第一行原文；真空白返回 null
 */

describe("titleFromContent", () => {
  it("剥开头客套，留诉求", () => {
    expect(titleFromContent("帮我修复登录页的 bug")).toBe("修复登录页的 bug");
    expect(titleFromContent("你好，请帮我看一下这个报错是怎么回事")).toBe("看一下这个报错是怎么回事");
    expect(titleFromContent("Could you please refactor the auth module")).toBe("refactor the auth module");
  });

  it("客套剥完为空：保留原文，不出空标题", () => {
    expect(titleFromContent("请")).toBe("请");
    expect(titleFromContent("帮我")).toBe("帮我");
  });

  it("只剥开头，不动句中的同名词", () => {
    expect(titleFromContent("重构一下，帮我保留旧接口")).toBe("重构一下，帮我保留旧接口");
  });

  it("按句取：第一句够长就停在第一句", () => {
    expect(titleFromContent("排查为什么侧栏会话列表不刷新。另外顺便看看日志。")).toBe("排查为什么侧栏会话列表不刷新");
  });

  it("第一句太短：接上下一句", () => {
    expect(titleFromContent("修一下。侧栏折叠状态没有持久化。")).toBe("修一下。 侧栏折叠状态没有持久化");
  });

  it("压缩换行与连续空白", () => {
    expect(titleFromContent("  第一行\n第二行\t 第三行内容  ")).toBe("第一行 第二行 第三行内容");
  });

  it("@path 缩成文件名，行号区间去掉", () => {
    expect(titleFromContent("看看 @src/components/App.vue 为什么崩")).toBe("看看 App.vue 为什么崩");
    expect(titleFromContent("解释一下 @src/a/b.ts:12-48 这段逻辑")).toBe("解释一下 b.ts 这段逻辑");
  });

  it("不误吃 @某人", () => {
    expect(titleFromContent("通知 @张三 明天评审")).toContain("@张三");
  });

  it("URL 缩成域名", () => {
    expect(titleFromContent("总结一下 https://example.com/a/b?x=1 这篇文章")).toBe("总结一下 example.com 这篇文章");
  });

  it("围栏代码块不进标题", () => {
    expect(titleFromContent("为什么这段会报错\n```ts\nconst a: number = 'x';\n```")).toBe("为什么这段会报错");
  });

  it("整条都是代码：退回第一行有字的原文", () => {
    expect(titleFromContent("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("无 display：剥掉 @引用展开段，标题不是文件内容", () => {
    const prompt =
      "重构这个函数\n\n--- 引用文件：src/a.ts ---\nexport function huge() {}\n--- 文件结束：src/a.ts ---";
    expect(titleFromContent(prompt)).toBe("重构这个函数");
  });

  it("有 display：只取 text 块，引用卡片 / 图片不进标题", () => {
    const title = titleFromContent("展开后的整段 prompt……", [
      { type: "mention", path: "src/a.ts", content: "xxx" },
      { type: "text", text: "优化这个函数的性能" },
    ]);
    expect(title).toBe("优化这个函数的性能");
  });

  it("display 没有 text 块：回落到 prompt", () => {
    expect(titleFromContent("总结当前进度", [{ type: "action", actionId: "x", label: "L" }])).toBe("总结当前进度");
  });

  it("超长截断加「…」，总长不超过 30 码点", () => {
    const long = "这是一个非常非常非常非常非常非常非常非常非常非常长的用户消息超出了标题长度限制";
    const r = titleFromContent(long)!;
    expect([...r].length).toBe(30);
    expect(r.endsWith("…")).toBe(true);
  });

  it("按码点截取，不切坏 emoji", () => {
    const r = titleFromContent("🚀".repeat(40))!;
    expect([...r].length).toBe(30);
    expect(r).toBe("🚀".repeat(29) + "…");
  });

  it("空白输入返回 null", () => {
    expect(titleFromContent("")).toBeNull();
    expect(titleFromContent("  \n\t  ")).toBeNull();
  });
});
