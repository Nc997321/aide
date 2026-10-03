import type { MentionRange } from "../types/chat";

const MAX_MENTION_CHARS = 50_000;
/** 目录引用的**一级条目**上限（先截条目、再走 MAX_MENTION_CHARS 字符截断）。 */
const MAX_DIR_ENTRIES = 200;
/** 消息级注入的附加仓指令文件上限——比 spawn 期 systemPrompt 的 256KiB 小得多：
 *  它是"当轮可达"的一次性摘要，不是持久规则载体（见方案 D 段）。 */
const MAX_DIR_RULES_CHARS = 16_000;

export type { MentionRange };

/** 目录引用只读这两列（Rust `FileEntry` 的结构子集）——测试桩、未来多出来的字段都不受牵连。 */
export interface DirEntry {
  name: string;
  is_dir: boolean;
}

/** `resolveFileMentions` 的注入能力面。对象化是为了"可选能力在签名上看得见"：
 *  只给 readFile 的调用点维持旧行为，给了 listDir 才认得目录。 */
export interface MentionIo {
  readFile: (path: string) => Promise<string>;
  /** 缺省 = 维持旧行为（目录引用静默忽略）——老调用点/远端安全降级。 */
  listDir?: (path: string) => Promise<DirEntry[]>;
  /** 本会话已知的授权目录（`useSessionAttachedWorkspaces`）。命中 = 降档：只发一行宣告，
   *  不重发清单与指令（省 token、不重复注入）。缺省 = 全按首次处理。 */
  attachedDirs?: string[];
  /** 取某目录所属工作区的 auto memory 索引（MEMORY.md 原文，宿主侧已按 200 行/25KiB 截断）。
   *  缺省 = 不注入记忆。为什么走能力位而不是在本模块拼路径：浏览器端没有 fs，而 key 规则
   *  （`: \ / `→`-`、点归一）只有 Rust 与 sidecar 两份真相源，SDK 不抄第三份。 */
  memoryIndex?: (dir: string) => Promise<string | null>;
}

export interface ResolvedMention {
  path: string;
  content: string;
  /** 只引用一段时才有；缺省 = 整文件。 */
  range?: MentionRange;
  /** 目录引用（@一个目录 = 授权 + 一级清单）。与 range 互斥（行号对目录无意义）。 */
  isDir?: boolean;
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

/** 剥尾部分隔符：`@C:\a\` 与 `@C:\a` 是同一个目录（芯片去重、授权去重都靠它）。
 *  全被吃掉（如 `"/"`）或空串时原样返回，交给调用方判空。 */
export function normalizeMentionPath(path: string): string {
  const stripped = path.replace(/[\\/]+$/, "");
  return stripped.length ? stripped : path;
}

/** 跨平台路径拼接：按 base 的分隔符拼，剥前/后导分隔符，rel 内部统一为 base 的分隔符
 *  （Windows 全反斜杠，与文件树/后端返回的原生路径格式一致，open() 的已有窗口查找
 *  才能命中）。无 base 时原样返回 rel。
 *  与输入框的 `@path ` 解析、`@` 补全共用这一份——别再抄第二份。 */
export function joinPath(base: string, rel: string): string {
  if (!base) return rel;
  const sep = base.includes("\\") ? "\\" : "/";
  const b = base.replace(/[\\/]+$/, "");
  const r = rel.replace(/^[\\/]+/, "").replace(/[\\/]/g, sep);
  if (!r) return b;
  return `${b}${sep}${r}`;
}

/** token 形似绝对路径（Windows 盘符 / Unix 根 / UNC 反斜杠开头）。 */
export function isAbsoluteishPath(token: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(token) || /^[\\/]/.test(token);
}

/** 路径归一键：Windows 形态（盘符/UNC）不区分大小写，分隔符一律折成 `/`。
 *  只用于**比对**，原值另存（下发/显示不丢用户写法）。 */
function mentionPathKey(path: string): string {
  const p = normalizeMentionPath(path).replace(/[\\/]/g, "/");
  return /^[a-zA-Z]:\//.test(p) || p.startsWith("//") ? p.toLowerCase() : p;
}

/** child 是否就是 parent、或落在 parent 子树内。按组件比——`C:\ab` 不命中 `C:\a`。
 *  两个消费者共用这一把尺子：发送侧剔「会话主根子树」（`attachedDirsFrom`）、
 *  输入框 @ 补全剔「其它项目里的自己与祖先」。别在调用点手搓 strip_prefix。 */
export function isSameOrInside(child: string, parent: string): boolean {
  const c = mentionPathKey(child);
  const p = mentionPathKey(parent);
  if (!p) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/** 从解析结果里取「要授权的附加目录」：筛目录 → 归一 → 去重 → 剔除会话主根子树。
 *  主根自己不必授权（它本来就是会话 cwd），子树也不必。 */
export function attachedDirsFrom(
  resolution: FileMentionResolution,
  sessionRoot?: string | null,
): string[] {
  const out: string[] = [];
  for (const m of resolution.resolved) {
    if (!m.isDir) continue;
    const dir = normalizeMentionPath(m.path);
    if (!dir || (sessionRoot && isSameOrInside(dir, sessionRoot))) continue;
    if (out.some((x) => mentionPathKey(x) === mentionPathKey(dir))) continue;
    out.push(dir);
  }
  return out;
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

/** 消息级注入的单文件上限：截断并留一行说明。这是**一次性摘要**的预算，持久规则
 *  走 systemPrompt（那条按 256KiB/文件）。 */
function capRules(text: string): string {
  return text.length > MAX_DIR_RULES_CHARS
    ? `${text.slice(0, MAX_DIR_RULES_CHARS)}\n…（内容过长，已截断）`
    : text;
}

/** 附加仓的指令文件：读不到就算了（不阻断、不噪声）。固定用前向分隔符——
 *  Windows 的文件 API 同样接受 `/`，避免为一次拼接把 node:path 拖进本模块
 *  （它被浏览器端的 PWA 复用）。 */
async function readDirRules(dir: string, io: MentionIo): Promise<string> {
  try {
    return capRules(await io.readFile(`${dir}/CLAUDE.md`));
  } catch {
    return "";
  }
}

/** 附加仓的 auto memory 索引（与 CLAUDE.md 同一趟注入、同一预算）。没给能力位
 *  （老调用点/远端）或读不到 = 不注入——对方仓没有记忆是常态，不是错误。 */
async function readDirMemory(dir: string, io: MentionIo): Promise<string> {
  if (!io.memoryIndex) return "";
  try {
    return capRules(((await io.memoryIndex(dir)) ?? "").trim());
  } catch {
    return "";
  }
}

/**
 * 目录段的正文。两档（方案 A 段）：
 *  - 首次 @：宣告 + 一级清单 + 本仓 CLAUDE.md 原文 + 记忆索引——后两者的当轮可达是 F6
 *    逼出来的（query 全会话只 spawn 一次，systemPrompt 那条路当轮基本不生效）。
 *  - 已在账本内：只发一行宣告。用户把芯片留在输入框时不会每轮重注一遍清单。
 */
async function dirMentionContent(dir: string, io: MentionIo): Promise<string> {
  const known = (io.attachedDirs ?? []).some((d) => mentionPathKey(d) === mentionPathKey(dir));
  if (known) return `已授权目录：${dir}（本会话内持续有效；内容此前已注入，不重复展开）`;

  const entries = await io.listDir!(dir);
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const listing = shown.map((e) => (e.is_dir ? `${e.name}/` : e.name)).join("\n");
  const more = entries.length > shown.length ? `\n…（共 ${entries.length} 个条目，已截断）` : "";
  const [rules, memory] = await Promise.all([readDirRules(dir, io), readDirMemory(dir, io)]);
  return [
    `目录：${dir}（已授权访问，可直接 Read/Edit 其中文件）`,
    `一级条目（${entries.length} 个）：`,
    listing + more,
    ...(rules ? [`本仓指令文件 ${dir}/CLAUDE.md 原文（仅当操作该仓文件时适用）：`, rules] : []),
    ...(memory ? [`本仓记忆索引（auto memory，仅当操作该仓文件时适用；正文用 mcp__aide-memory__read_memory，root=${dir}，id=索引里的文件名）：`, memory] : []),
  ].join("\n");
}

/**
 * headless 的 Agent SDK query() 不会像交互式终端那样在提交时把 @path 展开成文件
 * 内容——那是 TUI 按键输入层的行为，query() 完全绕过，模型收到的只是字面量文本，
 * 读不读全凭它自己判断。所以这里要在发送前把每个 @path 真的读出来拼进发给模型的
 * 文本里，让模型确定拿到内容，而不是赌它会主动去读。
 *
 * `@目录` 走同一条路：readFile 对目录必然失败，再用 listDir 二次判别——成功即目录
 * （授权 + 一级清单），也失败则维持"静默忽略"的旧行为。
 *
 * 展开后的内容只进 `sendText`（发给模型），不进用户消息本身的显示文本——
 * 调用方应该用 `resolved` 单独渲染成折叠卡片，见 ChatPanel.vue 的用法。
 */
export async function resolveFileMentions(
  text: string,
  io: MentionIo,
): Promise<FileMentionResolution> {
  const paths = extractFileMentions(text);
  if (paths.length === 0) return { sendText: text, resolved: [] };

  const resolved: ResolvedMention[] = [];
  const sections: string[] = [];
  for (const raw of paths) {
    const { path: rawPath, range } = parseMentionPath(raw);
    const path = normalizeMentionPath(rawPath);
    let content: string;
    let isDir = false;
    try {
      content = await io.readFile(path);
    } catch {
      // 读失败（不存在/二进制/无权限/目录）——没有 listDir 就维持原样静默忽略；
      // 有则再判一次目录，两个都失败才算"路径不存在"。
      if (!io.listDir) continue;
      try {
        content = await dirMentionContent(path, io);
        isDir = true;
      } catch {
        continue;
      }
    }

    if (range && !isDir) {
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
    if (isDir) {
      resolved.push({ path, content, isDir: true });
      sections.push(`--- 引用目录：${path} ---\n${content}\n--- 目录结束：${path} ---`);
    } else {
      resolved.push(range ? { path, content, range } : { path, content });
      const label = formatMentionPath(path, range);
      sections.push(`--- 引用文件：${label} ---\n${content}\n--- 文件结束：${label} ---`);
    }
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
 * 的类似文本，也让非贪婪匹配在正确的结束标记处停下。种类（文件/目录）用捕获组
 * 取，路径的反向引用相应后移一位；种类不参与校验，旧转录（只有"文件"）照常拆得动。
 */
export function splitMentionSections(text: string): MentionSplit {
  const sections: ResolvedMention[] = [];
  const displayText = text
    .replace(
      /\n*--- 引用(文件|目录)：(.+) ---\n([\s\S]*?)\n--- (?:文件|目录)结束：\2 ---/g,
      (_match, kind: string, raw: string, content: string) => {
        // 标记里的路径可能带 `@path:12-48` 的行号后缀，回看时同样要还原成
        // 「路径 + 区间」，否则卡片标题丢了行号、与直发路径形状不一致。
        const { path, range } = parseMentionPath(raw);
        if (kind === "目录") sections.push({ path, content, isDir: true });
        else sections.push(range ? { path, content, range } : { path, content });
        return "";
      },
    )
    .trim();
  return sections.length ? { displayText, sections } : { displayText: text, sections: [] };
}
