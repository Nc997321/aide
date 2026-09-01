import type { ThemeTokens } from "./tokens";

/**
 * Smoky Pink Glass —— 浅色烟灰粉毛玻璃主题。
 * 视觉来源：docs/superpowers/design-previews/aide-light-glassmorphism-smoky-pink.html
 * 项目第一个浅色主题：colorScheme "light"；bg/surface 全部半透（浅色井），
 * 由 ambientScene 的粉色光斑 + surfaceBlur 毛玻璃透出质感。
 */
export const smokyPinkGlass: ThemeTokens = {
  colorScheme: "light",

  // 浅色井：编辑器/终端/diff/输入框底（半透，透出背景光斑）
  bgDeep: "rgba(250,250,252,.55)",
  bgBase: "rgba(243,241,242,.55)",
  bgRaised: "rgba(255,255,255,.62)",
  bgOverlay: "rgba(96,86,94,.28)",

  // 稿 ghost-btn 三态
  surfaceDefault: "rgba(255,255,255,.48)",
  surfaceHover: "rgba(255,255,255,.72)",
  surfaceActive: "rgba(255,255,255,.85)",
  // 浅色主题选中不能用 surface 系（全白、看不见）：用 accent 烟粉的中等透明度，
  // 深文字压在上面仍清晰可读（终端 selectionBackground / 编辑器选区共用）
  selectionBg: "rgba(207,166,160,.38)",

  textPrimary: "#23262d",
  textSecondary: "#5c6470",
  textMuted: "#7b8492",
  textOnAccent: "#674945",

  accent: "#CFA6A0",
  accentHover: "#BE938D",
  accentSubtle: "rgba(207,166,160,.18)",

  success: "#3f9e69",
  warning: "#C98A3D",
  danger: "#dd6b72",
  info: "#7C93B8",
  agentAccent: "#B87F7E",

  // 用量分段色板（dataviz 校验器相邻对口径 ALL PASS，浅色组；对白底 Contrast
  // WARN 由明细可见文字+2px 间隙兜底，见设计稿 §4）
  chart1: "#2a78d6",
  chart2: "#eb6834",
  chart3: "#1baf7a",
  chart4: "#eda100",
  chart5: "#e87ba4",
  chartFallback: "rgba(90,90,105,.24)",
  border: "rgba(124,137,154,.18)",
  borderSubtle: "rgba(124,137,154,.10)",
  borderStrong: "rgba(207,166,160,.42)",
  highlightInset: "inset 0 1px 0 rgba(255,255,255,.9)",
  accentGradient: "linear-gradient(180deg,#E5CBC7,#CFA6A0)",
  accentGlow: "0 9px 20px rgba(160,112,106,.18)",
  accentRing: "0 0 0 2.5px rgba(207,166,160,.35)",
  ambientGlow: "radial-gradient(700px 240px at 50% -60px, rgba(207,166,160,.14), transparent 70%)",

  shadowSm: "0 2px 8px rgba(87,101,120,.08)",
  shadowMd: "0 8px 24px rgba(87,101,120,.1)",
  shadowLg: "0 18px 55px rgba(93,108,128,.16), 0 3px 12px rgba(67,82,102,.06)",
  shadowInset: "inset 0 1px 3px rgba(93,108,128,.16)",

  radiusSm: "8px",
  radiusMd: "12px",
  radiusLg: "18px",

  spaceUnit: "4px",

  ease: "cubic-bezier(.2,.8,.2,1)",
  easeT: ".16s cubic-bezier(.2,.8,.2,1)",
  surfaceBlur: "blur(26px) saturate(135%)",
  // 稿 body 背景整组：三层光斑 + 线性渐变实底兜底
  ambientScene:
    "radial-gradient(circle at 8% 0%, rgba(255,255,255,.96) 0 17%, transparent 42%), radial-gradient(circle at 100% 0%, rgba(225,196,192,.28) 0 15%, transparent 38%), radial-gradient(circle at 72% 100%, rgba(207,166,160,.18) 0 18%, transparent 42%), linear-gradient(135deg, #faf9fa 0%, #f2eff1 46%, #f8f3f2 100%)",

  // 状态机六态在浅底的配色纪律：running 绿(success) / waiting 灰蓝(info) /
  // attention 琥珀(warning) / stalled 赤陶(独立于 warning，两态不能撞色) /
  // warning 红(danger) / stopped 空心灰圈。stalled 语义介于「注意」与「错误」
  // 之间，取带粉调的赤陶橙，既融入烟粉色系又与琥珀 warning 一眼可辨。
  stalled: "#D1795E",
  syntaxKeyword: "#A77872",
  syntaxNumber: "#6D7FB8",
};
