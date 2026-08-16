/** 全局等宽字体栈（本地 @fontsource 打包，不走 CDN）。
 *  西文等宽字体都没有 CJK 字形，必须在 generic monospace 之前垫中文回退——
 *  否则 Windows/WebView2 会把中文落到宋体；macOS 走 PingFang SC。 */
export const MONO_FONT_STACK = "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace";

/** 界面正文默认字体栈（@fontsource-variable/inter 打包，UI 按钮/标签/面板）。
 *  与 global.css 的 --aide-font-ui 默认值保持一致。 */
export const UI_FONT_STACK = "'Inter Variable', 'PingFang SC', 'Microsoft YaHei', sans-serif";

const LEGACY_MONO_DEFAULTS = [
  "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  // 上一代默认栈（无 CJK 回退，Windows 中文落宋体）——已持久化此值的老配置一并迁移；
  // 注意这也是 Rust 侧 default_font_family 曾经的返回值
  "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
];

/** 读取持久化 fontFamily：未设置或仍是历任默认字面量 → 新默认；用户自定义 → 保留 */
export function resolveFontFamily(stored: string | null | undefined): string {
  if (!stored || LEGACY_MONO_DEFAULTS.includes(stored)) return MONO_FONT_STACK;
  return stored;
}

/** 读取编辑器/终端字体：新字段未设置（空）→ 回退界面字体（fontFamily）→ 默认栈。
 *  老用户只设过 fontFamily 时，编辑器/终端自动继承同一字体，零迁移。 */
export function resolveScopedFontFamily(
  stored: string | null | undefined,
  uiFont: string,
): string {
  if (!stored) return uiFont || MONO_FONT_STACK;
  return resolveFontFamily(stored);
}
