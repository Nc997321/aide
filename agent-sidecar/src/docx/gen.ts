// markdown → .docx 生成层（与 parse.ts 对称：纯转换，不碰写盘，写盘归 docxTools.ts handler）。
// 链路：marked.lexer() 拿 tokens → block/inline walker 映射成 docx 节点 → Document → Packer.toBuffer。
// 唯一 IO 是 embed 模式的本地图片读取，失败一律降级占位不抛错。

import { isAbsolute, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { marked, type MarkedToken, type Token, type Tokens } from "marked";
import { imageSize } from "image-size";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  ExternalHyperlink,
  ImageRun,
  BorderStyle,
  WidthType,
  TableLayoutType,
  ShadingType,
  LevelFormat,
  LevelSuffix,
  LineRuleType,
} from "docx";

/** 单次生成的 markdown 输入上限（字符）。超出报 invalid_arg，防爆内存/context。 */
export const DOCX_MAX_INPUT_CHARS = 200_000;

/** embed 图片字节上限：超过不读进内存，降级占位。 */
export const DOCX_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** embed 图片最大宽度（px），超出等比缩放。 */
export const DOCX_MAX_IMAGE_WIDTH = 480;

export type DocxGenReason = "invalid_arg" | "unknown";

export type DocxGenResult =
  | { ok: true; buffer: Buffer; paragraphs: number; images: number; skippedImages: number }
  | { ok: false; reason: DocxGenReason; detail: string };

export interface DocxGenOptions {
  /** 工作目录：解析相对图片路径用。 */
  cwd?: string;
  /** 西文字体（ascii/hAnsi/cs），默认 Calibri。 */
  font?: string;
  /** 中文（eastAsia）字体，默认 Microsoft YaHei（Windows 必有；macOS 无则 Word 自动替换）。 */
  eastAsiaFont?: string;
  /** 代码块等宽字体，默认 Consolas。 */
  monoFont?: string;
  /** 正文字号（半磅），默认 21 = 10.5pt。 */
  fontSize?: number;
  /** 图片模式：embed 读本地文件嵌入（失败降级占位）；skip 一律占位。默认 embed。 */
  images?: "embed" | "skip";
}

/**
 * 把模型给的输出路径解析成可写路径。与 parse.ts resolveDocxPath 同语义（verbatim `\\?\`
 * 透传 / 绝对直用 / 相对 join cwd），但不查盘——exists/not_a_directory 是 handler 层职责。
 */
export function resolveDocxOutPath(
  cwd: string,
  raw: unknown,
): { ok: true; path: string } | { ok: false; reason: "invalid_arg"; detail: string } {
  if (typeof raw !== "string") {
    return { ok: false, reason: "invalid_arg", detail: "file_path must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "invalid_arg", detail: "file_path is empty" };
  }
  if (trimmed.startsWith("\\\\?\\")) {
    return { ok: true, path: trimmed };
  }
  if (isAbsolute(trimmed)) {
    return { ok: true, path: trimmed };
  }
  return { ok: true, path: join(cwd, trimmed) };
}

// ---------------------------------------------------------------------------
// 内部：样式与上下文
// ---------------------------------------------------------------------------

/** 行内样式栈：strong/em/del/blockquote 递归时合并，构造 TextRun 时直接带上。 */
interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  color?: string;
}

interface GenCtx {
  opts: {
    cwd?: string;
    font: string;
    eastAsiaFont: string;
    monoFont: string;
    fontSize: number;
    images: "embed" | "skip";
  };
  paragraphs: number;
  images: number;
  skippedImages: number;
}

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

/** 有序列表 numbering 配置（Document 级，仅当 markdown 含有序列表时挂载）。 */
const OL_NUMBERING = {
  reference: "ol",
  levels: [0, 1, 2].map((level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    start: 1,
    suffix: LevelSuffix.SPACE,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  })),
};

const TABLE_BORDER = {
  style: BorderStyle.SINGLE,
  size: 4,
  color: "999999",
};

// ---------------------------------------------------------------------------
// 内部：block walker
// ---------------------------------------------------------------------------

type DocxBlock = Paragraph | Table;

/**
 * marked 18 的 Token = MarkedToken | Generic，Generic.type 是 string 导致 switch 判别
 * 不彻底（每个 case 都收窄成 `X | Generic`）。lexer 无扩展时只产标准 token，这里统一
 * 断言收窄，walker 内部即可正常判别。
 */
function std(tokens: Token[]): MarkedToken[] {
  return tokens as MarkedToken[];
}

function walkBlocks(tokens: Token[], ctx: GenCtx, listLevel = 0, quote = false): DocxBlock[] {
  const out: DocxBlock[] = [];
  for (const token of std(tokens)) {
    switch (token.type) {
      case "heading":
        out.push(makeHeading(token, ctx));
        break;
      case "paragraph":
        out.push(makeParagraph(token, ctx, quote));
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
        out.push(makeHr(ctx));
        break;
      case "html":
        // <pre> 块按代码块处理；其余 HTML 降级为纯文本段（Tag 无 pre 属性，用 in 判断）
        if ("pre" in token && token.pre) {
          out.push(makeCodeBlock({ type: "code", text: token.text, raw: token.text, lang: undefined, codeBlockStyle: undefined }, ctx, quote));
        } else {
          out.push(makeParagraph({ type: "paragraph", raw: token.text, text: token.text, tokens: [{ type: "text", text: token.text, raw: token.text }] }, ctx, quote));
        }
        break;
      case "space":
        break;
      default:
        break;
    }
  }
  return out;
}

function makeHeading(token: Tokens.Heading, ctx: GenCtx): Paragraph {
  const level = Math.min(Math.max(token.depth, 1), 6);
  ctx.paragraphs++;
  return new Paragraph({
    heading: HEADING_LEVELS[level - 1],
    children: walkInline(token.tokens, ctx),
  });
}

function makeParagraph(token: Tokens.Paragraph, ctx: GenCtx, quote: boolean): Paragraph {
  ctx.paragraphs++;
  return new Paragraph({
    children: walkInline(token.tokens, ctx, quote ? { color: "595959" } : {}),
    ...(quote ? { indent: { left: 720 } } : {}),
    spacing: { after: 120 },
  });
}

function walkList(token: Tokens.List, ctx: GenCtx, listLevel: number, quote: boolean): Paragraph[] {
  const level = Math.min(listLevel, 2);
  const out: Paragraph[] = [];
  for (const item of token.items) {
    // item.tokens 是块级 tokens：主体段落 + 可能的嵌套 list
    const bodyTokens: Token[] = [];
    for (const t of std(item.tokens)) {
      if (t.type === "list") {
        out.push(...walkList(t, ctx, listLevel + 1, quote));
      } else {
        bodyTokens.push(t);
      }
    }
    ctx.paragraphs++;
    const children: (TextRun | ExternalHyperlink | ImageRun)[] = [];
    if (item.task) {
      children.push(new TextRun({ text: item.checked ? "☑ " : "☐ " }));
    }
    children.push(...walkInline(bodyTokens, ctx, quote ? { color: "595959" } : {}));
    out.push(
      new Paragraph({
        ...(token.ordered
          ? { numbering: { reference: "ol", level } }
          : { bullet: { level } }),
        children,
        ...(quote ? { indent: { left: 720 } } : {}),
        spacing: { after: 60 },
      }),
    );
  }
  return out;
}

function makeCodeBlock(token: Tokens.Code, ctx: GenCtx, quote: boolean): Paragraph {
  const lines = token.text.replace(/\n$/, "").split("\n");
  // docx 的 break 是前置 break（<w:br/> 在 run 文本之前）——除第一行外每行 run 带 break
  const runs = lines.map(
    (line, i) =>
      new TextRun({
        text: line,
        font: ctx.opts.monoFont,
        size: 18,
        ...(i > 0 ? { break: 1 } : {}),
      }),
  );
  ctx.paragraphs++;
  return new Paragraph({
    children: runs,
    shading: { fill: "F5F5F5", type: ShadingType.CLEAR },
    spacing: { before: 120, after: 120 },
    ...(quote ? { indent: { left: 720 } } : {}),
  });
}

function makeHr(ctx: GenCtx): Paragraph {
  ctx.paragraphs++;
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999" } },
    spacing: { before: 120, after: 120 },
  });
}

function makeTable(token: Tokens.Table, ctx: GenCtx): Table {
  const rows: TableRow[] = [];
  if (token.header.length > 0) {
    rows.push(new TableRow({ children: token.header.map((cell) => makeTableCell(cell, true, ctx)) }));
  }
  for (const row of token.rows) {
    rows.push(new TableRow({ children: row.map((cell) => makeTableCell(cell, false, ctx)) }));
  }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    borders: {
      top: TABLE_BORDER,
      bottom: TABLE_BORDER,
      left: TABLE_BORDER,
      right: TABLE_BORDER,
      insideHorizontal: TABLE_BORDER,
      insideVertical: TABLE_BORDER,
    },
    rows,
  });
}

function makeTableCell(cell: Tokens.TableCell, header: boolean, ctx: GenCtx): TableCell {
  ctx.paragraphs++;
  // TableCell children 不能空——空单元格放空 Paragraph
  const paragraph =
    cell.tokens.length > 0
      ? new Paragraph({
          style: header ? "TableHeader" : undefined,
          children: walkInline(cell.tokens, ctx),
        })
      : new Paragraph("");
  return new TableCell({
    ...(header ? { shading: { fill: "F2F2F2", type: ShadingType.CLEAR } } : {}),
    children: [paragraph],
  });
}

// ---------------------------------------------------------------------------
// 内部：inline walker
// ---------------------------------------------------------------------------

function walkInline(
  tokens: Token[],
  ctx: GenCtx,
  style: RunStyle = {},
): (TextRun | ExternalHyperlink | ImageRun)[] {
  const out: (TextRun | ExternalHyperlink | ImageRun)[] = [];
  for (const token of std(tokens)) {
    switch (token.type) {
      case "text":
        out.push(new TextRun({ text: token.text, ...style }));
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
        out.push(
          new TextRun({
            text: token.text,
            font: ctx.opts.monoFont,
            shading: { fill: "F5F5F5", type: ShadingType.CLEAR },
            ...style,
          }),
        );
        break;
      case "link":
        out.push(
          new ExternalHyperlink({
            link: token.href,
            children: walkInline(token.tokens, ctx, style),
          }),
        );
        break;
      case "image": {
        const img = embedImage(token, ctx);
        if (img) {
          out.push(img);
        } else {
          ctx.skippedImages++;
          out.push(
            new TextRun({
              text: `[image: ${token.text || token.href}]`,
              italics: true,
              color: "808080",
              ...style,
            }),
          );
        }
        break;
      }
      case "br":
        out.push(new TextRun({ break: 1, ...style }));
        break;
      case "escape":
        out.push(new TextRun({ text: token.text, ...style }));
        break;
      case "html":
        out.push(new TextRun({ text: token.text, ...style }));
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 内部：图片 embed
// ---------------------------------------------------------------------------

const IMAGE_TYPES: Record<string, "jpg" | "png" | "gif" | "bmp"> = {
  jpg: "jpg",
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  bmp: "bmp",
};

/** 读本地图片嵌入。URL/data URI/超限/非图片/读不到 → 返回 null（调用方降级占位）。 */
function embedImage(token: Tokens.Image, ctx: GenCtx): ImageRun | null {
  if (ctx.opts.images === "skip") return null;
  const href = token.href;
  if (!href || /^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith("data:")) return null;
  const cwd = ctx.opts.cwd;
  if (!cwd) return null;
  const resolved = resolveDocxOutPath(cwd, href);
  if (!resolved.ok) return null;

  let buf: Buffer;
  try {
    const st = statSync(resolved.path);
    if (st.size > DOCX_MAX_IMAGE_BYTES) return null;
    buf = readFileSync(resolved.path);
  } catch {
    return null;
  }

  let size: { width: number; height: number; type?: string } | null = null;
  try {
    const measured = imageSize(buf);
    if (measured && measured.width && measured.height) {
      size = { width: measured.width, height: measured.height, type: measured.type };
    }
  } catch {
    return null;
  }
  if (!size) return null;
  const type = size.type ? IMAGE_TYPES[size.type.toLowerCase()] : undefined;
  if (!type) return null;

  const scale = size.width > DOCX_MAX_IMAGE_WIDTH ? DOCX_MAX_IMAGE_WIDTH / size.width : 1;
  ctx.images++;
  return new ImageRun({
    type,
    data: buf,
    transformation: {
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
    },
    altText: token.text ? { name: token.text, description: token.text } : undefined,
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * markdown → .docx buffer。成功返回 buffer + 计数（paragraphs/images/skippedImages），
 * 失败返 {ok:false} 不抛——与 parseDocx 同哲学：结构化结果让上层转文本提示。
 * 图片失败不算错：降级占位段 + skippedImages 计数（与 read_docx 的
 * "images replaced with alt text" 语义对称）。
 */
export async function markdownToDocxBuffer(
  markdown: string,
  opts: DocxGenOptions = {},
): Promise<DocxGenResult> {
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

  const ctx: GenCtx = {
    opts: {
      cwd: opts.cwd,
      font: opts.font ?? "Calibri",
      eastAsiaFont: opts.eastAsiaFont ?? "Microsoft YaHei",
      monoFont: opts.monoFont ?? "Consolas",
      fontSize: opts.fontSize ?? 21,
      images: opts.images ?? "embed",
    },
    paragraphs: 0,
    images: 0,
    skippedImages: 0,
  };

  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unknown", detail: `markdown parse failed: ${msg}` };
  }

  const children = walkBlocks(tokens, ctx);
  const hasOrderedList = tokens.some((t) => t.type === "list" && t.ordered);

  try {
    const doc = new Document({
      styles: {
        default: {
          document: {
            // 属性形式 {ascii, hAnsi, eastAsia}：{name, eastAsia} 形式 eastAsia 会被 docx 静默丢弃
            run: {
              font: { ascii: ctx.opts.font, hAnsi: ctx.opts.font, eastAsia: ctx.opts.eastAsiaFont },
              size: ctx.opts.fontSize,
            },
            paragraph: { spacing: { line: 276, lineRule: LineRuleType.AUTO } },
          },
        },
        paragraphStyles: [{ id: "TableHeader", name: "Table Header", basedOn: "Normal", run: { bold: true } }],
      },
      ...(hasOrderedList ? { numbering: { config: [OL_NUMBERING] } } : {}),
      sections: [{ children }],
    });
    const buffer = await Packer.toBuffer(doc);
    return {
      ok: true,
      buffer,
      paragraphs: ctx.paragraphs,
      images: ctx.images,
      skippedImages: ctx.skippedImages,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "unknown", detail: `docx generation failed: ${msg}` };
  }
}
