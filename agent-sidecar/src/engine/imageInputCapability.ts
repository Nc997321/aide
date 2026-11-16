// 图片输入判定：识别接口因模型能力或图片数据拒绝图片的 400。
// 发送前探测（probeImageInput / ImageInputCapabilityCache / Read 图片守卫）已整体
// 移除——400 由 imageRollback.ts 兜底（去图重写历史，会话不报废）。

const IMAGE_REJECTION = /\b(?:this model does not support image input|the image data you provided does not represent a valid image)\b/i;
// SDKResultError 没有 api_error_status；真实 HTTP 状态只保留在 errors[] 的文本里。
export function isImageRejection400(text: string, status: unknown): boolean {
  if (status !== undefined && status !== null && status !== 400) return false;
  if (status === 400) return IMAGE_REJECTION.test(text);
  const prefix = /\b(?:API\s+Error:\s*|HTTP\s*)400\b/i.exec(text);
  return prefix !== null && IMAGE_REJECTION.test(text.slice(prefix.index + prefix[0].length));
}

export function classifyImageInputResult(message: unknown): true | false | null {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "result") return null;
  const result = message as {
    subtype?: unknown;
    is_error?: unknown;
    api_error_status?: unknown;
  };

  if (result.subtype === "success" && result.is_error === false) return true;

  return isImageRejection400(extractMessageText(message), result.api_error_status) ? false : null;
}

/** 从 SDK 消息里抽出可用于判定图片拒绝原因的文本。
 *  - result 消息：errors[] + result 字符串
 *  - 合成 assistant 错误消息（model="<synthetic>"）：content[] 的 text 块
 *    真实 SDK 行为：CLI 把 400「this model does not support image input」包成一条
 *    model="<synthetic>" 的 assistant 文本消息，而非 result(is_error)，所以必须
 *    额外识别这条合成消息，否则 400 会冒到用户。 */
export function extractMessageText(msg: unknown): string {
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
