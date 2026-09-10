// IR → markdown（read 输出，格式干净）。与 toModel 对称：扩展语法原样输出，
// 保证 markdown → docx → markdown round-trip 内容保真。

import type { Block, DocxDocument, Field, HeaderFooter, Image, Paragraph, Run, Table, TableCell } from "../model.js";

export interface ModelToMarkdownOptions {
  /** 图片策略：placeholder 占位（默认）/ skip 跳过 / base64 内嵌 */
  images?: "placeholder" | "skip" | "base64";
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
};

/** IR 文档 → markdown（多节用 \newpage 分隔，分节属性不输出） */
export function modelToMarkdown(doc: DocxDocument, opts: ModelToMarkdownOptions = {}): string {
  const images = opts.images ?? "placeholder";
  const parts: string[] = [];
  for (const hf of doc.sections[0]?.headers ?? []) parts.push(headerFooterToMd(hf, "header", doc, images));
  for (const hf of doc.sections[0]?.footers ?? []) parts.push(headerFooterToMd(hf, "footer", doc, images));
  for (let i = 0; i < doc.sections.length; i++) {
    if (i > 0) parts.push("\\newpage");
    parts.push(...doc.sections[i].blocks.map((b) => blockToMd(b, doc, images)));
  }
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function headerFooterToMd(
  hf: HeaderFooter,
  kind: "header" | "footer",
  doc: DocxDocument,
  images: ModelToMarkdownOptions["images"],
): string {
  // 页眉页脚文本是单行（::: header 文本），块间直接拼接
  const text = hf.blocks.map((b) => blockToMd(b, doc, images)).join("");
  return `::: ${kind} ${text}`;
}

function blockToMd(b: Block, doc: DocxDocument, images: ModelToMarkdownOptions["images"]): string {
  switch (b.kind) {
    case "paragraph":
      return paragraphToMd(b, doc, images);
    case "table":
      return tableToMd(b, doc, images);
    case "image":
      return imageToMd(b, doc, images);
    case "field":
      return fieldToMd(b);
    case "pagebreak":
      return "\\newpage";
    case "hr":
      return "---";
    case "bookmark":
      return `<!--bookmark:${b.name}-->`;
  }
}

function paragraphToMd(p: Paragraph, doc: DocxDocument, images: ModelToMarkdownOptions["images"]): string {
  // 代码块：段落底纹 + 全 monoFont runs → ``` 围栏
  if (p.shading && p.runs.length > 0 && p.runs.every((r) => r.font && !r.bold && !r.italics)) {
    // 换行由 run 序列表达，三种形态统一处理：
    // 1. IR 形态（makeCodeBlock）：text 无 \n，break 标志贡献换行 → run 间插 \n
    // 2. parse 读回形态：br → text="\n" + break 的 run → 换行在 run 的 text 里，不插分隔符
    // 3. Word 保存后形态：br+text 合并 run（"\nminclass = 3"）→ 同上
    // 若一律 join("\n")，形态 2/3 的 br 换行与分隔符叠加，无空行代码块读回会多空行。
    let text = "";
    for (const r of p.runs) {
      // 当前 run 以 \n 开头（br run / br+text 合并 run）→ 换行已由 run 自身表达，不插分隔符
      if (text && !r.text.startsWith("\n") && !text.endsWith("\n")) text += "\n";
      text += r.text;
    }
    return "```\n" + text + "\n```";
  }
  const text = p.runs.map((r) => runToMd(r, doc, images)).join("");
  if (p.style) {
    const m = /^Heading([1-6])$/i.exec(p.style);
    if (m) return `${"#".repeat(Number(m[1]))} ${text}`;
  }
  if (p.align === "center" || p.align === "right" || p.align === "justify") {
    return `::: ${p.align}\n${text}`;
  }
  if (p.style === "FigureCaption") return `::: caption\n${text}`;
  if (p.style === "TableCaption") return `::: tablecaption\n${text}`;
  return text;
}

function runToMd(run: Run, doc: DocxDocument, images: ModelToMarkdownOptions["images"]): string {
  let text = run.text;
  if (run.shading) text = `\`${text}\``;
  if (run.bold) text = `**${text}**`;
  if (run.italics) text = `*${text}*`;
  if (run.strike) text = `~~${text}~~`;
  if (run.link) {
    if ("href" in run.link) text = `[${text}](${run.link.href})`;
    else text = `[${text}](#${run.link.anchor})`;
  }
  return text;
}

function tableToMd(t: Table, doc: DocxDocument, images: ModelToMarkdownOptions["images"]): string {
  if (t.rows.length === 0) return "";
  const rows = t.rows.map((r) => "| " + r.cells.map((c) => cellToMd(c, doc, images)).join(" | ") + " |");
  const colCount = Math.max(...t.rows.map((r) => r.cells.length));
  const sep = Array.from({ length: colCount }, () => "---").join(" | ");
  // 第一行底纹（表头）→ 分隔行；否则不输出分隔行（无表头）
  const firstIsHeader = t.rows[0].cells.every((c) => c.shading === "F2F2F2");
  if (firstIsHeader) {
    return [rows[0], sep, ...rows.slice(1)].join("\n");
  }
  return rows.join("\n");
}

function cellToMd(c: TableCell, doc: DocxDocument, images: ModelToMarkdownOptions["images"]): string {
  return c.blocks.map((b) => blockToMd(b, doc, images)).join(" ");
}

function imageToMd(img: Image, doc: DocxDocument, images: ModelToMarkdownOptions["images"]): string {
  const media = doc.media[img.mediaId];
  const alt = img.alt ?? "";
  if (images === "skip") return "";
  if (images === "base64" && media) {
    const mime = MIME_TYPES[media.type] ?? "image/png";
    return `![${alt}](data:${mime};base64,${media.data.toString("base64")})`;
  }
  // placeholder：假路径 + 尺寸参数（round-trip 时 {width=} 还原宽度）
  const ext = media?.type ?? "png";
  return `![${alt}](media/${img.mediaId}.${ext}){width=${img.width}}`;
}

function fieldToMd(f: Field): string {
  if (f.type === "toc") {
    // 变体从 instr 解析（\t "Style,level"）：FigureCaption → 图目录，TableCaption → 表目录
    const m = /\\t\s+"([^"]+),(\d+)"/.exec(f.instr ?? "");
    if (m && m[1] === "FigureCaption") return "[TOC:figures]";
    if (m && m[1] === "TableCaption") return "[TOC:tables]";
    return "[TOC]";
  }
  if (f.type === "page") return "{page}";
  if (f.type === "numpages") return "{numpages}";
  return `{field: ${f.instr ?? f.type}}`;
}
