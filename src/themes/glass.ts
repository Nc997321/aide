import type { ThemeTokens } from "./tokens";

export const glass: ThemeTokens = {
  colorScheme: "dark",

  bgDeep: "rgba(8,10,16,.82)",
  bgBase: "rgba(17,19,29,.52)",
  bgRaised: "rgba(24,26,38,.48)",
  bgOverlay: "rgba(8,10,16,.55)",

  surfaceDefault: "rgba(255,255,255,.06)",
  surfaceHover: "rgba(255,255,255,.1)",
  surfaceActive: "rgba(255,255,255,.14)",
  selectionBg: "rgba(255,255,255,.14)",

  textPrimary: "#eef0f8",
  textSecondary: "#b9bdd0",
  textMuted: "#7c8296",
  textOnAccent: "#eef0ff",

  accent: "#a5b8ff",
  accentHover: "#bcc9ff",
  accentSubtle: "rgba(150,170,255,.16)",

  success: "#6ee7a8",
  warning: "#fcd34d",
  danger: "#f87171",
  info: "#7dd3fc",
  agentAccent: "#e0a3d8",

  // 用量分段色板（dataviz 校验器相邻对口径 ALL PASS，对 bgDeep≈#0a0c12 验光）
  chart1: "#3987e5",
  chart2: "#d95926",
  chart3: "#199e70",
  chart4: "#c98500",
  chart5: "#d55181",
  chartFallback: "rgba(255,255,255,.28)",

  border: "rgba(255,255,255,.1)",
  borderSubtle: "rgba(255,255,255,.06)",
  borderStrong: "rgba(255,255,255,.17)",
  highlightInset: "inset 0 1px 0 rgba(255,255,255,.12)",
  accentGradient: "linear-gradient(180deg, rgba(160,180,255,.42), rgba(130,150,255,.3))",
  accentGlow: "0 4px 18px rgba(140,160,255,.38)",
  accentRing: "0 0 0 2.5px rgba(150,170,255,.42)",
  ambientGlow: "radial-gradient(700px 240px at 50% -60px, rgba(150,170,255,.12), transparent 70%)",

  shadowSm: "0 1px 2px rgba(0,0,0,.3)",
  shadowMd: "0 8px 24px rgba(0,0,0,.38)",
  shadowLg: "0 20px 60px rgba(0,0,0,.55)",
  shadowInset: "inset 0 1px 3px rgba(0,0,0,.3)",

  radiusSm: "8px",
  radiusMd: "10px",
  radiusLg: "14px",

  spaceUnit: "4px",

  ease: "cubic-bezier(.2,.8,.2,1)",
  easeT: ".16s cubic-bezier(.2,.8,.2,1)",
  surfaceBlur: "blur(20px) saturate(150%)",
  ambientScene:
    "radial-gradient(560px 380px at 10% -8%, rgba(124,108,255,.32), transparent 65%), radial-gradient(520px 420px at 96% 6%, rgba(64,190,220,.22), transparent 65%), radial-gradient(640px 340px at 60% 112%, rgba(210,110,190,.16), transparent 70%), #0a0b11",

  syntaxKeyword: "#c3b3f7",
  syntaxNumber: "#f0b08c",
};
