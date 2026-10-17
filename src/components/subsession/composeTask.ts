/**
 * 手动派子会话时拼任务正文：
 * - 只有选中的原文 → 原文就是任务（「就按这段话去做」）；
 * - 有一句话 + 原文 → 话在前（子会话标题取它的第一句），原文作为 markdown 引用跟在后面；
 * - 只有一句话 → 就是它。
 */
export function composeSubsessionTask(note: string, quote?: string): string {
  const n = note.trim();
  const q = (quote ?? "").trim();
  if (!q) return n;
  if (!n) return q;
  return `${n}\n\n${quoteMarkdown(q)}`;
}

/** 文本 → markdown 引用块（每行加 `> `，空行保留成 `>`）。 */
export function quoteMarkdown(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
}
