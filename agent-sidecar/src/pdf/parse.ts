// PDF 解析：pdfjs-dist 封装（文本提取 + 坐标布局重建 + 分页读取）。
//
// 为什么用 pdfjs-dist 而不是 pdftotext：部分中文 PDF（如 WPS/报告生成器产物）内嵌字体
// 缺 ToUnicode CMap，poppler 的 pdftotext 提取中文全丢（实测云眸手册 63 页中文变 `""`），
// pdfjs-dist 会走字体内嵌 cmap 兜底，中文正常（实测同文件提取完整）。
//
// 布局重建：getTextContent 的 items 带坐标（transform[4]=x, transform[5]=y，PDF y 轴从下
// 往上），按 y 降序分组（容差内同行）、组内 x 升序、x 间隙 > PDF_COLUMN_GAP 插空格——
// 段落/标题/表格行正确分行，表格列可读（实测云眸手册参数表列清晰）。

// 副作用 import 必须在 pdfjs 之前，且顺序固定：
// 1. dommatrix-polyfill：bun compile 会把 pdfjs 的动态 import 静态打包，canvas 模块顶层
//    `new DOMMatrix()` 立即执行，无 polyfill 则 ReferenceError（见 dommatrix-polyfill.ts）。
// 2. pdf.worker.mjs 静态 import：Node 下 pdfjs 的 fake worker 用 `await import(workerSrc)`
//    动态加载 worker，bun compile 的 exe 里该路径解析失败（"Cannot find module
//    './pdf.worker.mjs'"）。worker 模块加载时设置 globalThis.pdfjsWorker，fake worker
//    检测到 #mainThreadWorkerMessageHandler 存在就直接用主线程 handler，不再动态 import。
// ESM 按声明顺序执行副作用，此两 import 必须排最前。
import "./dommatrix-polyfill.js";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { getDocument, OPS, PasswordException, InvalidPDFException } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  PDF_MAX_CHARS,
  PDF_DEFAULT_PAGE_LIMIT,
  PDF_PREVIEW_PAGES,
  PDF_MAX_PAGES_PER_READ,
  PDF_LINE_Y_TOLERANCE,
  PDF_COLUMN_GAP,
} from "./constants.js";
export { PDF_MAX_CHARS, PDF_MAX_BYTES } from "./constants.js";

export type PdfErrorReason = "not_found" | "not_pdf" | "encrypted" | "too_large" | "invalid_arg" | "unknown";

/** 单页概览（structure 模式 + markdown 模式 meta 共用） */
export interface PdfPageInfo {
  page: number;
  /** 文本字符数（0 = 无文本层，扫描版） */
  chars: number;
  /** 页内图片数（getOperatorList 统计 paintImageXObject） */
  images: number;
  /** 文本前 80 字符（换行折叠成空格） */
  preview: string;
  /** 无文本层（扫描图片页） */
  scanned: boolean;
}

export interface PdfMeta {
  /** 文档总页数 */
  pages: number;
  /** 本次实际读取的页数 */
  readPages: number;
  /** 本次读取页的图片总数 */
  images: number;
  /** 本次读取页中无文本层的页数 */
  scannedPages: number;
}

export interface PdfStructure {
  pageCount: number;
  pages: PdfPageInfo[];
}

export type PdfParseResult =
  | { ok: true; mode: "markdown"; markdown: string; truncated: boolean; meta: PdfMeta }
  | { ok: true; mode: "structure"; structure: PdfStructure; truncated: boolean }
  | { ok: false; reason: PdfErrorReason; detail: string };

export interface PdfReadOptions {
  /** 输出模式：markdown（默认，分页 markdown 流）| structure（每页概览 JSON） */
  mode?: "markdown" | "structure";
  /** 页范围："3" | "1-5" | "1,3,5-7"。不传时 ≤ PDF_DEFAULT_PAGE_LIMIT 页读全部，否则只读前 PDF_PREVIEW_PAGES 页 */
  pages?: string;
}

/** getTextContent item 的最小形状（不依赖 pdfjs-dist 类型导出，避免类型路径漂移） */
interface TextItemLike {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
}

function isTextItem(item: unknown): item is TextItemLike {
  return typeof (item as TextItemLike)?.str === "string";
}

/**
 * 坐标布局重建：y 降序分组（容差内同行）、组内 x 升序、x 间隙 > PDF_COLUMN_GAP 插空格。
 * 纯函数，无 IO。PDF y 轴从下往上，所以 y 大者在上。
 */
export function layoutPage(items: unknown[]): string {
  const valid = items.filter(isTextItem).filter((i) => i.str.trim() !== "");
  valid.sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    if (Math.abs(dy) > PDF_LINE_Y_TOLERANCE) return dy;
    return a.transform[4] - b.transform[4];
  });
  const lines: { y: number; parts: { x: number; w: number; str: string }[] }[] = [];
  for (const it of valid) {
    const y = it.transform[5];
    const last = lines[lines.length - 1];
    if (last && Math.abs(y - last.y) <= PDF_LINE_Y_TOLERANCE) {
      last.parts.push({ x: it.transform[4], w: it.width ?? 0, str: it.str });
    } else {
      lines.push({ y, parts: [{ x: it.transform[4], w: it.width ?? 0, str: it.str }] });
    }
  }
  return lines
    .map((l) => {
      l.parts.sort((a, b) => a.x - b.x);
      let out = "";
      let prevEnd: number | null = null;
      for (const p of l.parts) {
        if (prevEnd !== null && p.x - prevEnd > PDF_COLUMN_GAP) out += " ";
        out += p.str;
        prevEnd = p.x + p.w;
      }
      return out;
    })
    .join("\n");
}

/**
 * pages 参数解析："3" | "1-5" | "1,3,5-7"。纯函数，无 IO。
 * 越界/非法格式/超上限 → { ok:false }，由调用方转 invalid_arg。
 */
export function parsePagesSpec(
  spec: string,
  totalPages: number,
): { ok: true; pages: number[] } | { ok: false; detail: string } {
  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) return { ok: false, detail: "pages is empty" };
  const pages: number[] = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return { ok: false, detail: `invalid pages spec: "${part}" (expected "3" or "1-5")` };
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1 || end > totalPages || start > end) {
      return { ok: false, detail: `pages ${start}-${end} out of range (document has ${totalPages} pages)` };
    }
    for (let i = start; i <= end; i++) pages.push(i);
  }
  if (pages.length > PDF_MAX_PAGES_PER_READ) {
    return { ok: false, detail: `too many pages (${pages.length} > ${PDF_MAX_PAGES_PER_READ} per read)` };
  }
  return { ok: true, pages };
}

/** 页内图片数：getOperatorList 统计 paintImageXObject / paintInlineImageXObject。 */
async function countImages(page: { getOperatorList(): Promise<{ fnArray: number[] }> }): Promise<number> {
  const opList = await page.getOperatorList();
  let n = 0;
  for (const fn of opList.fnArray) {
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) n++;
  }
  return n;
}

/** pdfjs 抛的错误归类成结构化原因。纯函数，无 IO。 */
export function classifyPdfError(err: unknown): {
  reason: Exclude<PdfErrorReason, "not_found" | "too_large" | "invalid_arg">;
  detail: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (err instanceof PasswordException || lower.includes("password")) {
    return { reason: "encrypted", detail: msg || "document is password-protected" };
  }
  if (
    err instanceof InvalidPDFException ||
    lower.includes("invalid pdf") ||
    lower.includes("not a pdf") ||
    lower.includes("malformed")
  ) {
    return { reason: "not_pdf", detail: msg || "file is not a valid PDF" };
  }
  return { reason: "unknown", detail: msg || "failed to parse the PDF" };
}

/**
 * 解析 PDF buffer。默认输出分页 markdown 流（每页 `## Page N` + 布局重建文本），
 * mode: "structure" 输出每页概览 JSON（页号/字符数/图片数/预览，让模型决定读哪些页）。
 * 成功截断超长，失败返 {ok:false} 不抛——工具报错会让 agent 纠结，结构化结果让上层
 * 转成文本提示让它自然换路。
 *
 * 分页策略：pages 参数显式指定时读指定页；不传时 ≤ PDF_DEFAULT_PAGE_LIMIT 页读全部，
 * 更大文档只读前 PDF_PREVIEW_PAGES 页（模型先看开头再决定读哪些页，防爆 context）。
 */
export async function parsePdf(buffer: Buffer, opts: PdfReadOptions = {}): Promise<PdfParseResult> {
  let doc;
  try {
    doc = await getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      disableFontFace: true,
    }).promise;
  } catch (err) {
    const { reason, detail } = classifyPdfError(err);
    return { ok: false, reason, detail };
  }

  const totalPages = doc.numPages;

  let readPages: number[];
  if (opts.pages !== undefined && opts.pages !== null && opts.pages.trim() !== "") {
    const parsed = parsePagesSpec(opts.pages, totalPages);
    if (!parsed.ok) return { ok: false, reason: "invalid_arg", detail: parsed.detail };
    readPages = parsed.pages;
  } else if (totalPages <= PDF_DEFAULT_PAGE_LIMIT) {
    readPages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    readPages = Array.from({ length: Math.min(PDF_PREVIEW_PAGES, totalPages) }, (_, i) => i + 1);
  }

  const pageInfos: PdfPageInfo[] = [];
  const pageTexts: string[] = [];
  for (const p of readPages) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = layoutPage(content.items);
    const images = await countImages(page);
    const chars = text.length;
    const scanned = chars === 0;
    pageInfos.push({
      page: p,
      chars,
      images,
      preview: text.slice(0, 80).replace(/\s+/g, " "),
      scanned,
    });
    pageTexts.push(text);
  }

  if (opts.mode === "structure") {
    return { ok: true, mode: "structure", structure: { pageCount: totalPages, pages: pageInfos }, truncated: false };
  }

  const meta: PdfMeta = {
    pages: totalPages,
    readPages: readPages.length,
    images: pageInfos.reduce((s, i) => s + i.images, 0),
    scannedPages: pageInfos.filter((i) => i.scanned).length,
  };

  const full = pageTexts
    .map((t, i) => {
      const info = pageInfos[i];
      const head = `## Page ${info.page}${info.images > 0 ? ` (${info.images} images)` : ""}`;
      if (info.scanned) {
        return `${head}\n[No text layer — this page is likely a scanned image. Use OCR or ask the user for the content.]`;
      }
      return `${head}\n${t}`;
    })
    .join("\n\n");

  if (full.length <= PDF_MAX_CHARS) {
    return { ok: true, mode: "markdown", markdown: full, truncated: false, meta };
  }
  return { ok: true, mode: "markdown", markdown: full.slice(0, PDF_MAX_CHARS), truncated: true, meta };
}
