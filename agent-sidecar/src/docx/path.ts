// 路径解析工具（read/write 共用）。与 parse.ts 的 resolveDocxPath 同语义，但独立成文件
// 供 md 层（图片相对路径）与 docxTools 层（输出路径）复用，避免 gen.ts 退役后无处安放。

import { isAbsolute, join } from "node:path";

/**
 * 把模型给的输出路径解析成可写路径。纯函数，无 IO。
 * - 非字符串/空 → invalid_arg
 * - verbatim `\\?\` 前缀（Windows 扩展长度路径，Tauri resource_dir 常带，见 CLAUDE.md
 *   dunce 坑）→ 原样透传，不 normalize/join（否则破坏前缀语义）
 * - 绝对路径 → 直用
 * - 相对路径 → 对 cwd join（跨平台用 node:path）
 * 不查盘——exists/not_a_directory 是 handler 层职责。
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
