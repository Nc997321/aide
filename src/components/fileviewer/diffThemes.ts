import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * merge/diff 配色主题（@codemirror/merge）。2026-08 A/B 原型收敛为「克制系」
 * 单套方案；落选的「饱和左色条主导」变体见 git 历史。
 *
 * 设计语言（高端 diff 共通的三层同色相结构）：
 *   行底 tint（弱，去饱和）→ 行内变更段（同色相 ~3 倍强度）→ gutter 色条
 *   （面积最小，强度最高但也只有 55%）。琥珀 warning 不参与 diff——
 *   压绿/红底会发浑，且全场只允许绿/红两个色相。
 *
 * 配色纪律：全部从既有 token 现场派生（color-mix），不加 ThemeTokens 槽位——
 * 原料是 oklch 空间向 text-muted 降饱和后的 success/danger，任何主题
 * （含浅色 smoky-pink-glass）自动协调，新主题零适配成本。
 *
 * 类名读 node_modules/@codemirror/merge/dist/index.js 源码确认：
 *   变更行 .cm-changedLine；行内变更段 .cm-changedText；
 *   unified：新增行 .cm-insertedLine(<ins>)、删除行 .cm-deletedLine(<del>)、
 *   删除块 widget .cm-deletedChunk（内文 .cm-deletedText）、行内变更行
 *   .cm-inlineChangedLine；折叠条 .cm-collapsedLines；gutter 标记
 *   .cm-changedLineGutter / .cm-deletedLineGutter / .cm-inlineChangedLineGutter；
 *   编辑器根 a 侧带 .cm-merge-a、b 侧带 .cm-merge-b（unified 根两侧类名都没有，
 *   不限定侧的规则即作用于 unified）。
 * { dark: true } 必传：让包自带 &dark 默认值生效，再由下方规则精修。
 * 包 baseTheme 对 changedText/deletedText 用 background 简写画了 2px 渐变
 * 下划线——只覆盖 backgroundColor 盖不掉它，必须显式 backgroundImage: "none"。
 * 颜色全部是 var(--aide-*) 引用：主题切换改写 :root 变量即自动生效，
 * 无需像语法高亮那样 reconfigure。
 */

// ── 调色助手 ──
const ADD = "var(--aide-success)";
const DEL = "var(--aide-danger)";

/** color 以 pct% 不透明度叠到行底色上 */
const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;
/** oklch 空间向 muted 灰降饱和（霓虹 token 大面积平涂显廉价） */
const soft = (color: string) =>
  `color-mix(in oklch, ${color} 68%, var(--aide-text-muted))`;

const addSoft = soft(ADD);
const delSoft = soft(DEL);

// 原型期 localStorage 残留键清理（A/B 切换器已随收敛移除）
localStorage.removeItem("aide.diff-variant-proto");

export function createDiffTheme(): Extension {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--aide-bg-deep)",
        color: "var(--aide-text-primary)",
        fontSize: "var(--cm-font-size)",
        fontFamily: "var(--cm-font-family)",
        height: "100%",
      },
      // base 主题在 .cm-scroller 硬设 monospace 会盖掉 & 的 var(--cm-font-family)
      // 继承；同名选择器覆盖（用户主题优先级高于 baseTheme）。
      ".cm-scroller": { overflow: "auto", fontFamily: "var(--cm-font-family)" },
      ".cm-gutters": {
        backgroundColor: "var(--aide-bg-deep)",
        color: "var(--aide-text-muted)",
        borderRight: "1px solid var(--aide-border-subtle)",
      },
      ".cm-insertedLine, .cm-deletedLine, .cm-deletedLine del": {
        textDecoration: "none",
      },

      // ── 三层结构 ──
      // 第一层·行底：旧侧（a / 删除）= danger 系，新侧（b / 新增）= success 系
      "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
        backgroundColor: tint(delSoft, 13),
      },
      "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
        backgroundColor: tint(addSoft, 12),
      },
      // 第二层·行内变更段：同行色相加深
      "&.cm-merge-a .cm-changedText": {
        backgroundColor: tint(delSoft, 34),
        backgroundImage: "none",
      },
      "&.cm-merge-b .cm-changedText": {
        backgroundColor: tint(addSoft, 34),
        backgroundImage: "none",
      },
      // unified 插入段（根无侧类名，兜底规则只命中 unified）
      ".cm-changedText": {
        backgroundColor: tint(addSoft, 34),
        backgroundImage: "none",
      },
      ".cm-deletedText": {
        backgroundColor: tint(delSoft, 34),
        backgroundImage: "none",
      },
      // 第三层·gutter 色条：安静但可扫读
      "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": {
        backgroundColor: tint(delSoft, 55),
      },
      "&.cm-merge-b .cm-changedLineGutter": {
        backgroundColor: tint(addSoft, 55),
      },
      ".cm-inlineChangedLineGutter": {
        backgroundColor: tint(addSoft, 55),
      },

      // 折叠条：它是可点按钮，必须有 hover 态
      ".cm-collapsedLines": {
        color: "var(--aide-text-muted)",
        background: "var(--aide-bg-base)",
        "&:hover": {
          backgroundColor: "var(--aide-surface-hover)",
          color: "var(--aide-text-secondary)",
        },
      },
    },
    { dark: true },
  );
}
