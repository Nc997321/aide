/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  // 配色不在这里定义——所有颜色走主题系统：src/themes/ 的语义 token（ThemeTokens），
  // 由 apply.ts 写成 :root 上的 --aide-* CSS 变量，组件用 var(--aide-*) 消费。
  // 切换主题（warm-dark / catppuccin）时所有 var(--aide-*) 自动重配色。
  // 禁止在此处硬编码颜色工具类——曾有一套 Catppuccin 字面量（bg-bg-primary / text-accent / bg-surface 等），
  // 编译期写死、切主题不变，且全仓零引用，已移除。需要新语义色就往 ThemeTokens 加槽位。
  theme: {
    extend: {},
  },
  plugins: [],
}