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

  /** 文本选中底色（终端 selectionBackground / CodeMirror cm-selectionBackground 共用）。
   *  暗色主题给中性灰阶（≈surfaceActive 档）；浅色主题 surface 系是白色，选中会
   *  白到看不见，必须改用 accent 色系的中等透明度粉/彩色。 */
  selectionBg: string;

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

  /** 用量分段色板（上下文用量弹层的分段条/明细 dot）：chart1~5 按固定顺序映射
   *  稳定分类（系统提示/工具/消息/MCP/技能），颜色跟着实体走不跟位置——类别
   *  缺席不重排不换色；未知名/溢出落 chartFallback（中性色）。改值必须重跑
   *  dataviz 色板校验器（相邻对口径 + 2px 间隙二次编码，对该主题的 bgDeep
   *  合成底验光），不许裸眼定色。2026-09-01 种子值见
   *  docs/superpowers/specs/2026-09-01-context-usage-panel-design.md §4 */
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  /** 分类色板兜底：provider 报了未知名/超出 5 类时的中性段 */
  chartFallback: string;

  /** 聊天域「代理活动」装饰色：思考块竖线 / 子代理卡（左边条+类型 pill+嵌套虚线）/
   *  后台运行徽章 / 用量徽章↓输入。与 info 分槽——info 是功能色（toast/git 徽章/
   *  通知/文件图标），保持语义蓝；agentAccent 是纯装饰色，跟主题气质走
   *  （暖铜主题给柔铜、烟粉主题给玫瑰），2026-08-09 选色原型见
   *  docs/superpowers/design-previews/2026-08-09-chat-agent-accent.html */
  agentAccent: string;

  border: string;
  borderSubtle: string;

  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  /** 井口/输入框内侧顶部阴影（inset）；暗色主题给黑色系，浅色主题给灰蓝系 */
  shadowInset: string;

  radiusSm: string;
  radiusMd: string;
  radiusLg: string;

  spaceUnit: string;

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
