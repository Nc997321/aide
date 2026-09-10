// docx 统一文档模型（IR）：read/write 共享的唯一真相。
// parse/ 把 OOXML 解析成 IR，gen/ 把 IR 生成 OOXML，md/ 在 markdown 与 IR 之间转换。
// 设计见 docs/superpowers/specs/2026-08-13-docx-unified-model-design.md

export type Align = "left" | "center" | "right" | "justify";

export type PageNumberFormat = "decimal" | "upperRoman" | "lowerRoman" | "upperLetter" | "lowerLetter";

export interface MediaFile {
  data: Buffer;
  type: "png" | "jpg" | "gif" | "bmp";
  /** 原始像素宽 */
  width: number;
  /** 原始像素高 */
  height: number;
}

export interface Run {
  text: string;
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  underline?: boolean;
  font?: string;
  /** 字号（半磅） */
  size?: number;
  color?: string;
  highlight?: string;
  /** 超链接：外部 URL 或内部书签锚点 */
  link?: { href: string } | { anchor: string };
  /** 段内换行（<w:br/>） */
  break?: boolean;
  /** 底纹（行内代码用，如 F5F5F5） */
  shading?: string;
}

export interface Paragraph {
  kind: "paragraph";
  runs: Run[];
  /** 样式 id（如 Heading1），md 层据此判定标题层级 */
  style?: string;
  align?: Align;
  indent?: { left?: number; right?: number; hanging?: number };
  spacing?: { before?: number; after?: number; line?: number };
  pageBreakBefore?: boolean;
  /** 底纹（代码块用，如 F5F5F5） */
  shading?: string;
}

export interface TableRow {
  cells: TableCell[];
}

export interface TableCell {
  blocks: Block[];
  /** 横向合并列数（gridSpan） */
  gridSpan?: number;
  width?: number;
  shading?: string;
}

export interface Table {
  kind: "table";
  rows: TableRow[];
  /** 列宽（twips），来自 tblGrid */
  widths?: number[];
}

export interface Image {
  kind: "image";
  /** media 数组下标 */
  mediaId: number;
  /** 渲染宽（px） */
  width: number;
  /** 渲染高（px） */
  height: number;
  alt?: string;
}

export interface Field {
  kind: "field";
  type: "toc" | "page" | "numpages" | "other";
  /** 域指令原文（如 TOC \o "1-3" \h \z \u） */
  instr?: string;
  /** 缓存结果（separate 与 end 之间的块） */
  cached?: Block[];
}

export interface PageBreak {
  kind: "pagebreak";
}

export interface Hr {
  kind: "hr";
}

export interface Bookmark {
  kind: "bookmark";
  name: string;
  /** true = 跳转目标（bookmarkStart/End 对）；false = 跳转引用（hyperlink anchor） */
  anchor?: boolean;
}

export type Block = Paragraph | Table | Image | Field | PageBreak | Hr | Bookmark;

export interface HeaderFooter {
  type: "default" | "first" | "even";
  blocks: Block[];
}

export interface Section {
  headers: HeaderFooter[];
  footers: HeaderFooter[];
  pageSize?: { width: number; height: number };
  pageMargins?: { top: number; right: number; bottom: number; left: number };
  pageNumberFormat?: PageNumberFormat;
  startPageNumber?: number;
  /** 首页不同 */
  titlePg?: boolean;
  /** 奇偶页不同 */
  evenAndOddHeaders?: boolean;
  blocks: Block[];
}

export interface StyleDef {
  id: string;
  name?: string;
  type: "paragraph" | "character";
  basedOn?: string;
  /** 解析后的有效属性（含 basedOn 继承合并结果） */
  bold?: boolean;
  italics?: boolean;
  size?: number;
  font?: string;
  color?: string;
  align?: Align;
  /** 大纲级别 0-8（0 = 一级标题），heading 判定依据 */
  outlineLevel?: number;
}

export interface DocxDocument {
  sections: Section[];
  styles: Map<string, StyleDef>;
  media: MediaFile[];
}
