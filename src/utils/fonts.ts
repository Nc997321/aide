/** 全局等宽字体栈（本地 @fontsource 打包，不走 CDN）。
 *  西文等宽字体都没有 CJK 字形，必须在 generic monospace 之前垫中文回退——
 *  否则 Windows/WebView2 会把中文落到宋体；macOS 走 PingFang SC。 */
export const MONO_FONT_STACK = "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace";

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
