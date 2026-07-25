import { describe, it, expect } from "vitest";
import { generateSessionTitle, sanitizeTitle } from "./titleGenerator.js";

/**
 * titleGenerator：首轮对话结束后用独立的小模型 query 生成会话标题。
 *
 * 关键不变量：
 * - 只取助手回复的文本块，经 sanitize（去引号/换行/前缀、截 30 字）
 * - 任何失败（抛错/空响应/超时）都返回 null——静默回退，绝不影响主会话
 * - 调用方拿到的 prompt 是一次性 string（独立会话，不污染主对话上下文）
 */

/** 伪造一次 SDK query：按序产出给定消息。 */
function fakeQueryFn(messages: unknown[]) {
  return (() => (async function* () {
    for (const m of messages) yield m;
  })()) as any;
}

const BASE_OPTS = {
  userText: "帮我修复登录页的 bug",
  assistantText: "好的，我先看一下登录页的代码……",
  model: "haiku",
  env: {},
};

describe("sanitizeTitle", () => {
  it("strips surrounding quotes and trailing punctuation", () => {
    expect(sanitizeTitle("「修复登录 Bug」。")).toBe("修复登录 Bug");
    expect(sanitizeTitle("\"Fix login bug\"")).toBe("Fix login bug");
  });

  it("takes only the first line", () => {
    expect(sanitizeTitle("修复登录 Bug\n这是第二行解释")).toBe("修复登录 Bug");
  });

  it("strips a leading 标题：/Title: prefix", () => {
    expect(sanitizeTitle("标题：修复登录 Bug")).toBe("修复登录 Bug");
    expect(sanitizeTitle("Title: Fix login")).toBe("Fix login");
  });

  it("truncates to 30 characters", () => {
    const long = "这是一个非常非常非常非常非常非常非常非常非常非常长的会话标题超出限制";
    const result = sanitizeTitle(long);
    expect(result).not.toBeNull();
    expect([...result!].length).toBe(30);
  });

  it("returns null for empty / punctuation-only input", () => {
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle("  \n  ")).toBeNull();
    expect(sanitizeTitle("「」")).toBeNull();
  });
});

describe("generateSessionTitle", () => {
  it("collects assistant text and returns the sanitized title", async () => {
    const title = await generateSessionTitle(
      fakeQueryFn([
        { type: "assistant", message: { content: [{ type: "text", text: "修复登录 Bug" }] } },
        { type: "result", subtype: "success" },
      ]),
      BASE_OPTS,
    );
    expect(title).toBe("修复登录 Bug");
  });

  it("sends a one-shot string prompt containing the conversation excerpt", async () => {
    let seenPrompt: unknown;
    const spy = ((args: any) => {
      seenPrompt = args.prompt;
      return (async function* () {
        yield { type: "result", subtype: "success" };
      })();
    }) as any;
    await generateSessionTitle(spy, BASE_OPTS);
    expect(typeof seenPrompt).toBe("string");
    expect(seenPrompt as string).toContain("帮我修复登录页的 bug");
  });

  it("returns null when the model outputs nothing usable", async () => {
    const title = await generateSessionTitle(
      fakeQueryFn([{ type: "result", subtype: "success" }]),
      BASE_OPTS,
    );
    expect(title).toBeNull();
  });

  it("returns null when the query throws", async () => {
    const throwing = (() => {
      throw new Error("provider unavailable");
    }) as any;
    expect(await generateSessionTitle(throwing, BASE_OPTS)).toBeNull();
  });

  it("returns null on timeout (hung query never yields)", async () => {
    const hung = (() => (async function* () {
      await new Promise(() => {}); // 永远不出消息
      yield { type: "result" };
    })()) as any;
    const title = await generateSessionTitle(hung, { ...BASE_OPTS, timeoutMs: 50 });
    expect(title).toBeNull();
  });
});
