import { describe, it, expect } from "vitest";
import { titleFromContent } from "./titleGenerator.js";

/**
 * titleGenerator：截取首条用户消息内容作为会话标题（不再调用模型）。
 *
 * 关键不变量：
 * - 纯本地截取：压缩空白（换行/制表/连续空格 → 单空格）、截 30 字
 * - 按 Unicode 码点截取——不会把 emoji/汉字切成半个
 * - 空白输入返回 null——调用方静默放弃，会话保留默认名
 */

describe("titleFromContent", () => {
  it("直接取用户消息内容作标题", () => {
    expect(titleFromContent("帮我修复登录页的 bug")).toBe("帮我修复登录页的 bug");
  });

  it("压缩换行和连续空白为单个空格", () => {
    expect(titleFromContent("第一行\n第二行\t 第三行")).toBe("第一行 第二行 第三行");
    expect(titleFromContent("  前后有空白  ")).toBe("前后有空白");
  });

  it("超过 30 字截断", () => {
    const long = "这是一个非常非常非常非常非常非常非常非常非常非常长的用户消息超出了标题长度限制";
    const result = titleFromContent(long);
    expect(result).not.toBeNull();
    expect([...result!].length).toBe(30);
  });

  it("按码点截取，不切坏 emoji", () => {
    const s = "🚀".repeat(40);
    const result = titleFromContent(s);
    expect([...result!].length).toBe(30);
    expect(result).toBe("🚀".repeat(30));
  });

  it("空白输入返回 null", () => {
    expect(titleFromContent("")).toBeNull();
    expect(titleFromContent("  \n\t  ")).toBeNull();
  });
});
