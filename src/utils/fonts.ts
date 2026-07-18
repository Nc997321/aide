/** 全局等宽字体栈（本地 @fontsource 打包，不走 CDN） */
export const MONO_FONT_STACK = "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace";

const LEGACY_MONO_DEFAULT = "'Cascadia Code', 'Fira Code', 'Consolas', monospace";

/** 读取持久化 fontFamily：未设置或仍是旧默认字面量 → 新默认；用户自定义 → 保留 */
export function resolveFontFamily(stored: string | null | undefined): string {
  if (!stored || stored === LEGACY_MONO_DEFAULT) return MONO_FONT_STACK;
  return stored;
}
