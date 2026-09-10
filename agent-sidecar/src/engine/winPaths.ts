// Windows 路径 bun 运行时兼容兜底（共享真相源）。
//
// ⚠️ bun 运行时兼容（bun build --compile 编译的 aide-agent.exe 内嵌 bun 的 node:path/fs，
// 实测 bun 1.3.14 与 Node 有三处行为差异，凡在 aide-agent.exe 里对 Windows 路径做
// path.dirname / fs.mkdirSync 的地方都要用本文件的兜底规避）：
//   1. path.isAbsolute('C:\\Users\\...')（反斜杠盘符绝对路径）返回 false → 会被 join 进 cwd
//   2. path.dirname('C:\\Users\\...\\a.docx') 返回 "C:"（正确应为父目录）
//   3. fs.mkdirSync(p, { recursive: true }) 对「已存在目录」抛 EEXIST（Node 是 no-op）
//   反斜杠路径三个全踩；正斜杠路径行为与 Node 一致 → 非 verbatim 路径统一 normalize 正斜杠，
//   verbatim `\\?\` 前缀不能动（破坏前缀语义），取父目录用手动 safeDirname 兜底。
//
// 使用方：docx/path.ts（resolveDocxPath）、winBashEnv.ts（bashrc 落地）、
// codegraphSkill.ts（skill 落地）。新增任何在 aide-agent.exe 里拼 Windows 配置路径 +
// mkdirSync 的地方都应 import 这里，勿直接用 path.dirname（中文用户目录叠加缺陷必崩）。

/** Windows 盘符绝对路径（`C:\` 或 `C:/`）——bun 的 isAbsolute 对反斜杠盘符路径误判 false 的兜底 */
export const WIN_DRIVE_ABS = /^[a-zA-Z]:[\\/]/;

/** 反斜杠统一正斜杠（Windows fs API 均接受正斜杠；bun 的 path/fs 对正斜杠路径行为与 Node 一致） */
export function toForwardSlashes(p: string): string {
  return p.includes("\\") ? p.replace(/\\/g, "/") : p;
}

/** 取父目录：bun 的 path.dirname 对 Windows 反斜杠路径返回 "C:"（实测 bun 1.3.14）——
 * verbatim `\\?\` 路径不能 normalize（会破坏前缀语义），取父目录用手动实现兜底。 */
export function safeDirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return ".";
  return p.slice(0, idx);
}