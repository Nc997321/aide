import type { ThemeTokens } from "./tokens";

export const catppuccin: ThemeTokens = {
  colorScheme: "dark",

  bgDeep:    "#11111b",
  bgBase:    "#1e1e2e",
  bgRaised:  "#313244",
  bgOverlay: "rgba(17, 17, 27, 0.75)",

  surfaceDefault: "#313244",
  surfaceHover:   "#45475a",
  surfaceActive:  "#585b70",
  selectionBg:    "#585b70",

  textPrimary:   "#cdd6f4",
  textSecondary: "#a6adc8",
  textMuted:     "#6c7086",
  textOnAccent:  "#1e1e2e",

  accent:       "#89b4fa",
  accentHover:  "#b4d0fb",
  accentSubtle: "rgba(137, 180, 250, 0.12)",

  success: "#a6e3a1",
  warning: "#f9e2af",
  danger:  "#f38ba8",
  info:    "#89dceb",
  agentAccent: "#89dceb",

  border:       "rgba(255, 255, 255, 0.06)",
  borderSubtle: "rgba(255, 255, 255, 0.03)",
  borderStrong: "rgba(255,255,255,.14)",
  highlightInset: "inset 0 1px 0 rgba(255,255,255,.06)",
  accentGradient: "linear-gradient(180deg,#a3c0fb,#89b4fa)",
  accentGlow: "0 6px 20px rgba(137,180,250,.30)",
  accentRing: "0 0 0 2.5px rgba(137,180,250,.34)",
  ambientGlow: "radial-gradient(700px 240px at 50% -60px, rgba(137,180,250,.08), transparent 70%)",

  shadowSm: "0 1px 3px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2)",
  shadowLg: "0 12px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25)",
  shadowInset: "inset 0 1px 3px rgba(0,0,0,.3)",

  radiusSm: "4px",
  radiusMd: "8px",
  radiusLg: "12px",

  spaceUnit: "4px",

  ease: "cubic-bezier(.2,.8,.2,1)",
  easeT: ".16s cubic-bezier(.2,.8,.2,1)",
  surfaceBlur: "none",
  ambientScene: "none",

  stalled:       "#fab387",
  syntaxKeyword: "#cba6f7",
  syntaxNumber:  "#fab387",
};
