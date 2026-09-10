import type { MentionRange } from "../types/chat";

const MAX_MENTION_CHARS = 50_000;

export type { MentionRange };

export interface ResolvedMention {
  path: string;
  content: string;
  /** 只引用一段时才有；缺省 = 整文件。 */
  range?: MentionRange;
}

export interface FileMentionResolution {
  /** 发给模型的完整 prompt——用户原文 + 附加的文件内容（模型确实需要这些信息才能回答）。*/
  sendText: string;
  /** 解析成功的引用。前端拿这个渲染成独立的、类似工具调用的折叠卡片——
   *  不要把 content 拼进用户消息本身的文本气泡里，那样会把用户自己打的字
   *  和引用内容混在一起，读起来很差。 */
  resolved: ResolvedMention[];
}

/**
 * `@path:12-48` 的行号后缀解析（贪婪 `.+` 取**最后一个**冒号）。
 *
 * Windows 盘符冒号在 index 1 且后面不是数字，天然不匹配；Unix/Windows 的正常
 * 路径也不会以 `:<数字>` 结尾（冒号在 Windows 文件名里非法），所以这个后缀不
 * 会与真实路径冲突——早先担心的 `C:\dir\12` 类歧义实测不成立，没留回退分支。
 * 非法区间（start<1 或 end<start）当普通路径处理，最终表现为"读不到就忽略"。
 */
const RANGE_SUFFIX = /^(.+):(\d+)(?:-(\d+))?$/;

export function parseMentionPath(raw: string): { path: string; range?: MentionRange } {
  const m = RANGE_SUFFIX.exec(raw);
  if (!m) return { path: raw };
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return { path: raw };
  return { path: m[1], range: { start, end } };
}

/** parseMentionPath 的逆操作：拼回 `@path` / `@path:12-48` 字面量。 */
export function formatMentionPath(path: string, range?: MentionRange): string {
  return range ? `${path}:${range.start}-${range.end}` : path;
}

/** 按 1-based 闭区间切行。起点超出文件长度 → 空串（调用方给出提示文案）。 */
function sliceLines(content: string, range: MentionRange): string {
  const lines = content.split(/\r?\n/);
  if (range.start > lines.length) return "";
  const start = Math.max(range.start, 1);
  const end = Math.min(range.end, lines.length);
  return lines.slice(start - 1, end).join("\n");
}

/** 从消息文本中提取 `@<path>` 引用（Aide 自己的文本约定，来自文件树/剪贴板粘贴/
 *  编辑器选区——见 paste.ts 与 useMentionInserter）。要求 `@` 前是行首或空白，
 *  避免误伤 "user@example.com" 这类文本。带行号后缀（`@path:12-48`）时原样保留，
 *  由 parseMentionPath 在使用点解析。 */
export function extractFileMentions(text: string): string[] {
  // 路径在非空白字符里截止于常见中文标点——中文提示词经常紧跟在路径后面
  // 不留空格（如"@C:\a.md 看看这个，顺便……"里的逗号），\S+ 会把标点也吞进路径。
  const matches = [...text.matchAll(/(?:^|\s)@([^\s，。！？；：、]+)/g)].map((m) => m[1]);
  return [...new Set(matches)];
}

/**
 * headless 的 Agent SDK query() 不会像交互式终端那样在提交时把 @path 展开成文件
 * 内容——那是 TUI 按键输入层的行为，query() 完全绕过，模型收到的只是字面量文本，
 * 读不读全凭它自己判断。所以这里要在发送前把每个 @path 真的读出来拼进发给模型的
 * 文本里，让模型确定拿到内容，而不是赌它会主动去读。
 *
 * 展开后的内容只进 `sendText`（发给模型），不进用户消息本身的显示文本——
 * 调用方应该用 `resolved` 单独渲染成折叠卡片，见 ChatPanel.vue 的用法。
 */
export async function resolveFileMentions(
  text: string,
  readFile: (path: string) => Promise<string>,
): Promise<FileMentionResolution> {
  const paths = extractFileMentions(text);
  if (paths.length === 0) return { sendText: text, resolved: [] };

  const resolved: ResolvedMention[] = [];
  const sections: string[] = [];
  for (const raw of paths) {
    const { path, range } = parseMentionPath(raw);
    let content: string;
    try {
      content = await readFile(path);
    } catch {
      // 读取失败（不存在/二进制/无权限等）——原样保留 @path 文本，不阻断发送
      continue;
    }

    if (range) {
      content = sliceLines(content, range);
      // 范围整个落在文件之外：不静默丢弃引用（用户会以为没发出去），给一句
      // 可读的提示当成内容，模型也知道该引用为什么是空的。
      if (!content) {
        content = `（指定的行范围 ${range.start}-${range.end} 超出文件长度）`;
      }
    }
    const total = content.length;
    if (total > MAX_MENTION_CHARS) {
      content = `${content.slice(0, MAX_MENTION_CHARS)}\n...(内容过长，已截断，完整内容共 ${total} 字符)`;
    }
    resolved.push(range ? { path, content, range } : { path, content });
    const label = formatMentionPath(path, range);
    sections.push(`--- 引用文件：${label} ---\n${content}\n--- 文件结束：${label} ---`);
  }
  const sendText = sections.length ? `${text}\n\n${sections.join("\n\n")}` : text;
  return { sendText, resolved };
}

export interface MentionSplit {
  /** 去掉引用展开段之后的用户原文（即当初 resolveFileMentions 收到的 text）。 */
  displayText: string;
  /** 拆出来的引用段，顺序与文中出现顺序一致。 */
  sections: ResolvedMention[];
}

/**
 * `resolveFileMentions` 的逆操作：把 `sendText` 拆回「用户原文 + 引用段」。
 *
 * 用途：SDK transcript 落盘的用户消息就是 sendText 本身，重开历史会话时只有
 * 这一份文本可用——不拆的话整个文件原文会灌进用户气泡（直发路径不受影响，
 * 它有 resolved 单独渲染附件卡片）。生成和解析放同一个文件，标记格式只有
 * 这一处真相源；改包裹格式时两个函数必须一起动。
 *
 * 头尾标记的路径必须一致才算一段（backreference 校验），既防误伤用户碰巧打出
 * 的类似文本，也让非贪婪匹配在正确的结束标记处停下。
 */
export function splitMentionSections(text: string): MentionSplit {
  const sections: ResolvedMention[] = [];
  const displayText = text
    .replace(
      /\n*--- 引用文件：(.+) ---\n([\s\S]*?)\n--- 文件结束：\1 ---/g,
      (_match, raw: string, content: string) => {
        // 标记里的路径可能带 `@path:12-48` 的行号后缀，回看时同样要还原成
        // 「路径 + 区间」，否则卡片标题丢了行号、与直发路径形状不一致。
        const { path, range } = parseMentionPath(raw);
        sections.push(range ? { path, content, range } : { path, content });
        return "";
      },
    )
    .trim();
  return sections.length ? { displayText, sections } : { displayText: text, sections: [] };
}
