/**
 * Markdown 轻量解析（V1 渲染管线，纯函数层）。
 *
 * 块级：标题/段落/围栏代码/列表(含任务列表)/引用/分隔线/表格(降级等宽块)；
 * 行内：加粗(** __ ***)/斜体(*)/行内码(`)/删除线(~~)/链接(仅样式)/反斜杠转义。
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
  Rule = 5
}

export enum MdSpanKind {
  Text = 0,
  Bold = 1,
  Italic = 2,
  Code = 3,
  Strike = 4,
  Link = 5
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
  const b: MdBlock = new MdBlock();
  b.kind = MdBlockKind.Paragraph;
  b.text = para.join('\n');
  b.spans = parseInline(b.text);
  blocks.push(b);
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
        pushStyledSpan(out, MdSpanKind.Code, src.substring(i + 1, close), '');
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
      if (closeB > i + 1 && src.charAt(closeB + 1) === '(') {
        const closeP: number = src.indexOf(')', closeB + 2);
        if (closeP > closeB + 1) {
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
