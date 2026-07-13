import type { ThemeTokens } from "../themes/tokens";

/** Build an xterm ITheme from a ThemeTokens object.
 *  Call this at terminal creation AND on theme switch (xterm is canvas-rendered,
 *  so it must be explicitly re-applied — CSS var cascade doesn't reach canvas). */
export function buildXtermTheme(tokens: ThemeTokens) {
  return {
    background: tokens.bgBase,
    foreground: tokens.textPrimary,
    cursor: tokens.accent,
    selectionBackground: tokens.surfaceActive,
    black: tokens.surfaceHover,
    red: tokens.danger,
    green: tokens.success,
    yellow: tokens.warning,
    blue: tokens.accent,
    magenta: tokens.syntaxKeyword,
    cyan: tokens.info,
    white: tokens.textSecondary,
    brightBlack: tokens.textMuted,
    brightRed: tokens.danger,
    brightGreen: tokens.success,
    brightYellow: tokens.warning,
    brightBlue: tokens.accentHover,
    brightMagenta: tokens.syntaxKeyword,
    brightCyan: tokens.info,
    brightWhite: tokens.textPrimary,
  };
}
