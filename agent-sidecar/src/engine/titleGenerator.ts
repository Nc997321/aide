/**
 * 会话自动命名：从首条用户消息里提炼会话标题。
 *
 * 不调用模型（2026-09-03 起）：旧实现是首轮回复开始时起一次独立的小模型 query 生成标题——
 * 多一次 provider 调用、多一笔花费，且第三方 provider 把 haiku 映射到推理模型时标题要十几秒才到。
 * 现在纯本地规则，发消息即出标题，零成本、零延迟、零失败面。
 *
 * 光「截前 30 字」的标题很差：开头常是客套话（"帮我…"）、@引用展开的整段文件、代码块、
 * 一大串路径或 URL，侧栏里一排会话都长得一个样。所以截取前先做规则清洗：
 *
 * 1. 取「用户亲手写的字」：有 display 就只拿 text 块（引用卡片/图片/页面选区都不是标题素材）；
 *    没有 display（手机 v1 等纯文本端）就剥掉 prompt 里 @引用展开的整段。
 * 2. 去掉围栏代码块；@path 与 URL 缩成文件名/域名（"看看 @src/App.vue 为什么崩" → "看看 App.vue 为什么崩"）。
 * 3. 去掉开头的客套/起手式（请 / 帮我 / 麻烦 / 你好 / please / can you…），剩下的是真正的诉求。
 * 4. 按句取：第一句；太短（< 8 字）就接上下一句，直到够用。
 * 5. 超长截断并加「…」，按 Unicode 码点计数，不切坏 emoji/汉字。
 *
 * 清洗后什么都不剩（整条都是代码/引用）时退回「第一行有字的原文」，仍为空才返回 null——
 * 调用方静默放弃，会话保留默认名。
 */
import type { UserMessageBlock } from "./types.js";

const TITLE_MAX_CHARS = 30;
/** 第一句短于这个字数就接着取下一句（"好的。" / "修一下。" 当不了标题）。 */
const MIN_SENTENCE_CHARS = 8;

/** 开头的客套 / 起手式。逐轮剥（可叠加："你好，请帮我…"），只在开头生效。 */
const LEADING_FILLER = new RegExp(
  "^(?:" +
    [
      "你好[呀啊吗]?",
      "您好",
      "嗨",
      "哈喽",
      "在吗",
      "请问",
      "请你?",
      "麻烦(?:你|您)?",
      "劳驾",
      "帮我",
      "帮忙",
      "给我",
      "替我",
      "能不能",
      "能否",
      "可以(?:帮我)?",
      "可不可以",
      "我(?:想要?|需要|要)",
      "想让你",
      "(?:hi|hello|hey)\\b",
      "(?:please|pls)\\b",
      "(?:can|could|would) you(?: please)?\\b",
      "i (?:want|need) you to\\b",
      "i(?:'d| would) like (?:you )?to\\b",
    ].join("|") +
    ")[\\s,，。.!！:：、~～]*",
  "i",
);

/** @引用展开段：`--- 引用文件：<path> ---` … `--- 文件结束：<path> ---`（格式产地：
 *  packages/aide-sdk/src/utils/fileMentions.ts 的 resolveFileMentions / splitMentionSections）。 */
const MENTION_SECTION =
  /\n*--- 引用(?:文件|目录)：(.+) ---\n[\s\S]*?\n--- (?:文件|目录)结束：\1 ---/g;

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const URL_RE = /https?:\/\/([^\s/?#，。）)]+)[^\s，。）)]*/gi;
/** `@path` / `@path:12-48` 候选；是不是引用由 {@link looksLikePath} 判（含分隔符或扩展名才算，不吃 "@某人"）。 */
const AT_TOKEN = /@([^\s@，。,;；]+)/g;
const looksLikePath = (tok: string) => /[\\/]/.test(tok) || /\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?$/.test(tok);

function baseName(p: string): string {
  const noRange = p.replace(/:\d+(?:-\d+)?$/, "");
  const parts = noRange.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? noRange;
}

/** 用户亲手写的字：有 display 取 text 块，否则剥掉 prompt 里的引用展开段。 */
function authoredText(userText: string, display?: UserMessageBlock[]): string {
  if (display?.length) {
    const texts = display.flatMap((b) => (b.type === "text" ? [b.text] : []));
    if (texts.length) return texts.join("\n");
  }
  return userText.replace(MENTION_SECTION, "");
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function truncate(s: string): string {
  const chars = [...s];
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS - 1).join("")}…` : s;
}

/** 剥开头客套；剥完为空则保留原样（"请" 单字消息不能变成空标题）。 */
function stripFiller(s: string): string {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const next = cur.replace(LEADING_FILLER, "");
    if (next === cur) break;
    cur = next;
  }
  return cur.trim() ? cur : s;
}

/** 按句取：第一句；不够 MIN_SENTENCE_CHARS 就接下一句，直到够或到上限。 */
function pickSentences(s: string): string {
  const parts = s.split(/(?<=[。！？!?；;\n])|(?<=[.])\s+/).map((p) => p.trim()).filter(Boolean);
  let out = "";
  for (const p of parts) {
    out = out ? `${out} ${p}` : p;
    if ([...out.replace(/[。！？!?；;.\s]+$/, "")].length >= MIN_SENTENCE_CHARS) break;
    if ([...out].length >= TITLE_MAX_CHARS) break;
  }
  return out.replace(/[。！？!?；;,，、.\s]+$/, "");
}

/** 从用户消息提炼会话标题。空白输入 / 无可用文字返回 null。 */
export function titleFromContent(userText: string, display?: UserMessageBlock[]): string | null {
  const authored = authoredText(userText, display);

  const cleaned = collapse(
    authored
      .replace(FENCED_CODE, " ")
      .replace(URL_RE, (_m, host: string) => host)
      .replace(AT_TOKEN, (m, p: string) => (looksLikePath(p) ? baseName(p) : m))
      .replace(/`/g, ""),
  );
  const picked = pickSentences(stripFiller(cleaned));
  if (picked) return truncate(picked);

  // 整条都是代码 / 引用：退回第一行有字的原文（去掉围栏标记），好过没有标题
  const firstLine = authored
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*```\w*\s*/, "").trim())
    .find(Boolean);
  return firstLine ? truncate(collapse(firstLine)) : null;
}
