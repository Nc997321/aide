import { createHash } from "node:crypto";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_UNSUPPORTED = /\bthis model does not support image input\b/i;
// SDKResultError 没有 api_error_status；真实 HTTP 状态只保留在 errors[] 的文本里。
const IMAGE_UNSUPPORTED_400 = /\b(?:API\s+Error:\s*|HTTP\s*)400\b[\s\S]*\bthis model does not support image input\b/i;
const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+G0g6VwAAAABJRU5ErkJggg==";

export function isImagePath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const ext = path.trim().split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase();
  return !!ext && IMAGE_EXTENSIONS.has(ext);
}

export function imageCapabilityKey(env: Record<string, string>, model: string): string {
  const endpoint = env.ANTHROPIC_BASE_URL ?? "";
  const credential = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "";
  const identity = createHash("sha256").update(JSON.stringify([endpoint, credential])).digest("hex");
  return `${identity}\0${model}`;
}

export function classifyImageInputResult(message: unknown): true | false | null {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "result") return null;
  const result = message as {
    subtype?: unknown;
    is_error?: unknown;
    api_error_status?: unknown;
    errors?: unknown;
    result?: unknown;
  };

  if (result.subtype === "success" && result.is_error === false) return true;

  const errors = [
    ...(Array.isArray(result.errors) ? result.errors : []),
    typeof result.result === "string" ? result.result : "",
  ].join("\n");

  return (
    (result.api_error_status === 400 && IMAGE_UNSUPPORTED.test(errors))
    || IMAGE_UNSUPPORTED_400.test(errors)
  ) ? false : null;
}

export class ImageInputCapabilityCache {
  private readonly final = new Map<string, true | false>();
  private readonly inflight = new Map<string, Promise<true | false | null>>();

  async ensure(key: string, probe: () => Promise<true | false | null>): Promise<true | false | null> {
    if (this.final.has(key)) return this.final.get(key) ?? null;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const pending = (async () => {
      try {
        const result = await probe();
        if (result !== null) this.final.set(key, result);
        return result;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, pending);
    return pending;
  }
}

/** 从任意 SDK 消息里抽出可用于「不支持图片」判定的文本。
 *  - result 消息：errors[] + result 字符串
 *  - 合成 assistant 错误消息（model="<synthetic>"）：content[] 的 text 块
 *    真实 SDK 行为：CLI 把 400「this model does not support image input」包成一条
 *    model="<synthetic>" 的 assistant 文本消息，而非 result(is_error)，所以必须
 *    额外识别这条合成消息，否则 probe 会判 unknown → 守卫放行 → 400 冒到用户。 */
function extractMessageText(msg: unknown): string {
  const m = msg as {
    type?: unknown;
    errors?: unknown;
    result?: unknown;
    message?: { content?: unknown };
  };
  if (m?.type === "result") {
    return [
      ...(Array.isArray(m.errors) ? m.errors : []),
      typeof m.result === "string" ? m.result : "",
    ].join("\n");
  }
  if (m?.type === "assistant" && Array.isArray(m.message?.content)) {
    return (m.message!.content as { type?: string; text?: unknown }[])
      .filter((b) => b?.type === "text")
      .map((b) => String(b?.text ?? ""))
      .join("\n");
  }
  return "";
}

export async function probeImageInput(
  // queryFn 签名刻意用 any：调用方传的是 SDK 的 query（prompt: string |
  // AsyncIterable<SDKUserMessage>、options?: Options），strictFunctionTypes 下
  // 与这里的最小签名（unknown 元素 / Record<string, unknown>）逆变不兼容。
  // 探针实际只 yield SDKUserMessage 形状的消息、只把返回值当异步迭代器消费，
  // any 是诚实的（运行时本就跨泛型边界），比在调用点打两次未知转换干净。
  queryFn: (request: {
    prompt: AsyncIterable<any>;
    options: any;
  }) => AsyncIterable<unknown>,
  { env, model }: { env: Record<string, string | undefined>; model: string },
): Promise<true | false | null> {
  try {
    const probe = queryFn({
      prompt: (async function* () {
        yield {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: PROBE_PNG_BASE64,
                },
              },
              { type: "text", text: "Reply with OK." },
            ],
          },
          parent_tool_use_id: null,
        };
      })(),
      options: {
        persistSession: false,
        tools: [],
        allowedTools: [],
        model,
        env,
        // 用与主 query 同一个 claude.exe（Rust 通过 AIDE_CLAUDE_EXE 指定），避免 probe
        // 回退到系统 PATH 里的 CLI 或找不到可执行文件导致探测失败恒返回 unknown。
        ...(process.env.AIDE_CLAUDE_EXE
          ? { pathToClaudeCodeExecutable: process.env.AIDE_CLAUDE_EXE }
          : {}),
      },
    });

    for await (const msg of probe) {
      const m = msg as { type?: unknown };
      if (m?.type === "result") {
        const classified = classifyImageInputResult(msg);
        if (classified !== null) return classified;
      }
      // 合成 assistant 错误消息：CLI 把 400 包成文本，SDK 透传 yield（不是 result）。
      if (m?.type === "assistant" && IMAGE_UNSUPPORTED_400.test(extractMessageText(msg))) {
        return false;
      }
    }
  } catch (e: unknown) {
    const text = String((e as { message?: unknown })?.message ?? e);
    // 部分网关让 CLI 非零退出，SDK 抛异常；异常文本同样含 400 + 不支持图片 → 判不支持。
    // 其它异常保持 unknown，不影响聊天会话。
    if (IMAGE_UNSUPPORTED_400.test(text)) {
      return false;
    }
    return null;
  }

  return null;
}
