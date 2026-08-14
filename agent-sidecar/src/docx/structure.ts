// IR → structure JSON（read_docx structure 模式输出）。
// 目的：长文档让模型先看结构再决定读哪段，避免全文灌 context。
// 统计只遍历正文（含表格单元格内块）；页眉页脚单独提取文本内容。

import type { Block, DocxDocument, Field, HeaderFooter, Paragraph, Section } from "./model.js";

export interface DocxStructure {
  /** 分节数 */
  sections: number;
  /** 正文段落数（含表格单元格内段落） */
  paragraphs: number;
  /** 图片数 */
  images: number;
  /** 表格数 */
  tables: number;
  /** 标题清单（按出现顺序，level 1-6） */
  headings: Array<{ level: number; text: string }>;
  /** 域清单（TOC/PAGE/NUMPAGES 等） */
  fields: Array<{ type: Field["type"]; instr?: string }>;
  /** 书签（跳转目标） */
  bookmarks: string[];
  /** 页眉内容（纯文本，{page} 等域占位符保留） */
  headers: string[];
  /** 页脚内容 */
  footers: string[];
  /** 分节属性（仅非默认时输出） */
  pageSize?: { width: number; height: number };
  pageMargins?: { top: number; right: number; bottom: number; left: number };
  pageNumberFormat?: string;
  startPageNumber?: number;
  titlePg?: boolean;
  evenAndOddHeaders?: boolean;
}

/** 块 → 纯文本（页眉页脚用；域输出占位符，图片/表格输出标记） */
function blockToText(b: Block): string {
  switch (b.kind) {
    case "paragraph":
      return b.runs.map((r) => r.text).join("");
    case "field":
      if (b.type === "toc") return "[TOC]";
      if (b.type === "page") return "{page}";
      if (b.type === "numpages") return "{numpages}";
      return `{field: ${b.instr ?? b.type}}`;
    case "image":
      return `[image: ${b.alt ?? b.mediaId}]`;
    case "table":
      return "[table]";
    case "pagebreak":
      return "\\newpage";
    case "hr":
      return "---";
    case "bookmark":
      return "";
  }
}

function headerFooterToText(hf: HeaderFooter): string {
  return hf.blocks.map(blockToText).join("");
}

/** 统计 + 收集（正文递归，含表格单元格） */
function walkBlocks(blocks: Block[], acc: {
  paragraphs: number;
  images: number;
  tables: number;
  headings: Array<{ level: number; text: string }>;
  fields: Array<{ type: Field["type"]; instr?: string }>;
  bookmarks: string[];
}): void {
  for (const b of blocks) {
    switch (b.kind) {
      case "paragraph":
        acc.paragraphs++;
        if (b.style) {
          const m = /^Heading([1-6])$/i.exec(b.style);
          if (m) acc.headings.push({ level: Number(m[1]), text: b.runs.map((r) => r.text).join("") });
        }
        break;
      case "table":
        acc.tables++;
        for (const row of b.rows) {
          for (const cell of row.cells) walkBlocks(cell.blocks, acc);
        }
        break;
      case "image":
        acc.images++;
        break;
      case "field":
        acc.fields.push({ type: b.type, ...(b.instr ? { instr: b.instr } : {}) });
        break;
      case "bookmark":
        if (b.anchor) acc.bookmarks.push(b.name);
        break;
      default:
        break;
    }
  }
}

/** IR 文档 → structure JSON（read structure 模式）。纯函数，无 IO。 */
export function docxToStructure(doc: DocxDocument): DocxStructure {
  const acc = {
    paragraphs: 0,
    images: 0,
    tables: 0,
    headings: [] as Array<{ level: number; text: string }>,
    fields: [] as Array<{ type: Field["type"]; instr?: string }>,
    bookmarks: [] as string[],
  };
  for (const section of doc.sections) walkBlocks(section.blocks, acc);

  const out: DocxStructure = {
    sections: doc.sections.length,
    paragraphs: acc.paragraphs,
    images: acc.images,
    tables: acc.tables,
    headings: acc.headings,
    fields: acc.fields,
    bookmarks: acc.bookmarks,
    headers: doc.sections[0]?.headers.map(headerFooterToText) ?? [],
    footers: doc.sections[0]?.footers.map(headerFooterToText) ?? [],
  };

  // 分节属性：只输出第一节的非默认值（多节差异由模型自行判断，避免重复噪音）
  const s0: Section | undefined = doc.sections[0];
  if (s0?.pageSize) out.pageSize = s0.pageSize;
  if (s0?.pageMargins) out.pageMargins = s0.pageMargins;
  if (s0?.pageNumberFormat) out.pageNumberFormat = s0.pageNumberFormat;
  if (s0?.startPageNumber !== undefined) out.startPageNumber = s0.startPageNumber;
  if (s0?.titlePg) out.titlePg = true;
  if (s0?.evenAndOddHeaders) out.evenAndOddHeaders = true;
  return out;
}
