/**
 * 会话自动命名：截取首条用户消息内容作为会话标题。
 *
 * 不再调用模型（2026-09-03 起）：旧实现是首轮回复开始时起一次独立的小模型
 * query 生成标题——多一次 provider 调用、多一笔花费，且第三方 provider 把
 * haiku 映射到推理模型时标题要十几秒才到。现在纯本地截取，发消息即出标题，
 * 零成本、零延迟、零失败面。
 *
 * 截取规则：
 * - 压缩所有空白（换行/制表/连续空格 → 单个空格），去首尾空白；
 * - 截到 30 字（按 Unicode 码点计数，不会切坏 emoji/汉字）；
 * - 内容为空白时返回 null——调用方静默放弃，会话保留默认名。
 */

const TITLE_MAX_CHARS = 30;

/** 从用户消息内容截取会话标题。空白输入返回 null。 */
export function titleFromContent(userText: string): string | null {
  const t = userText.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return [...t].slice(0, TITLE_MAX_CHARS).join("");
}
