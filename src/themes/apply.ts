import type { ThemeTokens } from "./tokens";

export function applyTheme(tokens: ThemeTokens): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    // colorScheme 不是 --aide-* 变量，而是浏览器原生 `color-scheme` 属性——
    // 它决定原生表单控件按 light/dark 渲染。单独写，不转成 CSS 变量。
    if (key === "colorScheme") {
      root.style.setProperty("color-scheme", value);
      continue;
    }
    const cssVar = `--aide-${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
    root.style.setProperty(cssVar, value);
  }
}
