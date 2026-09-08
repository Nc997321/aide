# 随包字体：Maple Mono NF CN

桌面端随包内置的默认字体，官方 [maple-font](https://github.com/subframe7536/maple-font) v7.9 的
NF-CN 变体（Nerd Font 图标 + 中文，简繁日全覆盖）。核心特性：**中英文宽度严格 2:1**——
一个汉字恰好等于两个英文字母宽，中文注释 / Markdown 表格 / 中英混排天然对齐。

## 事实清单

| 项 | 值 |
|---|---|
| 家族名 | `Maple Mono NF CN`（@font-face、字体内部名、所有默认栈三处必须一致） |
| 字重 | 400（Regular）+ 700（Bold）两枚；500/600 由 CSS 匹配落到 400/700 |
| 体积 | 每枚 woff2 ~6 MB（TTF 19.7 MB 的 31%），共 ~12.1 MB |
| 许可证 | OFL 1.1，随包分发合法；LICENSE 在 `src/assets/fonts/MapleMono-LICENSE.txt` |
| 来源 | 官方 release TTF → fonttools+brotli 转 woff2（npm 无 fontsource 官方 CN 包，第三方包不引——供应链风险） |

## 文件与接线

- `src/assets/fonts/maple-mono-nf-cn-{regular,bold}.woff2` —— Vite 资产，构建时哈希进 `dist/assets/`
- `src/styles/global.css` —— `@font-face` 声明（`font-display: swap`）+ `:root` 首屏兜底变量
- `packages/aide-sdk/src/utils/fonts.ts` —— `MONO_FONT_STACK` / `UI_FONT_STACK` 首位前置该字体
- `src-tauri/src/commands/settings.rs` —— `default_font_family()`（serde 默认，与 SDK 栈保持一致）
- `src-tauri/src/settings/descriptors.rs` —— `settings.fontFamily` descriptor 默认值

## 默认值与迁移

三处设置（界面 / 编辑器 / 终端）默认都指向 `MONO_FONT_STACK`；编辑器/终端未单独设置时
经 `resolveScopedFontFamily` 继承界面字体。UI 正文逻辑（`useSettings` 的
`v === MONO_FONT_STACK ? UI_FONT_STACK : v`）：默认时 `--aide-font-ui` = `UI_FONT_STACK`
（Maple 优先、Inter 兜底），用户显式选字体后 UI 跟随。

**存量用户迁移**：旧默认字面量（含「JetBrains+CJK」栈——曾被 useSettings 的
Persist-the-upgrade 重新落盘）都在 `LEGACY_MONO_DEFAULTS` 里，`resolveFontFamily`
自动迁到新栈。用户通过 FontSelect 显式单选的字体的定形（`'X', CJK 回退`）不在
LEGACY 列表，永不迁移。

## 探测与设置面板

`FontSelect` 用 canvas 宽度测量探测（`@aide/sdk/utils/fonts.isFontInstalled`）。
随包字体经 `@font-face` 注册进 `document.fonts`，canvas 能测到 → 设置面板下拉框
无需系统安装即出现 `Maple Mono NF CN`。注意：@font-face 字体未加载时探测不到
（font-display: swap 下首用即加载，默认栈首屏就引用 → 启动即加载）。

## 更换 / 升级字体的操作

1. 下载新版本官方 release 的 `MapleMono-NF-CN-{Regular,Bold}.ttf`
2. `fontTools` 转码：`TTFont(ttf)` → `font.flavor = "woff2"` → save 到
   `src/assets/fonts/`（家族名/字重用 `font['name'].getDebugName(1)` 核对）
3. 同步更新默认栈字面量（SDK 两常量 + Rust 两处）+ `LEGACY_MONO_DEFAULTS`
   追加旧字面量
4. 全量 vitest + `cargo test --lib settings` + `vite build` 验证 dist 产物