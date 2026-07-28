import { describe, it, expect } from "vitest";
import { generateSessionTitle, sanitizeTitle } from "./titleGenerator.js";

/**
 * titleGenerator：首轮回复开始时用独立的小模型 query 生成会话标题。
 *
 * 关键不变量：
 * - 默认 userText-only（首轮回复开始时触发，不等助手文本）；assistantText
 *   可选，传了才拼进 prompt，留空时 prompt 不含空「助手：」行
 * - persistSession:false（不落盘转录，否则 list_sessions 会扫到幽灵会话）
 *   + thinking:{type:"disabled"}（标题无需推理，避免推理模型十几秒才出标题）
 * - 只取标题模型回复的文本块，经 sanitize（去引号/换行/前缀、截 30 字）
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

  it("userText-only（不传 assistantText）也能生成标题，prompt 不含空助手行", async () => {
    let seenPrompt: unknown;
    const spy = ((args: any) => {
      seenPrompt = args.prompt;
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "登录页 Bug 修复" }] } };
        yield { type: "result", subtype: "success" };
      })();
    }) as any;
    const { userText, model, env } = BASE_OPTS;
    const title = await generateSessionTitle(spy, { userText, model, env });
    expect(title).toBe("登录页 Bug 修复");
    expect(typeof seenPrompt).toBe("string");
    // userText 进了 prompt
    expect(seenPrompt as string).toContain("帮我修复登录页的 bug");
    // 无 assistantText 时 prompt 不应出现空的「助手：」行
    expect(seenPrompt as string).not.toContain("助手：");
  });

  it("query 选项带 persistSession:false + thinking:disabled（不落盘、不推理）", async () => {
    let seenOptions: any;
    const spy = ((args: any) => {
      seenOptions = args.options;
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "标题" }] } };
        yield { type: "result", subtype: "success" };
      })();
    }) as any;
    await generateSessionTitle(spy, BASE_OPTS);
    // 不落盘转录——否则 list_sessions 会扫到这个内部 query 的幽灵会话
    expect(seenOptions.persistSession).toBe(false);
    // 不推理——标题是琐碎生成，避免推理模型十几秒才出标题
    expect(seenOptions.thinking).toEqual({ type: "disabled" });
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
