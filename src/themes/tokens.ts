export interface ThemeTokens {
  /** 浏览器原生表单控件（复选框/单选框/未显式主题化的 input/滚动条角等）
   *  的渲染模式。暗色主题给 "dark"，亮色主题给 "light"。applyTheme 会把它
   *  写成 `color-scheme` 属性（不是 --aide-* 变量），让原生控件跟随主题明暗，
   *  否则未勾选复选框等会按默认 light 模式渲染出白底。 */
  colorScheme: "light" | "dark";

  bgDeep: string;
  bgBase: string;
  bgRaised: string;
  bgOverlay: string;

  surfaceDefault: string;
  surfaceHover: string;
  surfaceActive: string;

  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnAccent: string;

  accent: string;
  accentHover: string;
  accentSubtle: string;

  success: string;
  warning: string;
  danger: string;
  info: string;

  border: string;
  borderSubtle: string;

  shadowSm: string;
  shadowMd: string;
  shadowLg: string;

  radiusSm: string;
  radiusMd: string;
  radiusLg: string;

  spaceUnit: string;

  stalled: string;
  syntaxKeyword: string;
  syntaxNumber: string;
}
