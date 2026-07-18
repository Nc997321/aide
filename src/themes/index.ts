export type { ThemeTokens } from "./tokens";
export { warmDark } from "./warm-dark";
export { catppuccin } from "./catppuccin";
export { glass } from "./glass";
export { applyTheme } from "./apply";

import type { ThemeTokens } from "./tokens";
import { warmDark } from "./warm-dark";
import { catppuccin } from "./catppuccin";
import { glass } from "./glass";

export const themes: Record<string, ThemeTokens> = {
  "warm-dark": warmDark,
  catppuccin,
  glass,
};
