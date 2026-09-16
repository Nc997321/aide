/**
 * 截图用活体夹具（一次性验证，不入产品路径）：把**真实的** ChangeLogPanel 挂进浏览器，
 * 用真实主题 token 渲染，核对收起态/展开态的实际观感——原型页是手抄 CSS，
 * 这个跑的是组件自己的 scoped 样式，能抓到抄错。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/changelog-live.html
 */
import { createApp, h, ref } from "vue";
import "../../../src/styles/global.css";
import "../../../src/themes/apply";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import { vTooltip } from "../../../src/directives/tooltip";
import ChangeLogPanel from "../../../src/components/ChangeLogPanel.vue";
import type { ChangeRound } from "../../../src/types";

applyTheme(glass);

const rounds = ref<ChangeRound[]>([
  {
    index: 1, time: "10:21:01", prompt: "了解一下这个项目，然后帮我init一下",
    files: [{ path: "CLAUDE.md", status: "A", additions: 170, deletions: 1 }],
  },
  {
    index: 2, time: "10:43:18", prompt: "README重写一份吧",
    files: [
      { path: "README.md", status: "A", additions: 153, deletions: 8 },
      { path: "项目文档.md", status: "A", additions: 368, deletions: 10 },
      { path: "CLAUDE.md", status: "A", additions: 88, deletions: 5 },
      { path: "scripts/gen-docs.mjs", status: "A", additions: 256, deletions: 9 },
    ],
  },
  {
    index: 3, time: "11:10:40", prompt: ".lingma这个目录删了",
    files: [
      { path: "CLAUDE.md", status: "M", additions: 4, deletions: 5 },
      { path: "README.md", status: "M", additions: 2, deletions: 2 },
      { path: "项目文档.md", status: "M", additions: 4, deletions: 5 },
    ],
  },
  { index: 4, time: "11:13:49", prompt: "号", files: [] },
  { index: 5, time: "11:13:57", prompt: "可以，跑吧", files: [] },
  {
    index: 6, time: "11:14:28", prompt: "可以，跑吧",
    files: [
      { path: "README.md", status: "M", additions: 7, deletions: 4 },
      { path: "CLAUDE.md", status: "M", additions: 11, deletions: 2 },
      { path: "项目文档.md", status: "M", additions: 20, deletions: 7 },
    ],
  },
]);

/* ?tall=N → 往最新一轮塞 N 个假文件（顶部树变长，验自适应收缩） */
const tall = Number(new URLSearchParams(location.search).get("tall") || 0);
if (tall > 0) {
  const newest = rounds.value[rounds.value.length - 1];
  for (let i = 0; i < tall; i++) {
    newest.files.push({ path: `src/deep/dir${i % 5}/file-${i}.ts`, status: "M", additions: i + 1, deletions: i % 7 });
  }
}

const noop = async () => {};

function panel() {
  return h(ChangeLogPanel, {
    sessionId: "live",
    rounds: rounds.value,
    revertRound: noop,
    revertSingleFile: noop,
    revertFileGlobally: noop,
  });
}

/* ?variants=divider → 2×2 并排「全部文件 ↔ 轮次」分割线的候选。
   跑的是真组件，用 id 选择器压过 scoped 规则（id 层 > 类+属性层，不需要 !important）。 */
const DIVIDERS = [
  { id: "d0", label: "现状 · 1px rgba(255,255,255,.10)" },
  { id: "d1", label: "① 提亮 · 1px border-strong (.17)" },
  { id: "d2", label: "② 实心带 · 5px surface-active (.14)" },
  { id: "d3", label: "③ 强调线 · 2px accent 45%" },
  { id: "d4", label: "④ 轮次也加分区标题（无分割线）" },
];

const variantMode = new URLSearchParams(location.search).get("variants");

const app = createApp({
  setup() {
    if (variantMode === "divider") {
      return () =>
        h("div", { style: "display:grid;grid-template-columns:320px 320px 320px;gap:18px;padding:14px;background:#05060a;align-items:start" },
          DIVIDERS.map((v) =>
            h("div", { id: v.id }, [
              h("div", { style: "font:11px/1.6 var(--aide-font-ui);color:#b9bdd0;padding:2px 0 6px" }, v.label),
              h("div", { style: "height:400px;display:flex;border:1px solid rgba(255,255,255,.1);border-radius:10px;overflow:hidden" }, panel()),
            ]),
          ),
        );
    }
    /* 默认 / ?expanded=1 → 单面板 */
    return () =>
      h("div", { style: "display:flex;height:100vh;justify-content:flex-end;background:#05060a" }, [
        h("div", { style: "width:340px;display:flex" }, panel()),
      ]);
  },
});

/* 分割线候选的覆盖样式（先挂，mount 后组件样式已注入，靠 id 选择器赢） */
if (variantMode === "divider") {
  const style = document.createElement("style");
  style.textContent = `
    #d1 .changelog-all { border-bottom-color: rgba(255,255,255,.17); }
    #d2 .changelog-all { border-bottom: 5px solid var(--aide-surface-active); }
    #d3 .changelog-all { border-bottom: 2px solid color-mix(in srgb, #a5b8ff 45%, transparent); }
    /* ④ 不加线：在轮次区头部插一行同名样式的分区标题（伪元素省得改组件） */
    #d4 .changelog-all { border-bottom: none; }
    #d4 .changelog-round:first-of-type::before {
      content: "轮次变更"; display: block;
      padding: 6px 12px 4px;
      font: 600 12px/1.4 var(--aide-font-ui); color: #b9bdd0;
      background: var(--aide-bg-deep);
      border-bottom: 1px solid rgba(255,255,255,.1);
    }
  `;
  document.head.appendChild(style);
}

app.directive("tooltip", vTooltip);
app.mount("#app");

/* 展开全部轮次（截图用）：直接点 DOM 上的轮次头 */
if (new URLSearchParams(location.search).get("expanded")) {
  setTimeout(() => {
    document.querySelectorAll<HTMLButtonElement>(".changelog-round-toggle").forEach((b) => {
      if (!b.disabled) b.click();
    });
  }, 50);
}
