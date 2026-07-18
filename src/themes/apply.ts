import type { ThemeTokens } from "./tokens";

/** camelCase token 名 → --aide-kebab 变量名（colorScheme 除外，见 applyTheme 特判） */
export function cssVarName(key: string): string {
  return `--aide-${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
}

export function applyTheme(tokens: ThemeTokens): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    // colorScheme 不是 --aide-* 变量，而是浏览器原生 `color-scheme` 属性
    if (key === "colorScheme") {
      root.style.setProperty("color-scheme", value);
      continue;
    }
    root.style.setProperty(cssVarName(key), value);
  }
}
