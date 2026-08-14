// markdown → IR（marked + 扩展语法）。write 输入层。
// 扩展语法在 lexer 前预处理成 HTML 注释占位，walker 识别：
//   [TOC] → <!--toc-->；\newpage → <!--newpage-->；::: center/right/justify → <!--align:-->
//   ::: header/footer 文本 → <!--header:文本-->（文本内 {page}/{numpages} → <!--page-->/<!--numpages-->）
// 图片 {width=N} → title "w:N"；data URI 图片直接解析进 media。
// 列表段落模拟（IR 无 list 类型）：bullet/编号字符 + 缩进。

import { readFileSync, statSync } from "node:fs";
import { imageSize } from "image-size";
import { marked, type MarkedToken, type Token, type Tokens } from "marked";
import type { Align, Block, DocxDocument, HeaderFooter, Image, MediaFile, Paragraph, Run, TableCell, TableRow } from "../model.js";
import { DOCX_MAX_IMAGE_BYTES, DOCX_MAX_IMAGE_WIDTH, DOCX_MAX_INPUT_CHARS } from "../constants.js";
import { resolveDocxOutPath } from "../path.js";

export interface MarkdownToModelOptions {
  /** 工作目录：解析相对图片路径用。 */
  cwd?: string;
  /** 西文字体，默认 Calibri。 */
  font?: string;
  /** 中文（eastAsia）字体，默认 Microsoft YaHei。 */
  eastAsiaFont?: string;
  /** 代码块等宽字体，默认 Consolas。 */
  monoFont?: string;
  /** 正文字号（半磅），默认 21 = 10.5pt。 */
  fontSize?: number;
  /** 图片模式：embed 读本地文件嵌入（失败降级占位）；skip 一律占位。默认 embed。 */
  images?: "embed" | "skip";
}

export type MarkdownToModelResult =
  | { ok: true; doc: DocxDocument; paragraphs: number; images: number; skippedImages: number }
  | { ok: false; reason: "invalid_arg" | "unknown"; detail: string };

interface MdCtx {
  opts: {
    cwd?: string;
    font: string;
    eastAsiaFont: string;
    monoFont: string;
    fontSize: number;
    images: "embed" | "skip";
  };
  media: MediaFile[];
  headers: HeaderFooter[];
  footers: HeaderFooter[];
  paragraphs: number;
  images: number;
  skippedImages: number;
}

const IMAGE_TYPES: Record<string, MediaFile["type"]> = {
  jpg: "jpg",
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  bmp: "bmp",
};

/** 行内样式栈：strong/em/del/blockquote 递归时合并 */
interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  color?: string;
  link?: Run["link"];
}

/** marked 18 的 Token 判别收窄（同 gen.ts 的 std） */
function std(tokens: Token[]): MarkedToken[] {
  return tokens as MarkedToken[];
}

// ---------------------------------------------------------------------------
// 扩展语法预处理
// ---------------------------------------------------------------------------

/** 扩展语法 → HTML 注释占位（marked 的 html token 原样保留，walker 识别） */
function preprocess(md: string): string {
  let out = md;
  out = out.replace(/^\[TOC(?::(figures|tables))?\]\s*$/gm, (_m, v: string | undefined) =>
    v ? `<!--toc:${v}-->` : "<!--toc-->",
  );
  out = out.replace(/^\\newpage\s*$/gm, "<!--newpage-->");
  out = out.replace(/^::: (header|footer) (.+)$/gm, "<!--$1:$2-->");
  out = out.replace(/^::: (center|right|justify)\s*$/gm, "<!--align:$1-->");
  // 图注/表注：::: caption / ::: tablecaption → 段落 Caption/TableCaption 样式（TOC \t 收集用）
  out = out.replace(/^::: (caption|tablecaption)\s*$/gm, "<!--style:$1-->");
  // 图片 {width=N} → title "w:N"（marked 的 image 支持 title 语法）
  out = out.replace(/!\[([^\]]*)\]\(([^)]*)\)\{width=(\d+)\}/g, '![$1]($2 "w:$3")');
  return out;
}

/** 扩展注释 → 结构化指令 */
type Ext =
  | { kind: "toc"; variant?: "figures" | "tables" }
  | { kind: "newpage" }
  | { kind: "align"; align: Align }
  | { kind: "style"; style: "FigureCaption" | "TableCaption" }
  | { kind: "header"; text: string }
  | { kind: "footer"; text: string }
  | { kind: "page" }
  | { kind: "numpages" }
  | { kind: "bookmark"; name: string };

function parseExt(text: string): Ext | null {
  const toc = /^<!--toc(?::(figures|tables))?-->$/.exec(text);
  if (toc) return { kind: "toc", variant: toc[1] as "figures" | "tables" | undefined };
  if (/^<!--newpage-->$/.test(text)) return { kind: "newpage" };
  const align = /^<!--align:(center|right|justify)-->$/.exec(text);
  if (align) return { kind: "align", align: align[1] as Align };
  const style = /^<!--style:(caption|tablecaption)-->$/.exec(text);
  if (style) return { kind: "style", style: style[1] === "caption" ? "FigureCaption" : "TableCaption" };
  const hf = /^<!--(header|footer):(.+)-->$/.exec(text);
  if (hf) return { kind: hf[1] as "header" | "footer", text: hf[2] };
  if (/^<!--page-->$/.test(text)) return { kind: "page" };
  if (/^<!--numpages-->$/.test(text)) return { kind: "numpages" };
  const bm = /^<!--bookmark:(.+)-->$/.exec(text);
  if (bm) return { kind: "bookmark", name: bm[1] };
  return null;
}

// ---------------------------------------------------------------------------
// block walker
// ---------------------------------------------------------------------------

function walkBlocks(tokens: Token[], ctx: MdCtx, listLevel = 0, quote = false): Block[] {
  const out: Block[] = [];
  let pendingAlign: Align | undefined;
  let pendingStyle: "FigureCaption" | "TableCaption" | undefined;
  for (const token of std(tokens)) {
    switch (token.type) {
      case "heading":
        out.push(makeHeading(token, ctx));
        break;
      case "paragraph":
        out.push(...makeParagraph(token, ctx, quote, pendingAlign, pendingStyle));
        pendingAlign = undefined;
        pendingStyle = undefined;
        break;
      case "list":
        out.push(...walkList(token, ctx, listLevel, quote));
        break;
      case "code":
        out.push(makeCodeBlock(token, ctx, quote));
        break;
      case "blockquote":
        out.push(...walkBlocks(token.tokens, ctx, listLevel, true));
        break;
      case "table":
        out.push(makeTable(token, ctx));
        break;
      case "hr":
        out.push({ kind: "hr" });
        break;
      case "html": {
        // marked 的 html token text 可能带尾随换行（注释行后紧跟非空行时），trim 后再识别
        const ext = parseExt(token.text.trim());
        if (ext) {
          switch (ext.kind) {
            case "toc": {
              // 变体：figures/tables → TOC \t 按 FigureCaption/TableCaption 样式收集（Word 更新域自动填页码）。
              // 样式名必须与 styles.ts 的 captionFallbackStyles 一致（Word 按 styleId 匹配，实测）；
              // 不能用 "Caption"（Word 内置样式名，styleId 会被强制规范化导致匹配失败）。
              const instr =
                ext.variant === "figures"
                  ? 'TOC \\t "FigureCaption,1" \\h \\z \\u'
                  : ext.variant === "tables"
                    ? 'TOC \\t "TableCaption,1" \\h \\z \\u'
                    : 'TOC \\o "1-3" \\h \\z \\u';
              out.push({ kind: "field", type: "toc", instr });
              break;
            }
            case "newpage":
              out.push({ kind: "pagebreak" });
              break;
            case "align":
              pendingAlign = ext.align;
              break;
            case "style":
              pendingStyle = ext.style;
              break;
            case "header":
            case "footer":
              ctx[ext.kind === "header" ? "headers" : "footers"].push({
                type: "default",
                blocks: parseHeaderFooterText(ext.text, ctx),
              });
              break;
            case "page":
              out.push({ kind: "field", type: "page", instr: "PAGE" });
              break;
            case "numpages":
              out.push({ kind: "field", type: "numpages", instr: "NUMPAGES" });
              break;
            case "bookmark":
              out.push({ kind: "bookmark", name: ext.name, anchor: true });
              break;
          }
        } else {
          // 普通 HTML → 纯文本段
          out.push(
            ...makeParagraph(
              { type: "paragraph", raw: token.text, text: token.text, tokens: [{ type: "text", text: token.text, raw: token.text }] },
              ctx,
              quote,
              pendingAlign,
              pendingStyle,
            ),
          );
          pendingAlign = undefined;
          pendingStyle = undefined;
        }
        break;
      }
      case "space":
        break;
      default:
        break;
    }
  }
  return out;
}

/** 页眉页脚文本：{page}/{numpages} → 域块，其余文本走 inline 解析（支持加粗等） */
function parseHeaderFooterText(text: string, ctx: MdCtx): Block[] {
  const out: Block[] = [];
  let current: Run[] = [];
  const flush = () => {
    if (current.length > 0) {
      out.push({ kind: "paragraph", runs: current });
      current = [];
    }
  };
  for (const part of text.split(/(\{page\}|\{numpages\})/)) {
    if (part === "{page}") {
      flush();
      out.push({ kind: "field", type: "page", instr: "PAGE" });
    } else if (part === "{numpages}") {
      flush();
      out.push({ kind: "field", type: "numpages", instr: "NUMPAGES" });
    } else if (part) {
      // lexer 返回 block token，取 paragraph 的 inline tokens 再走 walkInline
      const inline = marked
        .lexer(part)
        .flatMap((t) => (t.type === "paragraph" ? (t as Tokens.Paragraph).tokens : []));
      current.push(...inlineToRuns(walkInline(inline, ctx)));
    }
  }
  flush();
  return out;
}

function makeHeading(token: Tokens.Heading, ctx: MdCtx): Paragraph {
  const level = Math.min(Math.max(token.depth, 1), 6);
  ctx.paragraphs++;
  // 标题内图片罕见 → 降级占位文本
  return { kind: "paragraph", style: `Heading${level}`, runs: inlineToRuns(walkInline(token.tokens, ctx)) };
}

/** 段落 → 块序列：run 归段落，图片拆独立块（与 parse 端语义一致） */
function makeParagraph(
  token: Tokens.Paragraph,
  ctx: MdCtx,
  quote: boolean,
  align?: Align,
  style?: "FigureCaption" | "TableCaption",
): Block[] {
  const items = walkInline(token.tokens, ctx, quote ? { color: "595959" } : {});
  const out: Block[] = [];
  let current: Run[] = [];
  const flush = () => {
    if (current.length > 0) {
      ctx.paragraphs++;
      out.push({
        kind: "paragraph",
        runs: current,
        ...(align ? { align } : {}),
        ...(style ? { style } : {}),
        ...(quote ? { indent: { left: 720 } } : {}),
        spacing: { after: 120 },
      });
      current = [];
    }
  };
  for (const item of items) {
    if (isImage(item)) {
      flush();
      out.push(item);
    } else {
      current.push(item);
    }
  }
  flush();
  return out;
}

/**
 * 列表项块级 tokens → runs（多段落/代码块合并为单个段落块，段间 break 分隔）。
 * marked v18 的 item.tokens 对单行项是 inline tokens（text），对多段落/含代码块项是
 * 块级 tokens（paragraph/code/…）——walkInline 只认 inline token，块级会走 default 被
 * 静默丢弃（实测：多段落列表项只剩编号前缀，内容全丢）。这里统一按块级处理。
 */
function listItemTokensToRuns(tokens: Token[], ctx: MdCtx, style: RunStyle): Run[] {
  const out: Run[] = [];
  let wrote = false;
  const breakBetween = () => {
    if (wrote) out.push({ text: "", break: true, ...style });
  };
  for (const t of std(tokens)) {
    switch (t.type) {
      case "text":
        out.push({ text: t.text, ...style });
        wrote = true;
        break;
      case "paragraph":
        breakBetween();
        // 段落内图片降级为占位文本（列表项拆块会破坏 bullet 结构）
        out.push(...inlineToRuns(walkInline(t.tokens, ctx, style)));
        wrote = true;
        break;
      case "code": {
        breakBetween();
        // 行间 break 与 makeCodeBlock 同模式（首行无 break，后续行前置 break）
        t.text.replace(/\n$/, "").split("\n").forEach((line, i) => {
          out.push({ text: line, font: ctx.opts.monoFont, shading: "F5F5F5", ...(i > 0 ? { break: true } : {}), ...style });
        });
        wrote = true;
        break;
      }
      case "blockquote":
        breakBetween();
        out.push(...listItemTokensToRuns(t.tokens, ctx, { ...style, color: "595959" }));
        wrote = true;
        break;
      case "space":
        break;
      default:
        // 表格/标题等无法在列表段落内表达 → 降级占位文本
        breakBetween();
        out.push({ text: `[${t.type}]`, italics: true, color: "808080", ...style });
        wrote = true;
        break;
    }
  }
  return out;
}

/** 列表段落模拟：bullet/编号字符 + 缩进（IR 无 list 类型） */
function walkList(token: Tokens.List, ctx: MdCtx, listLevel: number, quote: boolean): Block[] {
  const level = Math.min(listLevel, 2);
  const out: Block[] = [];
  let index = 1;
  for (const item of token.items) {
    const bodyTokens: Token[] = [];
    for (const t of std(item.tokens)) {
      if (t.type === "list") {
        out.push(...walkList(t, ctx, listLevel + 1, quote));
      } else {
        bodyTokens.push(t);
      }
    }
    const runs: Run[] = [{ text: token.ordered ? `${index}. ` : "• " }];
    if (token.ordered) index++;
    if (item.task) runs.push({ text: item.checked ? "☑ " : "☐ " });
    runs.push(...listItemTokensToRuns(bodyTokens, ctx, quote ? { color: "595959" } : {}));
    ctx.paragraphs++;
    out.push({
      kind: "paragraph",
      runs,
      indent: { left: 720 * (level + 1), hanging: 360 },
      ...(quote ? { indent: { left: 720 * (level + 1) + 720 } } : {}),
      spacing: { after: 60 },
    });
  }
  return out;
}

function makeCodeBlock(token: Tokens.Code, ctx: MdCtx, quote: boolean): Paragraph {
  const lines = token.text.replace(/\n$/, "").split("\n");
  ctx.paragraphs++;
  return {
    kind: "paragraph",
    runs: lines.map((line, i) => ({
      text: line,
      font: ctx.opts.monoFont,
      size: 18,
      ...(i > 0 ? { break: true } : {}),
    })),
    shading: "F5F5F5",
    spacing: { before: 120, after: 120 },
    ...(quote ? { indent: { left: 720 } } : {}),
  };
}

function makeTable(token: Tokens.Table, ctx: MdCtx): Block {
  const rows: TableRow[] = [];
  if (token.header.length > 0) {
    rows.push({ cells: token.header.map((cell) => makeTableCell(cell, true, ctx)) });
  }
  for (const row of token.rows) {
    rows.push({ cells: row.map((cell) => makeTableCell(cell, false, ctx)) });
  }
  return { kind: "table", rows };
}

function makeTableCell(cell: Tokens.TableCell, header: boolean, ctx: MdCtx): TableCell {
  ctx.paragraphs++;
  return {
    // 单元格内图片罕见 → 降级占位文本
    blocks: cell.tokens.length > 0 ? [{ kind: "paragraph", runs: inlineToRuns(walkInline(cell.tokens, ctx)) }] : [],
    ...(header ? { shading: "F2F2F2" } : {}),
  };
}

// ---------------------------------------------------------------------------
// inline walker
// ---------------------------------------------------------------------------

/** inline 结果：run 或图片（图片由调用方拆块或降级） */
type InlineItem = Run | Image;

/** Run 无 kind 字段，不能直接 in 收窄（同 parse 端 isImage） */
function isImage(item: InlineItem): item is Image {
  return (item as Image).kind === "image";
}

/** 图片 → 占位文本 run（列表项等不拆块的场景） */
function inlineToRuns(items: InlineItem[]): Run[] {
  return items.map((i) =>
    isImage(i)
      ? { text: `[image: ${i.alt ?? i.mediaId}]`, italics: true, color: "808080" }
      : i,
  );
}

function walkInline(tokens: Token[], ctx: MdCtx, style: RunStyle = {}): InlineItem[] {
  const out: InlineItem[] = [];
  for (const token of std(tokens)) {
    switch (token.type) {
      case "text":
        out.push({ text: token.text, ...style });
        break;
      case "strong":
        out.push(...walkInline(token.tokens, ctx, { ...style, bold: true }));
        break;
      case "em":
        out.push(...walkInline(token.tokens, ctx, { ...style, italics: true }));
        break;
      case "del":
        out.push(...walkInline(token.tokens, ctx, { ...style, strike: true }));
        break;
      case "codespan":
        out.push({ text: token.text, font: ctx.opts.monoFont, shading: "F5F5F5", ...style });
        break;
      case "link":
        out.push(...walkInline(token.tokens, ctx, { ...style, link: { href: token.href } }));
        break;
      case "image": {
        const img = embedImage(token, ctx);
        if (img) {
          out.push(img);
        } else {
          ctx.skippedImages++;
          out.push({ text: `[image: ${token.text || token.href}]`, italics: true, color: "808080", ...style });
        }
        break;
      }
      case "br":
        out.push({ text: "", break: true, ...style });
        break;
      case "escape":
        out.push({ text: token.text, ...style });
        break;
      case "html":
        out.push({ text: token.text, ...style });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 图片 embed
// ---------------------------------------------------------------------------

/** 读图片嵌入（本地文件 / data URI）。URL/超限/非图片/读不到 → null（调用方降级占位）。 */
function embedImage(token: Tokens.Image, ctx: MdCtx): Image | null {
  if (ctx.opts.images === "skip") return null;
  const href = token.href;
  if (!href) return null;

  let buf: Buffer;
  let typeHint: string | undefined;
  if (href.startsWith("data:")) {
    const m = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(href);
    if (!m) return null;
    buf = Buffer.from(m[2], "base64");
    typeHint = m[1].toLowerCase();
  } else {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) return null;
    const cwd = ctx.opts.cwd;
    if (!cwd) return null;
    const resolved = resolveDocxOutPath(cwd, href);
    if (!resolved.ok) return null;
    try {
      const st = statSync(resolved.path);
      if (st.size > DOCX_MAX_IMAGE_BYTES) return null;
      buf = readFileSync(resolved.path);
    } catch {
      return null;
    }
  }
  if (buf.length > DOCX_MAX_IMAGE_BYTES) return null;

  let size: { width?: number; height?: number; type?: string };
  try {
    size = imageSize(buf);
  } catch {
    return null;
  }
  const type = typeHint ? IMAGE_TYPES[typeHint] : size.type ? IMAGE_TYPES[size.type.toLowerCase()] : undefined;
  if (!type || !size.width || !size.height) return null;

  // {width=N}（title "w:N"）→ 指定渲染宽（等比缩放高）；否则默认 480 上限
  const widthAttr = /^w:(\d+)$/.exec(token.title ?? "");
  const scale = widthAttr
    ? Number(widthAttr[1]) / size.width
    : size.width > DOCX_MAX_IMAGE_WIDTH ? DOCX_MAX_IMAGE_WIDTH / size.width : 1;

  const mediaId = ctx.media.length;
  ctx.media.push({ data: buf, type, width: size.width, height: size.height });
  ctx.images++;
  return {
    kind: "image",
    mediaId,
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    alt: token.text || undefined,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * markdown → IR 文档。成功返回 doc + 计数，失败返 {ok:false} 不抛。
 * 图片失败不算错：降级占位段 + skippedImages 计数。
 */
export function markdownToModel(
  markdown: string,
  opts: MarkdownToModelOptions = {},
): MarkdownToModelResult {
  if (typeof markdown !== "string" || markdown.trim() === "") {
    return { ok: false, reason: "invalid_arg", detail: "markdown must be a non-empty string" };
  }
  if (markdown.length > DOCX_MAX_INPUT_CHARS) {
    return {
      ok: false,
      reason: "invalid_arg",
      detail: `markdown exceeds the ${DOCX_MAX_INPUT_CHARS} character limit`,
    };
  }

  const ctx: MdCtx = {
    opts: {
      cwd: opts.cwd,
      font: opts.font ?? "Calibri",
      eastAsiaFont: opts.eastAsiaFont ?? "Microsoft YaHei",
      monoFont: opts.monoFont ?? "Consolas",
      fontSize: opts.fontSize ?? 21,
      images: opts.images ?? "embed",
    },
    media: [],
    headers: [],
    footers: [],
    paragraphs: 0,
    images: 0,
    skippedImages: 0,
  };

  let tokens: Token[];
  try {
    tokens = marked.lexer(preprocess(markdown));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unknown", detail: `markdown parse failed: ${msg}` };
  }

  const blocks = walkBlocks(tokens, ctx);
  const doc: DocxDocument = {
    sections: [{ headers: ctx.headers, footers: ctx.footers, blocks }],
    styles: new Map(),
    media: ctx.media,
  };
  return {
    ok: true,
    doc,
    paragraphs: ctx.paragraphs,
    images: ctx.images,
    skippedImages: ctx.skippedImages,
  };
}
