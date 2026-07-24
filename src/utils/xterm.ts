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
 *  CSS var cascade doesn't reach canvas.
 *  @param _unused_tokens — kept for API compatibility; function reads CSS vars directly. */
export function buildXtermTheme(_unused_tokens?: ThemeTokens) {
  return {
    background: cssVar("bg-deep") || "#141218",
    foreground: cssVar("text-primary") || "#ece5db",
    cursor: cssVar("accent") || "#d9ab78",
    selectionBackground: cssVar("surface-active") || "#3d3848",
    black: cssVar("surface-hover") || "#322e3c",
    red: cssVar("danger") || "#e87070",
    green: cssVar("success") || "#8bc48a",
    yellow: cssVar("warning") || "#e8c374",
    blue: cssVar("accent") || "#d9ab78",
    magenta: cssVar("syntax-keyword") || "#b09bc8",
    cyan: cssVar("info") || "#7eb8d8",
    white: cssVar("text-secondary") || "#b3aa9c",
    brightBlack: cssVar("text-muted") || "#7d7568",
    brightRed: cssVar("danger") || "#e87070",
    brightGreen: cssVar("success") || "#8bc48a",
    brightYellow: cssVar("warning") || "#e8c374",
    brightBlue: cssVar("accent-hover") || "#e6bd8e",
    brightMagenta: cssVar("syntax-keyword") || "#b09bc8",
    brightCyan: cssVar("info") || "#7eb8d8",
    brightWhite: cssVar("text-primary") || "#ece5db",
  };
}
