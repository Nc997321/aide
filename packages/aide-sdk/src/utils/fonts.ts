/** 全局等宽字体栈（本地打包，不走 CDN）。
 *  首位是随包内置的 Maple Mono NF CN（global.css @font-face 注册，woff2 由
 *  官方 v7.9 TTF 转码）：中英文严格 2:1 的等宽字体；@font-face 不可用或
 *  尚未加载时 CSS 匹配自动落到后续 JetBrains Mono 等系统字体。
 *  西文等宽字体都没有 CJK 字形，必须在 generic monospace 之前垫中文回退——
 *  否则 Windows/WebView2 会把中文落到宋体；macOS 走 PingFang SC。 */
export const MONO_FONT_STACK = "'Maple Mono NF CN', 'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace";

/** 界面正文默认字体栈（@fontsource-variable/inter 打包，UI 按钮/标签/面板）。
 *  首位随包 Maple Mono NF CN，同上；缺字形（emoji 等）落 Inter/系统 sans。
 *  与 global.css 的 --aide-font-ui 默认值保持一致。 */
export const UI_FONT_STACK = "'Maple Mono NF CN', 'Inter Variable', 'PingFang SC', 'Microsoft YaHei', sans-serif";

const LEGACY_MONO_DEFAULTS = [
  "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  // 上一代默认栈（无 CJK 回退，Windows 中文落宋体）——已持久化此值的老配置一并迁移；
  // 注意这也是 Rust 侧 default_font_family 曾经的返回值
  "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  // 上一代默认栈（带 CJK 回退；useSettings.load 的 Persist-the-upgrade 曾把它
  // 重新落盘为用户自定义）——随包 Maple Mono NF CN 后一并迁移
  "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace",
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

/** 等宽单字体的 CJK 回退尾：西文等宽字体没有 CJK 字形，generic monospace
 *  之前必须垫中文回退——否则 Windows/WebView2 把中文落到宋体（macOS 走
 *  PingFang SC）。FontSelect 选中字体时的存储定形用它收尾。 */
export const CJK_MONO_FALLBACK = "'PingFang SC', 'Microsoft YaHei', monospace";

/** 字体测量原语：给定 CSS font 规格（如 `72px "Maple Mono", monospace`）与探针文本，
 *  返回该文本在当前字体下的排版宽度。DOM 侧用 canvas measureText 适配，
 *  测试注入假实现。 */
export type FontMeasurer = (fontSpec: string, text: string) => number;

/** 探测字体家族在本机是否可用（系统已安装，或 @font-face 已注册且已加载）。
 *  注意：已注册未加载的 @font-face 字体探测不到（canvas 度量走回退链、
 *  与对照同宽返回 false）——font-display: swap 下首用即加载，默认栈首屏
 *  引用 → 启动即加载，该边界只影响未被使用过的注册字体。
 *  原理：把候选放在回退列表首位，与对照 generic 字体比宽度——缺失时回退
 *  落到对照本体、同宽；已装时渲染候选自己的字形、宽度必异。两个对照各兜
 *  一个边界：候选恰好是 generic monospace 本尊（Windows 上 Consolas）时
 *  mono 对照同宽、由 sans 对照判出；候选恰好是 generic sans 本尊（macOS
 *  上 Helvetica 类）反之。不能用 document.fonts.load 探测系统字体：
 *  FontFaceSet 只收录 @font-face 文档字体，系统字体永远返回空。
 *  纯函数：不碰 DOM，measure 由调用方注入。 */
export function isFontInstalled(name: string, measure: FontMeasurer): boolean {
  const probe = "mmmmmmwwww"; // 窄(m)宽(w)字形混合，任何真字体都量得出差异
  return measure(`72px "${name}", sans-serif`, probe) !== measure("72px sans-serif", probe)
    || measure(`72px "${name}", monospace`, probe) !== measure("72px monospace", probe);
}
