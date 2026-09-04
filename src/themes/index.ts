export type { ThemeTokens } from "./tokens";
export { warmDark } from "./warm-dark";
export { glass } from "./glass";
export { smokyPinkGlass } from "./smoky-pink-glass";
export { applyTheme } from "./apply";

import type { ThemeTokens } from "./tokens";
import { warmDark } from "./warm-dark";
import { glass } from "./glass";
import { smokyPinkGlass } from "./smoky-pink-glass";

export const themes: Record<string, ThemeTokens> = {
  "warm-dark": warmDark,
  glass,
  "smoky-pink-glass": smokyPinkGlass,
};
