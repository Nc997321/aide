/**
 * Markdown 轻量解析（V1 渲染管线，纯函数层）。
 *
 * 块级：标题/段落/围栏代码/列表(含任务列表)/引用/分隔线/表格(降级等宽块)；
 * 行内：加粗(** __ ***)/斜体(*)/行内码(`)/删除线(~~)/链接(仅样式)/反斜杠转义。
 * 图片：`![说明](本地路径)` 拆成独立的 Image 块（LocalImage 经 Host 读图）；网络图等只留说明文字。
 * 不追求 CommonMark 全覆盖——只做助手回复的常用子集，表格降级为等宽块。
 *
 * 性能约束（用户明确要求，勿回退）：
 *  - 本模块纯函数无状态，只在 MarkdownText 挂载/流式节流点/收尾时调用，
 *    绝不随流式逐字符触发
 *  - 线性扫描 + 单遍；解析结果对流式追加前缀稳定（长度可作 ForEach key）
 *  - 未闭合标记（流式中途）按字面渲染，容忍半成品输入
 */
export enum MdBlockKind {
  Paragraph = 0,
  Heading = 1,
  Code = 2,
  ListItem = 3,
  Quote = 4,
  Rule = 5,
  /** 回复里的本地图片（`![说明](Host 上的路径)`）：text = 说明，src = 路径。 */
  Image = 6
}

export enum MdSpanKind {
  Text = 0,
  Bold = 1,
  Italic = 2,
  Code = 3,
  Strike = 4,
  Link = 5,
  /** 本地图片（只在解析中间态出现：段落里的图片会被拆成独立的 Image 块）。 */
  Image = 6
}

/** 行内样式段：一段同风格文本（Link 带原始 href，V1 仅样式不响应点击）。 */
export class MdSpan {
  text: string = '';
  kind: MdSpanKind = MdSpanKind.Text;
  href: string = '';
}

/** 块级元素：kind 判别 + 渲染字段（Code 用 text 存逐行 \n join）。 */
export class MdBlock {
  kind: MdBlockKind = MdBlockKind.Paragraph;
  /** Heading 级别 1-6。 */
  level: number = 0;
  /** 围栏代码语言标签（空串隐藏标签）。 */
  lang: string = '';
  text: string = '';
  /** ListItem 序号（-1 = 无序）。 */
  order: number = -1;
  /** 列表缩进层级（0 起，按 2 空格折算，上限 3）。 */
  indent: number = 0;
  spans: MdSpan[] = [];
  /** Image 块：Host 上的图片路径（未按工作区解析）。 */
  src: string = '';
}

const INLINE_SPECIALS: string = '*_~`[\\';
const RE_HEADING: RegExp = /^(#{1,6})\s+(.*)$/;
const RE_ULIST: RegExp = /^(\s*)([-*+])\s+(.*)$/;
const RE_OLIST: RegExp = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const RE_QUOTE: RegExp = /^ {0,3}>\s?(.*)$/;
const RE_RULE: RegExp = /^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/;
const RE_TABLE_SEP: RegExp = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const RE_WORD_CHAR: RegExp = /[A-Za-z0-9]/;

function pushSpanText(out: MdSpan[], t: string): void {
  if (t !== '') {
    const s: MdSpan = new MdSpan();
    s.text = t;
    out.push(s);
  }
}

function pushStyledSpan(out: MdSpan[], kind: MdSpanKind, text: string, href: string): void {
  const s: MdSpan = new MdSpan();
  s.kind = kind;
  s.text = text;
  s.href = href;
  out.push(s);
}

function pushParagraph(blocks: MdBlock[], para: string[]): void {
  if (para.length === 0) {
    return;
  }
  const text: string = para.join('\n');
  const spans: MdSpan[] = parseInline(text);
  // 段落里的本地图片拆成独立的图片块（前后的文字各成一段）
  let cur: MdSpan[] = [];
  const flush = (): void => {
    if (cur.length === 0 || cur.every((s: MdSpan) => s.kind === MdSpanKind.Text && s.text.trim() === '')) {
      cur = [];
      return;
    }
    // 图片拆出后，前后文字段首尾的换行去掉（否则多出一行空白）
    if (cur[0].kind === MdSpanKind.Text) {
      cur[0].text = cur[0].text.replace(/^\n+/, '');
    }
    const lastSpan: MdSpan = cur[cur.length - 1];
    if (lastSpan.kind === MdSpanKind.Text) {
      lastSpan.text = lastSpan.text.replace(/\n+$/, '');
    }
    const b: MdBlock = new MdBlock();
    b.kind = MdBlockKind.Paragraph;
    b.text = cur.map((s: MdSpan) => s.text).join('');
    b.spans = cur;
    blocks.push(b);
    cur = [];
  };
  for (let i = 0; i < spans.length; i++) {
    const s: MdSpan = spans[i];
    if (s.kind !== MdSpanKind.Image) {
      cur.push(s);
      continue;
    }
    flush();
    const img: MdBlock = new MdBlock();
    img.kind = MdBlockKind.Image;
    img.text = s.text;
    img.src = s.href;
    blocks.push(img);
  }
  flush();
}

/** 可点开的文件扩展名白名单（同 SDK fileLink.ts 的 FILE_EXTENSIONS）。 */
const FILE_EXTENSIONS: string =
  'png|jpe?g|gif|webp|bmp|svg|ts|tsx|vue|rs|js|jsx|mjs|cjs|css|scss|less|html|json|jsonc|md|toml|yaml|yml|sh|ps1|py|java|kt|xml|gradle|go|c|cpp|h|hpp|rb|php|swift|cs|proto|sql|env|lock|txt|ini|cfg|conf|ets|json5|log|csv';

/** [可选盘符或开头 /][目录段/]文件名.扩展名[:行号]——不含空白，排除整句代码与 `foo(bar).ts` 之类表达式。 */
const RE_FILE_PATH: RegExp = new RegExp(
  `^((?:[A-Za-z]:[/\\\\]|/)?(?:[\\w.@-]+[/\\\\])*[\\w.@-]+\\.(?:${FILE_EXTENSIONS}))(?::(\\d+))?$`, 'i');

/** 行内码是文件路径引用 → 返回路径（去掉 :行号）；否则空串（同 SDK parseFileLink）。 */
export function fileLinkPath(text: string): string {
  if (text === '' || text.length > 260) {
    return '';
  }
  const m: RegExpMatchArray | null = text.match(RE_FILE_PATH);
  return m !== null ? m[1] : '';
}

/** markdown 链接指向 Host 上的文件（不带 URL 协议、不是锚点）→ 返回路径（去掉 #L12 / :12）；否则空串。 */
export function localLinkPath(href: string): string {
  const v: string = href.trim();
  if (v === '' || v.startsWith('#') || v.startsWith('//')) {
    return '';
  }
  let p: string = v;
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\/(?:localhost)?/i, '');
    if (/^\/[A-Za-z]:[\\/]/.test(p)) {
      p = p.substring(1);
    }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) && !/^[A-Za-z]:[\\/]/.test(p)) {
    return '';
  }
  p = p.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '');
  if (p.indexOf('%') >= 0) {
    try {
      p = decodeURI(p);
    } catch (e) {
      // 非法转义按原文
    }
  }
  return p;
}

const RE_LOCAL_IMAGE_EXT: RegExp = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i;

/**
 * `![说明](路径)` 的路径是不是 Host 上的一张本地图片（同 SDK markdown.ts 的 localImagePath）：
 * 不是任何 URL 协议（盘符不算；`file://` 剥成路径），且扩展名是图片——只读图片，
 * 不会让任意文件被读进界面。是 → 返回路径（未按工作区解析）；否 → 空串。
 */
export function localImagePath(raw: string): string {
  let v: string = raw.trim();
  if (v === '' || v.startsWith('//')) {
    return '';
  }
  if (/^file:\/\//i.test(v)) {
    v = v.replace(/^file:\/\/(?:localhost)?/i, '');
    if (/^\/[A-Za-z]:[\\/]/.test(v)) {
      v = v.substring(1); // file:///C:/x.png
    }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v) && !/^[A-Za-z]:[\\/]/.test(v)) {
    return ''; // http / data / javascript … 一切带协议的
  }
  if (v.indexOf('%') >= 0) {
    try {
      v = decodeURI(v);
    } catch (e) {
      // 非法转义按原文
    }
  }
  return RE_LOCAL_IMAGE_EXT.test(v) ? v : '';
}

/** 任务列表前缀归一：`[ ]`→□、`[x]`→✓（其余原样）。 */
function normalizeTaskItem(text: string): string {
  if (text.startsWith('[ ] ')) {
    return `□ ${text.substring(4)}`;
  }
  if (text.startsWith('[x] ') || text.startsWith('[X] ')) {
    return `✓ ${text.substring(4)}`;
  }
  return text;
}

/** 行内解析：单遍字符扫描，标记未闭合按字面回退。 */
export function parseInline(src: string): MdSpan[] {
  const out: MdSpan[] = [];
  let buf: string = '';
  let i: number = 0;
  const n: number = src.length;
  while (i < n) {
    const c: string = src.charAt(i);
    if (c === '\\' && i + 1 < n && INLINE_SPECIALS.indexOf(src.charAt(i + 1)) >= 0) {
      buf += src.charAt(i + 1);
      i += 2;
      continue;
    }
    if (c === '`') {
      const close: number = src.indexOf('`', i + 1);
      if (close > i) {
        pushSpanText(out, buf);
        buf = '';
        // 看起来是文件路径的行内码（`src/a.ts:12`）带上路径，渲染成可点开
        const code: string = src.substring(i + 1, close);
        pushStyledSpan(out, MdSpanKind.Code, code, fileLinkPath(code));
        i = close + 1;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '*') {
      if (src.substring(i, i + 3) === '***') {
        const close: number = src.indexOf('***', i + 3);
        if (close > i + 2) {
          pushSpanText(out, buf);
          buf = '';
          pushStyledSpan(out, MdSpanKind.Bold, src.substring(i + 3, close), '');
          i = close + 3;
          continue;
        }
      }
      if (src.substring(i, i + 2) === '**') {
        const close: number = src.indexOf('**', i + 2);
        if (close > i + 1 && src.substring(i + 2, close).trim() !== '') {
          pushSpanText(out, buf);
          buf = '';
          pushStyledSpan(out, MdSpanKind.Bold, src.substring(i + 2, close), '');
          i = close + 2;
          continue;
        }
      } else if (src.charAt(i + 1) !== ' ' && src.charAt(i + 1) !== '') {
        const close: number = src.indexOf('*', i + 1);
        if (close > i + 1 && src.charAt(close - 1) !== ' ' && src.charAt(close + 1) !== '*') {
          pushSpanText(out, buf);
          buf = '';
          pushStyledSpan(out, MdSpanKind.Italic, src.substring(i + 1, close), '');
          i = close + 1;
          continue;
        }
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '_' && src.substring(i, i + 2) === '__'
      && (i === 0 || !RE_WORD_CHAR.test(src.charAt(i - 1)))) {
      const close: number = src.indexOf('__', i + 2);
      if (close > i + 1 && !RE_WORD_CHAR.test(src.charAt(close + 2))) {
        pushSpanText(out, buf);
        buf = '';
        pushStyledSpan(out, MdSpanKind.Bold, src.substring(i + 2, close), '');
        i = close + 2;
        continue;
      }
    }
    if (c === '~' && src.substring(i, i + 2) === '~~') {
      const close: number = src.indexOf('~~', i + 2);
      if (close > i + 1) {
        pushSpanText(out, buf);
        buf = '';
        pushStyledSpan(out, MdSpanKind.Strike, src.substring(i + 2, close), '');
        i = close + 2;
        continue;
      }
    }
    if (c === '[') {
      const closeB: number = src.indexOf(']', i + 1);
      if (closeB > i && src.charAt(closeB + 1) === '(') {
        const closeP: number = src.indexOf(')', closeB + 2);
        if (closeP > closeB + 1 && buf.endsWith('!')) {
          // 图片：本地图片出 Image 段（由段落拆成图片块），其余（网络图等）只留说明文字
          pushSpanText(out, buf.substring(0, buf.length - 1));
          buf = '';
          const alt: string = src.substring(i + 1, closeB);
          const path: string = localImagePath(src.substring(closeB + 2, closeP));
          if (path !== '') {
            pushStyledSpan(out, MdSpanKind.Image, alt, path);
          } else {
            pushSpanText(out, alt);
          }
          i = closeP + 1;
          continue;
        }
        if (closeP > closeB + 1 && closeB > i + 1) {
          pushSpanText(out, buf);
          buf = '';
          pushStyledSpan(out, MdSpanKind.Link, src.substring(i + 1, closeB), src.substring(closeB + 2, closeP));
          i = closeP + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  pushSpanText(out, buf);
  return out;
}

/**
 * 块级解析：逐行扫描。空行分段；围栏/引用/表格做跨行收集；
 * 段内连续行 join('\n') 视为软换行。
 */
export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  if (src === '') {
    return blocks;
  }
  const lines: string[] = src.split('\n');
  let para: string[] = [];
  let i: number = 0;
  while (i < lines.length) {
    const raw: string = lines[i];
    const t: string = raw.trim();
    if (t === '') {
      pushParagraph(blocks, para);
      para = [];
      i++;
      continue;
    }
    if (t.startsWith('```')) {
      pushParagraph(blocks, para);
      para = [];
      const lang: string = t.substring(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        i++;
      }
      const b: MdBlock = new MdBlock();
      b.kind = MdBlockKind.Code;
      b.lang = lang;
      b.text = codeLines.join('\n');
      blocks.push(b);
      continue;
    }
    const h: RegExpMatchArray | null = raw.match(RE_HEADING);
    if (h !== null) {
      pushParagraph(blocks, para);
      para = [];
      const b: MdBlock = new MdBlock();
      b.kind = MdBlockKind.Heading;
      b.level = h[1].length;
      b.text = h[2];
      b.spans = parseInline(h[2]);
      blocks.push(b);
      i++;
      continue;
    }
    if (RE_RULE.test(t)) {
      pushParagraph(blocks, para);
      para = [];
      const b: MdBlock = new MdBlock();
      b.kind = MdBlockKind.Rule;
      blocks.push(b);
      i++;
      continue;
    }
    const ul: RegExpMatchArray | null = raw.match(RE_ULIST);
    const ol: RegExpMatchArray | null = raw.match(RE_OLIST);
    if (ul !== null || ol !== null) {
      pushParagraph(blocks, para);
      para = [];
      const b: MdBlock = new MdBlock();
      b.kind = MdBlockKind.ListItem;
      if (ol !== null) {
        b.indent = Math.min(Math.floor(ol[1].length / 2), 3);
        b.order = parseInt(ol[2]);
        b.text = normalizeTaskItem(ol[3]);
      } else if (ul !== null) {
        b.indent = Math.min(Math.floor(ul[1].length / 2), 3);
        b.order = -1;
        b.text = normalizeTaskItem(ul[3]);
      }
      b.spans = parseInline(b.text);
      blocks.push(b);
      i++;
      continue;
    }
    const q: RegExpMatchArray | null = raw.match(RE_QUOTE);
    if (q !== null) {
      pushParagraph(blocks, para);
      para = [];
      const qLines: string[] = [q[1]];
      i++;
      while (i < lines.length) {
        const qm: RegExpMatchArray | null = lines[i].match(RE_QUOTE);
        if (qm === null) {
          break;
        }
        qLines.push(qm[1]);
        i++;
      }
      const b: MdBlock = new MdBlock();
      b.kind = MdBlockKind.Quote;
      b.text = qLines.join('\n');
      b.spans = parseInline(b.text);
      blocks.push(b);
      continue;
    }
    if (t.indexOf('|') >= 0 && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      pushParagraph(blocks, para);
      para = [];
      const tbLines: string[] = [raw];
      i++;
      while (i < lines.length && lines[i].indexOf('|') >= 0) {
        tbLines.push(lines[i]);
        i++;
      }
      const b: MdBlock = new MdBlock();
      b.kind = MdBlockKind.Code;
      b.lang = '';
      b.text = tbLines.join('\n');
      blocks.push(b);
      continue;
    }
    para.push(t);
    i++;
  }
  pushParagraph(blocks, para);
  return blocks;
}
