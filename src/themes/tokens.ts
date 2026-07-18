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

  /** 浮起表面顶部 1px 受光（按钮/卡片/菜单/模态共用） */
  highlightInset: string;
  /** 主按钮/开关/选中条的渐变强调 */
  accentGradient: string;
  /** 主按钮与关键焦点的彩色辉光投影 */
  accentGlow: string;
  /** 输入框/焦点环 */
  accentRing: string;
  /** 对话区顶部环境光晕（空间主光源） */
  ambientGlow: string;
  /** 悬停/浮层用第三档边框 */
  borderStrong: string;
  /** 统一动效曲线 */
  ease: string;
  /** 时长+曲线快捷写法 */
  easeT: string;
  /** 后门：面板背景模糊；普通主题 "none"，玻璃主题给 blur() */
  surfaceBlur: string;
  /** 后门：应用根层环境场景图（画在面板后面）；普通主题 "none" */
  ambientScene: string;
}
