// 路径解析工具（read/write 共用）。与 parse.ts 的 resolveDocxPath 同语义，但独立成文件
// 供 md 层（图片相对路径）与 docxTools 层（输出路径）复用，避免 gen.ts 退役后无处安放。
//
// ⚠️ bun 运行时兼容（bun build --compile 编译的 aide-agent.exe 内嵌 bun 的 node:path/fs，
// 实测 bun 1.3.14 与 Node 有三处行为差异，本文件 + docxTools 的 mkdir 全部规避）：
//   1. path.isAbsolute('C:\\Users\\...')（反斜杠盘符绝对路径）返回 false → 会被 join 进 cwd
//   2. path.dirname('C:\\Users\\...\\a.docx') 返回 "C:"（正确应为父目录）
//   3. fs.mkdirSync(p, { recursive: true }) 对「已存在目录」抛 EEXIST（Node 是 no-op）
//   反斜杠路径三个全踩；正斜杠路径行为与 Node 一致 → 非 verbatim 路径统一 normalize 正斜杠，
//   verbatim `\\?\` 前缀不能动（破坏前缀语义），取父目录用手动 safeDirname 兜底。

import { isAbsolute, join } from "node:path";
// bun 反斜杠兜底（toForwardSlashes / safeDirname / WIN_DRIVE_ABS）抽到共享 winPaths，
// 供 docx + winBashEnv 复用，单一真相源。bun 1.3.14 三缺陷见 winPaths 注释。
import {
  toForwardSlashes,
  safeDirname,
  WIN_DRIVE_ABS,
} from "../../engine/winPaths.js";

// re-export：docxTools.ts / path.test.ts 仍从 ./docx/path 引 safeDirname，保持不破。
export { safeDirname };

/**
 * 把模型给的路径解析成可写路径。纯函数，无 IO。
 * - 非字符串/空 → invalid_arg
 * - verbatim `\\?\` 前缀（Windows 扩展长度路径，Tauri resource_dir 常带，见 CLAUDE.md
 *   dunce 坑）→ 原样透传，不 normalize/join（否则破坏前缀语义）
 * - 绝对路径（含 Windows 盘符，isAbsolute 有 bun 兼容兜底）→ 直用（normalize 正斜杠）
 * - 相对路径 → 对 cwd join（跨平台用 node:path，join 结果 normalize 正斜杠）
 * 不查盘——exists/not_a_directory 是 handler 层职责。
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
  // join 的 cwd 也要先 normalize：bun 的 join 对反斜杠 cwd 会把 `C:\work` 解析成 `C:work`（实测 bun 1.3.14）
  const p = isAbsolute(trimmed) || WIN_DRIVE_ABS.test(trimmed) ? trimmed : join(toForwardSlashes(cwd), trimmed);
  return { ok: true, path: toForwardSlashes(p) };
}

/** write 侧别名（docxTools 的 import 名保持稳定，read/write 共用同一实现） */
export const resolveDocxOutPath = resolveDocxPath;
