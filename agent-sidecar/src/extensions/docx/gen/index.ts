// IR → OOXML 门面：DocxDocument → .docx buffer。
// 与 parse/index.ts 对称（parse 是 OOXML → IR，gen 是 IR → OOXML），
// 阶段 3 起 markdown 先转 IR 再走这里，gen.ts（marked 直转）退役。

import { Document, Footer, Header, NumberFormat, Packer } from "docx";
import type { ISectionOptions, ISectionPropertiesOptions } from "docx";
import type { DocxDocument, PageNumberFormat as IRPageNumberFormat } from "../model.js";
import { blocksToDocx, type GenCtx } from "./body.js";
import { footerToDocx, headerToDocx } from "./headers.js";
import { captionFallbackStyles, stylesToDocx, tocFallbackStyles } from "./styles.js";

export interface ModelToDocxOptions {
  /** 西文字体（ascii/hAnsi/cs），默认 Calibri。 */
  font?: string;
  /** 中文（eastAsia）字体，默认 Microsoft YaHei。 */
  eastAsiaFont?: string;
  /** 代码块等宽字体，默认 Consolas。 */
  monoFont?: string;
  /** 正文字号（半磅），默认 21 = 10.5pt。 */
  fontSize?: number;
}

const PAGE_NUMBER_FORMAT_MAP: Record<IRPageNumberFormat, (typeof NumberFormat)[keyof typeof NumberFormat]> = {
  decimal: NumberFormat.DECIMAL,
  upperRoman: NumberFormat.UPPER_ROMAN,
  lowerRoman: NumberFormat.LOWER_ROMAN,
  upperLetter: NumberFormat.UPPER_LETTER,
  lowerLetter: NumberFormat.LOWER_LETTER,
};

/** IR 文档 → .docx buffer（纯转换，不碰写盘） */
export async function modelToDocxBuffer(
  doc: DocxDocument,
  opts: ModelToDocxOptions = {},
): Promise<Buffer> {
  const ctx: GenCtx = {
    opts: {
      font: opts.font ?? "Calibri",
      eastAsiaFont: opts.eastAsiaFont ?? "Microsoft YaHei",
      monoFont: opts.monoFont ?? "Consolas",
      fontSize: opts.fontSize ?? 21,
    },
    media: doc.media,
    paragraphs: 0,
    images: 0,
    bookmarkId: 0,
  };

  let evenAndOddHeaders = false;
  const sections: ISectionOptions[] = doc.sections.map((s) => {
    const headers: { default?: Header; first?: Header; even?: Header } = {};
    const footers: { default?: Footer; first?: Footer; even?: Footer } = {};
    for (const hf of s.headers) headers[hf.type] = headerToDocx(hf, ctx);
    for (const hf of s.footers) footers[hf.type] = footerToDocx(hf, ctx);
    if (s.evenAndOddHeaders) evenAndOddHeaders = true;

    const page: NonNullable<ISectionPropertiesOptions["page"]> = {
      ...(s.pageSize ? { size: { width: s.pageSize.width, height: s.pageSize.height } } : {}),
      ...(s.pageMargins
        ? {
            margin: {
              top: s.pageMargins.top,
              right: s.pageMargins.right,
              bottom: s.pageMargins.bottom,
              left: s.pageMargins.left,
            },
          }
        : {}),
      ...(s.pageNumberFormat || s.startPageNumber !== undefined
        ? {
            pageNumbers: {
              ...(s.pageNumberFormat ? { formatType: PAGE_NUMBER_FORMAT_MAP[s.pageNumberFormat] } : {}),
              ...(s.startPageNumber !== undefined ? { start: s.startPageNumber } : {}),
            },
          }
        : {}),
    };
    const properties: ISectionPropertiesOptions = {
      ...(Object.keys(page).length > 0 ? { page } : {}),
      ...(s.titlePg ? { titlePage: true } : {}),
    };

    return {
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(footers).length > 0 ? { footers } : {}),
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      children: blocksToDocx(s.blocks, ctx),
    };
  });

  const { paragraphStyles, characterStyles } = stylesToDocx(doc.styles);
  const tocFallback = tocFallbackStyles(doc.styles);
  const captionFallback = captionFallbackStyles(doc.styles);
  const document = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: ctx.opts.font, eastAsia: ctx.opts.eastAsiaFont, hAnsi: ctx.opts.font },
            size: ctx.opts.fontSize,
          },
        },
      },
      paragraphStyles: [...paragraphStyles, ...tocFallback.paragraphStyles, ...captionFallback.paragraphStyles],
      characterStyles,
    },
    ...(evenAndOddHeaders ? { settings: { evenAndOddHeaders: true } } : {}),
    sections,
  });

  return Packer.toBuffer(document);
}
