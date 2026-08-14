import { isAbsolute, join } from "node:path";
import { DOCX_MAX_CHARS, DOCX_MAX_BYTES } from "./constants.js";
export { DOCX_MAX_CHARS, DOCX_MAX_BYTES } from "./constants.js";
import { parseDocxToModel, DocxParseError } from "./parse/index.js";
import { modelToMarkdown } from "./md/toMarkdown.js";
import { docxToStructure, type DocxStructure } from "./structure.js";

export type DocxErrorReason = "not_found" | "not_docx" | "encrypted" | "too_large" | "unknown";

/** 元信息：正文统计（structure 模式自带统计，markdown 模式用 meta 补充） */
export interface DocxMeta {
  paragraphs: number;
  images: number;
  tables: number;
  sections: number;
}

export type DocxParseResult =
  | { ok: true; mode: "markdown"; markdown: string; truncated: boolean; meta: DocxMeta }
  | { ok: true; mode: "structure"; structure: DocxStructure; truncated: boolean }
  | { ok: false; reason: DocxErrorReason; detail: string };

export interface DocxReadOptions {
  /** 输出模式：markdown（默认，格式干净的 markdown 流）| structure（IR JSON 视图） */
  mode?: "markdown" | "structure";
  /** 图片策略：placeholder（默认，占位符 + 图片清单）| skip（跳过）| base64（内嵌字节） */
  images?: "placeholder" | "skip" | "base64";
}

/**
 * 把 jszip 抛的错误归类成结构化原因。纯函数，无 IO。
 * parseDocx 的 catch 分支与测试共用——not_found / too_large 是 handler 层（statSync/
 * readFileSync）产生，不经过这里。
 */
export function classifyDocxError(err: unknown): {
  reason: Exclude<DocxErrorReason, "not_found" | "too_large">;
  detail: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // jszip 打不开 zip：非 docx / 损坏 / 老式 .doc（.doc 不是 zip）
  if (
    lower.includes("end of central directory") ||
    lower.includes("not a zip") ||
    lower.includes("invalid zip")
  ) {
    return { reason: "not_docx", detail: msg || "file is not a valid .docx (zip archive expected)" };
  }
  // 加密文档：jszip 抛 "encrypted entry"
  if (lower.includes("encrypted") || lower.includes("password")) {
    return { reason: "encrypted", detail: msg || "document is password-protected" };
  }
  return { reason: "unknown", detail: msg || "failed to parse the document" };
}

/**
 * 解析 .docx buffer。默认输出 markdown 流（基于 IR 生成，格式干净），
 * mode: "structure" 输出 IR 的 JSON 视图。成功截断超长，失败返 {ok:false} 不抛——
 * 工具报错会让 agent 纠结，结构化结果让上层 formatDocxResult 转成文本提示让它自然换路。
 * 只处理 .docx（Word 2007+）；老式 .doc / .pdf / .xlsx 交给调用方在工具层提示。
 */
export async function parseDocx(buffer: Buffer, opts: DocxReadOptions = {}): Promise<DocxParseResult> {
  let doc;
  try {
    doc = await parseDocxToModel(buffer);
  } catch (err) {
    if (err instanceof DocxParseError) {
      return { ok: false, reason: err.reason, detail: err.message };
    }
    const { reason, detail } = classifyDocxError(err);
    return { ok: false, reason, detail };
  }

  // structure 是紧凑 JSON（标题/域/统计清单），远小于 DOCX_MAX_CHARS，不截断
  if (opts.mode === "structure") {
    return { ok: true, mode: "structure", structure: docxToStructure(doc), truncated: false };
  }

  const full = modelToMarkdown(doc, { images: opts.images ?? "placeholder" });
  const s = docxToStructure(doc); // 一次遍历拿统计（markdown 模式 meta）
  const meta: DocxMeta = {
    paragraphs: s.paragraphs,
    images: s.images,
    tables: s.tables,
    sections: s.sections,
  };
  if (full.length <= DOCX_MAX_CHARS) {
    return { ok: true, mode: "markdown", markdown: full, truncated: false, meta };
  }
  return { ok: true, mode: "markdown", markdown: full.slice(0, DOCX_MAX_CHARS), truncated: true, meta };
}

/**
 * 把模型给的 file_path 解析成可读路径。纯函数，无 IO。
 * - 非字符串/空 → invalid_arg
 * - verbatim `\\?\` 前缀（Windows 扩展长度路径，Tauri resource_dir 常带，见 CLAUDE.md
 *   dunce 坑）→ 原样透传，不 normalize/join（否则破坏前缀语义）
 * - 绝对路径 → 直用
 * - 相对路径 → 对 cwd join（跨平台用 node:path）
 */
export function resolveDocxPath(
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
