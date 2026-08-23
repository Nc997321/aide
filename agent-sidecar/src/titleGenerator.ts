import type { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * 会话自动命名：首轮回复开始时，用一次**独立的**小模型 query 生成会话标题。
 *
 * 设计要点：
 * - 标题默认仅基于用户输入（userText），不等助手回复——触发时机提前到"回复时"，
 *   标题几乎与回复同时出现。assistantText 为可选扩展位，留空即 userText-only。
 * - prompt 是一次性 string（不是 async iterable）——SDK 起的是全新会话，
 *   不污染主对话上下文、不占主会话轮次。
 * - persistSession: false——标题 query 是阅后即弃的内部调用，**不落盘转录**，
 *   否则它的 .jsonl 会被 list_sessions 扫到，在会话列表里冒出一个"重命名 prompt"
 *   的幽灵会话（图片 probe / btw 也都设了 false，这里对齐）。
 * - thinking: { type: "disabled" }——标题是 15 字的琐碎生成，无需推理。若不关，
 *   第三方 provider 把 haiku 映射到推理模型 + 继承 effortLevel=MAX 时，标题 query
 *   会先 thinking 十几秒才吐标题（实测 11.5s），改名晚到用户以为没生效、且逼近超时。
 * - 任何失败（抛错 / 空响应 / 超时）都返回 null——调用方静默放弃，
 *   会话保留默认名，绝不影响主对话。
 * - settingSources: [] + allowedTools: []：不加载 CLAUDE.md/skills/工具，
 *   输入最小化，省钱省时间。
 */

export interface TitleGenOptions {
  userText: string;
  /** 可选：助手回复摘要。留空时标题仅基于 userText（首轮回复开始时触发的默认形态）。 */
  assistantText?: string;
  /** 标题模型（默认由调用方传 "haiku" 或 AIDE_TITLE_MODEL 覆盖值）。 */
  model: string;
  /** CLI 子进程环境（provider 连接参数），以 process.env 为底叠加 per-session 覆盖。 */
  env: Record<string, string | undefined>;
  cwd?: string;
  executablePath?: string;
  /** 超时毫秒，默认 30000。测试用小值。 */
  timeoutMs?: number;
}

const TITLE_MAX_CHARS = 30;
const EXCERPT_MAX_CHARS = 500;
// 30s 兜底：关掉 thinking 后标题通常 ~1s 出，但若 provider 不认 thinking:disabled
// 仍走推理（十几秒），留足余量宁可晚改名也别超时丢标题。
const DEFAULT_TIMEOUT_MS = 30_000;

/** 清洗模型输出：取第一行、去引号/首尾标点、去「标题：」前缀、截 30 字。空则 null。 */
export function sanitizeTitle(raw: string): string | null {
  let t = (raw.split("\n")[0] ?? "").trim();
  t = t.replace(/^(标题|title)\s*[:：]\s*/i, "");
  // 去首尾成对/不成对的引号、书名号、星号、末尾句号
  t = t.replace(/^[「『"'"'*#_\s]+/, "").replace(/[」』"'"'*。.\s]+$/, "");
  t = t.trim();
  if (!t) return null;
  return [...t].slice(0, TITLE_MAX_CHARS).join("");
}

function clip(s: string, max: number): string {
  return [...s].slice(0, max).join("");
}

export async function generateSessionTitle(
  queryFn: typeof query,
  opts: TitleGenOptions,
): Promise<string | null> {
  // prompt 按是否提供 assistantText 分两套：有则"用户+助手"对话式（兼容旧
  // 形态），无则"用户提问"单条式——避免出现空的「助手：」行，且指令措辞与
  // 输入一致。首轮回复开始时触发走的是后者（仅 userText）。
  const userLine = `用户：${clip(opts.userText, EXCERPT_MAX_CHARS)}`;
  const prompt = opts.assistantText
    ? "请为以下对话起一个简短的会话标题（15 字以内，用户用什么语言就用什么语言）。" +
      "只输出标题本身：不要引号、不要解释、不要结尾标点。\n\n" +
      userLine + "\n\n" +
      `助手：${clip(opts.assistantText, EXCERPT_MAX_CHARS)}`
    : "请为以下用户提问起一个简短的会话标题（15 字以内，用户用什么语言就用什么语言）。" +
      "只输出标题本身：不要引号、不要解释、不要结尾标点。\n\n" +
      userLine;

  let q: ReturnType<typeof query>;
  try {
    q = queryFn({
      prompt,
      options: {
        model: opts.model,
        maxTurns: 1,
        allowedTools: [],
        settingSources: [],
        includePartialMessages: false,
        // 阅后即弃：不落盘转录，否则 list_sessions 会扫到这个内部 query 的
        // .jsonl，在会话列表里冒出"重命名 prompt"幽灵会话（与图片 probe / btw 对齐）。
        persistSession: false,
        // 标题是琐碎生成，不需要推理：关掉 thinking 避免第三方 provider 把 haiku
        // 映射到推理模型 + 继承 effortLevel=MAX 时先 thinking 十几秒才出标题。
        thinking: { type: "disabled" },
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.executablePath
          ? { pathToClaudeCodeExecutable: opts.executablePath }
          : {}),
        env: opts.env,
      },
    } as Parameters<typeof query>[0]);
  } catch {
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try { q.close(); } catch { /* 忽略 */ }
      resolve(null);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref(); // 不挡进程退出
  });

  // catch 放这里而不是外层 try：超时赢了 race 后迭代仍可能 reject，
  // 没有它会是 unhandled rejection。
  const collect = (async (): Promise<string | null> => {
    let text = "";
    for await (const msg of q) {
      if (msg.type === "assistant") {
        const blocks = msg.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === "text" && typeof b.text === "string") text += b.text;
          }
        }
      } else if (msg.type === "result") {
        break;
      }
    }
    return sanitizeTitle(text);
  })().catch(() => null);

  const result = await Promise.race([collect, timeout]);
  if (timer) clearTimeout(timer);
  try { q.close(); } catch { /* 忽略 */ }
  return result;
}
