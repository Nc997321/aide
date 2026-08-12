import { isAbsolute, join } from "node:path";
import * as mammothNs from "mammoth";

/**
 * mammoth 1.12.1 在 lib/index.js 导出 `convertToMarkdown`（运行时存在，line 13/26），
 * 但自带的 lib/index.d.ts 漏声明（只列了 convertToHtml/extractRawText/embedStyleMap/
 * images 四个）。这里局部收窄类型，不污染全局、不 fork 一份 .d.ts。
 */
type MammothMarkdown = typeof mammothNs & {
  convertToMarkdown(input: { buffer: Buffer } | { path: string }): Promise<{
    value: string;
    messages: Array<{ type: string; message: string; error?: unknown }>;
  }>;
};
const mammoth = mammothNs as MammothMarkdown;

/** 单次解析返回的字符上限。超出截断并置 truncated:true，避免爆 agent context。 */
export const DOCX_MAX_CHARS = 60_000;

/** statSync 守卫：超过此字节的 .docx 不读进内存（OOM/慢），handler 层用。 */
export const DOCX_MAX_BYTES = 50 * 1024 * 1024;

export type DocxErrorReason = "not_found" | "not_docx" | "encrypted" | "too_large" | "unknown";

export type DocxParseResult =
  | { ok: true; markdown: string; truncated: boolean; messages: unknown[] }
  | { ok: false; reason: DocxErrorReason; detail: string };

/**
 * 把 mammoth/jszip 抛的错误归类成结构化原因。纯函数，无 IO。
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
  // 加密文档：jszip 抛 "encrypted entry"，mammoth 报 password
  if (lower.includes("encrypted") || lower.includes("password")) {
    return { reason: "encrypted", detail: msg || "document is password-protected" };
  }
  return { reason: "unknown", detail: msg || "mammoth failed to parse the document" };
}

/**
 * 解析 .docx buffer 为 markdown。成功截断超长，失败返 {ok:false} 不抛——工具报错会让
 * agent 纠结，结构化结果让上层 formatDocxResult 转成文本提示让它自然换路。只处理
 * .docx（Word 2007+）；老式 .doc / .pdf / .xlsx 交给调用方在工具层提示。
 */
export async function parseDocx(buffer: Buffer): Promise<DocxParseResult> {
  try {
    const result = await mammoth.convertToMarkdown({ buffer });
    const full = result.value ?? "";
    if (full.length <= DOCX_MAX_CHARS) {
      return { ok: true, markdown: full, truncated: false, messages: result.messages ?? [] };
    }
    return {
      ok: true,
      markdown: full.slice(0, DOCX_MAX_CHARS),
      truncated: true,
      messages: result.messages ?? [],
    };
  } catch (err) {
    const { reason, detail } = classifyDocxError(err);
    return { ok: false, reason, detail };
  }
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