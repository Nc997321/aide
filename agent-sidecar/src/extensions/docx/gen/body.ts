// IR blocks → docx 库节点（平移 gen.ts 的 walker 逻辑，输入从 marked tokens 改为 IR）。
// 纯转换无 IO：图片字节在 IR media 里，域用 docx 库 TableOfContents/SimpleField 生成。

import {
  AlignmentType,
  BorderStyle,
  BookmarkEnd,
  BookmarkStart,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  PageBreak,
  Paragraph,
  ShadingType,
  SimpleField,
  Tab,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ITableOptions,
  type ITableCellOptions,
} from "docx";
import type {
  Block,
  Field,
  Image,
  MediaFile,
  Paragraph as IRParagraph,
  Run as IRRun,
  Table as IRTable,
  TableCell as IRTableCell,
} from "../model.js";

export interface GenCtx {
  opts: {
    font: string;
    eastAsiaFont: string;
    monoFont: string;
    fontSize: number;
  };
  media: MediaFile[];
  paragraphs: number;
  images: number;
  bookmarkId: number;
}

/** 文档级块（sections children 接受 TableOfContents；单元格/页眉内需过滤） */
export type DocxBlock = Paragraph | Table | TableOfContents;

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const ALIGN_MAP: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

const TABLE_BORDER = {
  style: BorderStyle.SINGLE,
  size: 4,
  color: "999999",
};

/** 过滤掉 TableOfContents（单元格/页眉页脚 children 不接受文档级块） */
export function withoutToc(blocks: DocxBlock[]): (Paragraph | Table)[] {
  return blocks.filter((b): b is Paragraph | Table => !(b instanceof TableOfContents));
}

/** IR 块序列 → docx 节点序列 */
export function blocksToDocx(blocks: Block[], ctx: GenCtx): DocxBlock[] {
  const out: DocxBlock[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
        out.push(paragraphToDocx(block, ctx));
        break;
      case "table":
        out.push(tableToDocx(block, ctx));
        break;
      case "image":
        out.push(imageToDocx(block, ctx));
        break;
      case "field":
        out.push(...fieldToDocx(block, ctx));
        break;
      case "pagebreak":
        out.push(pagebreakToDocx(ctx));
        break;
      case "hr":
        out.push(hrToDocx(ctx));
        break;
      case "bookmark":
        out.push(bookmarkToDocx(block, ctx));
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 段落 / run
// ---------------------------------------------------------------------------

function paragraphToDocx(p: IRParagraph, ctx: GenCtx): Paragraph {
  ctx.paragraphs++;
  const children: (TextRun | ExternalHyperlink | InternalHyperlink)[] = [];
  for (const run of p.runs) children.push(...runToDocx(run, ctx));

  const opts: IParagraphOptions = {
    children,
    // Heading1-6 → heading 属性（docx 库自带样式定义）；其他样式 id → style 引用
    ...(p.style
      ? (() => {
          const m = /^Heading([1-6])$/i.exec(p.style);
          return m ? { heading: HEADING_LEVELS[Number(m[1]) - 1] } : { style: p.style };
        })()
      : {}),
    ...(p.align ? { alignment: ALIGN_MAP[p.align] } : {}),
    ...(p.indent
      ? {
          indent: {
            ...(p.indent.left !== undefined ? { left: p.indent.left } : {}),
            ...(p.indent.right !== undefined ? { right: p.indent.right } : {}),
            ...(p.indent.hanging !== undefined ? { hanging: p.indent.hanging } : {}),
          },
        }
      : {}),
    ...(p.spacing
      ? {
          spacing: {
            ...(p.spacing.before !== undefined ? { before: p.spacing.before } : {}),
            ...(p.spacing.after !== undefined ? { after: p.spacing.after } : {}),
            ...(p.spacing.line !== undefined ? { line: p.spacing.line } : {}),
          },
        }
      : {}),
    ...(p.pageBreakBefore ? { pageBreakBefore: true } : {}),
    ...(p.shading ? { shading: { fill: p.shading, type: ShadingType.CLEAR } } : {}),
  };
  return new Paragraph(opts);
}

/** IR run → docx run 序列（\t 拆 Tab、\n 拆 break、link 包超链接） */
function runToDocx(run: IRRun, ctx: GenCtx): (TextRun | ExternalHyperlink | InternalHyperlink)[] {
  const textRuns = textToRuns(run.text, run);
  // IR break 标志（makeCodeBlock 每行一个 run + break / 行内 br token）→ 行首补 <w:br/> run。
  // 只拆 text 里的 \n 不够：makeCodeBlock 把每行拆成独立 run + break 标志，text 里没有 \n。
  if (run.break) {
    textRuns.unshift(new TextRun({ break: 1, ...runStyle(run) }));
  }
  if (run.link) {
    const children = textRuns;
    if ("href" in run.link) return [new ExternalHyperlink({ link: run.link.href, children })];
    return [new InternalHyperlink({ anchor: run.link.anchor, children })];
  }
  return textRuns;
}

function textToRuns(text: string, run: IRRun): TextRun[] {
  if (!text.includes("\t") && !text.includes("\n")) {
    return [makeTextRun(text, run)];
  }
  const out: TextRun[] = [];
  let pending = "";
  for (const part of text.split(/(\t|\n)/)) {
    if (part === "\t") {
      if (pending) {
        out.push(makeTextRun(pending, run));
        pending = "";
      }
      out.push(new TextRun({ children: [new Tab()], ...runStyle(run) }));
    } else if (part === "\n") {
      if (pending) {
        out.push(makeTextRun(pending, run));
        pending = "";
      }
      out.push(new TextRun({ break: 1, ...runStyle(run) }));
    } else {
      pending += part;
    }
  }
  if (pending) out.push(makeTextRun(pending, run));
  return out;
}

function makeTextRun(text: string, run: IRRun): TextRun {
  return new TextRun({ text, ...runStyle(run) });
}

function runStyle(run: IRRun): Partial<IRunOptions> {
  return {
    ...(run.bold ? { bold: true } : {}),
    ...(run.italics ? { italics: true } : {}),
    ...(run.strike ? { strike: true } : {}),
    ...(run.underline ? { underline: { type: UnderlineType.SINGLE } } : {}),
    ...(run.font ? { font: run.font } : {}),
    ...(run.size ? { size: run.size } : {}),
    ...(run.color ? { color: run.color } : {}),
    // highlight 值域与 Word 枚举一致（parse 端原样读回），断言收窄
    ...(run.highlight ? { highlight: run.highlight as IRunOptions["highlight"] } : {}),
    ...(run.shading ? { shading: { fill: run.shading, type: ShadingType.CLEAR } } : {}),
  };
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

function tableToDocx(t: IRTable, ctx: GenCtx): Table {
  const rows = t.rows.map(
    (r) => new TableRow({ children: r.cells.map((c) => cellToDocx(c, ctx)) }),
  );
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
    ...(t.widths && t.widths.length > 0 ? { columnWidths: t.widths } : {}),
    rows,
  });
}

function cellToDocx(c: IRTableCell, ctx: GenCtx): TableCell {
  const children =
    c.blocks.length > 0 ? withoutToc(blocksToDocx(c.blocks, ctx)) : [new Paragraph("")];
  return new TableCell({
    children,
    ...(c.gridSpan ? { columnSpan: c.gridSpan } : {}),
    ...(c.width ? { width: { size: c.width, type: WidthType.DXA } } : {}),
    ...(c.shading ? { shading: { fill: c.shading, type: ShadingType.CLEAR } } : {}),
  });
}

// ---------------------------------------------------------------------------
// 图片 / 域 / 其它块
// ---------------------------------------------------------------------------

function imageToDocx(img: Image, ctx: GenCtx): Paragraph {
  const media = ctx.media[img.mediaId];
  ctx.images++;
  if (!media) {
    // media 缺失（越界/被跳过）→ 降级占位文本
    return new Paragraph({
      children: [
        new TextRun({
          text: `[image: ${img.alt ?? img.mediaId}]`,
          italics: true,
          color: "808080",
        }),
      ],
    });
  }
  return new Paragraph({
    children: [
      new ImageRun({
        type: media.type,
        data: media.data,
        transformation: { width: img.width, height: img.height },
        ...(img.alt ? { altText: { name: img.alt, description: img.alt } } : {}),
      }),
    ],
  });
}

/**
 * 域 → docx 节点：
 * - toc → TableOfContents（SDT 包裹 + beginDirty 自动更新 + 缓存条目）
 * - page/numpages/other → SimpleField（完整 fldChar 结构，缓存取首个段落文本）
 */
function fieldToDocx(field: Field, ctx: GenCtx): DocxBlock[] {
  if (field.type === "toc") {
    const entries: Array<{ title: string; level: number }> = [];
    for (const block of field.cached ?? []) {
      if (block.kind !== "paragraph") continue;
      const title = block.runs.map((r) => r.text).join("").trim();
      if (!title) continue;
      const m = /^TOC(\d)$/i.exec(block.style ?? "");
      entries.push({ title, level: m ? Number(m[1]) : 1 });
    }
    // 变体：instr 带 \t "Style,level"（[TOC:figures]/[TOC:tables]）→ 按样式收集；
    // 默认 \o "1-3" → 按 Heading1-3 收集。instr 是唯一事实源（toModel 生成、parse 读回）。
    // 样式名必须与 styles.ts 的 captionFallbackStyles 一致（Word 按 styleId 匹配，实测）。
    const styleMatch = /\\t\s+"([^"]+),(\d+)"/.exec(field.instr ?? "");
    return [
      new TableOfContents("Table of Contents", {
        ...(styleMatch
          ? { stylesWithLevels: [{ styleName: styleMatch[1], level: Number(styleMatch[2]) }] }
          : { headingStyleRange: "1-3", useAppliedParagraphOutlineLevel: true }),
        hyperlink: true,
        hideTabAndPageNumbersInWebView: true,
        beginDirty: true,
        ...(entries.length > 0 ? { cachedEntries: entries } : {}),
      }),
    ];
  }
  const cachedText =
    field.cached?.find((b) => b.kind === "paragraph")?.runs.map((r) => r.text).join("") ?? "";
  ctx.paragraphs++;
  return [
    new Paragraph({
      children: [new SimpleField(field.instr ?? field.type.toUpperCase(), cachedText || undefined)],
    }),
  ];
}

function pagebreakToDocx(ctx: GenCtx): Paragraph {
  ctx.paragraphs++;
  return new Paragraph({ children: [new PageBreak()] });
}

function hrToDocx(ctx: GenCtx): Paragraph {
  ctx.paragraphs++;
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999" } },
    spacing: { before: 120, after: 120 },
  });
}

function bookmarkToDocx(bookmark: { name: string }, ctx: GenCtx): Paragraph {
  const id = ctx.bookmarkId++;
  return new Paragraph({ children: [new BookmarkStart(bookmark.name, id), new BookmarkEnd(id)] });
}
