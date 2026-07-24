import type { ThemeTokens } from "../themes/tokens";

/** Read a --aide-* CSS var from the document root. Falls back to the raw string
 *  if the var is not set (should never happen at runtime). */
export function cssVar(name: string): string {
  try {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue(`--aide-${name}`)
      .trim();
    return val || "";
  } catch {
    return "";
  }
}

/** Build an xterm ITheme from active CSS custom properties (--aide-*).
 *  Call this at terminal creation AND on theme switch.
 *  xterm is canvas-rendered, so it must be explicitly re-applied —
 *  CSS var cascade doesn't reach canvas. 所有 --aide-* 变量在 global.css
 *  :root 有恒在兜底，cssVar 运行时不应为空，故不再挂暗色 hex fallback。
 *  @param _unused_tokens — kept for API compatibility; function reads CSS vars directly. */
export function buildXtermTheme(_unused_tokens?: ThemeTokens) {
  return {
    background: cssVar("bg-deep"),
    foreground: cssVar("text-primary"),
    cursor: cssVar("accent"),
    selectionBackground: cssVar("surface-active"),
    black: cssVar("surface-hover"),
    red: cssVar("danger"),
    green: cssVar("success"),
    yellow: cssVar("warning"),
    blue: cssVar("accent"),
    magenta: cssVar("syntax-keyword"),
    cyan: cssVar("info"),
    white: cssVar("text-secondary"),
    brightBlack: cssVar("text-muted"),
    brightRed: cssVar("danger"),
    brightGreen: cssVar("success"),
    brightYellow: cssVar("warning"),
    brightBlue: cssVar("accent-hover"),
    brightMagenta: cssVar("syntax-keyword"),
    brightCyan: cssVar("info"),
    brightWhite: cssVar("text-primary"),
  };
}
