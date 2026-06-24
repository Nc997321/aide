export type { ThemeTokens } from "./tokens";
export { warmDark } from "./warm-dark";
export { catppuccin } from "./catppuccin";
export { applyTheme } from "./apply";

import type { ThemeTokens } from "./tokens";
import { warmDark } from "./warm-dark";
import { catppuccin } from "./catppuccin";

export const themes: Record<string, ThemeTokens> = {
  "warm-dark": warmDark,
  catppuccin,
};
