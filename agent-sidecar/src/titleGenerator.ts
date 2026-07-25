import type { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * 会话自动命名：首轮对话结束后，用一次**独立的**小模型 query 生成会话标题。
 *
 * 设计要点：
 * - prompt 是一次性 string（不是 async iterable）——SDK 起的是全新会话，
 *   不污染主对话上下文、不占主会话轮次。
 * - 任何失败（抛错 / 空响应 / 超时）都返回 null——调用方静默放弃，
 *   会话保留默认名，绝不影响主对话。
 * - settingSources: [] + allowedTools: []：不加载 CLAUDE.md/skills/工具，
 *   输入最小化，省钱省时间。
 */

export interface TitleGenOptions {
  userText: string;
  assistantText: string;
  /** 标题模型（默认由调用方传 "haiku" 或 AIDE_TITLE_MODEL 覆盖值）。 */
  model: string;
  /** CLI 子进程环境（provider 连接参数），以 process.env 为底叠加 per-session 覆盖。 */
  env: Record<string, string | undefined>;
  cwd?: string;
  executablePath?: string;
  /** 超时毫秒，默认 15000。测试用小值。 */
  timeoutMs?: number;
}

const TITLE_MAX_CHARS = 30;
const EXCERPT_MAX_CHARS = 500;
const DEFAULT_TIMEOUT_MS = 15_000;

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
  const prompt =
    "请为以下对话起一个简短的会话标题（15 字以内，用户用什么语言就用什么语言）。" +
    "只输出标题本身：不要引号、不要解释、不要结尾标点。\n\n" +
    `用户：${clip(opts.userText, EXCERPT_MAX_CHARS)}\n\n` +
    `助手：${clip(opts.assistantText, EXCERPT_MAX_CHARS)}`;

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
      try { (q as any).close?.(); } catch { /* 忽略 */ }
      resolve(null);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
  });

  // catch 放这里而不是外层 try：超时赢了 race 后迭代仍可能 reject，
  // 没有它会是 unhandled rejection。
  const collect = (async (): Promise<string | null> => {
    let text = "";
    for await (const msg of q as AsyncIterable<any>) {
      if (msg?.type === "assistant") {
        const blocks = msg.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === "text" && typeof b.text === "string") text += b.text;
          }
        }
      } else if (msg?.type === "result") {
        break;
      }
    }
    return sanitizeTitle(text);
  })().catch(() => null);

  const result = await Promise.race([collect, timeout]);
  if (timer) clearTimeout(timer);
  try { (q as any).close?.(); } catch { /* 忽略 */ }
  return result;
}
