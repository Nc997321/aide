// PDF 路径解析：与 docx 完全同语义（bun 兼容实现，含 Windows 盘符绝对路径兜底），
// 直接复用 docx/path.ts，不重复实现。见 docx/path.ts 的 bun 三缺陷注释。

export { resolveDocxPath as resolvePdfPath } from "../docx/path.js";
