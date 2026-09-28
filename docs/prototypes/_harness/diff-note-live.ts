/**
 * 截图用活体夹具（一次性形态核对，不入产品路径）：把**真实的** WindowDiffPane 挂进浏览器，
 * 核对四条「来源标注」在真组件里的观感——各自一行、不折行、不挤压 diff 区，短号 7 位。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/diff-note-live.html
 */
import { createApp, h } from "vue";
import "../../../src/styles/global.css";
import "../../../src/themes/apply";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import WindowDiffPane from "../../../src/components/fileviewer/WindowDiffPane.vue";
import { makePair } from "../../../src/utils/changeCard";
import type { WindowDiff } from "../../../src/composables/useFileViewer";

applyTheme(glass);

const pair = makePair("a\nb\n", "a\nB\n", "modified");
/** 线上短号：Rust 侧 `&rev[..7]` / 适配器 `rev.slice(0, 7)`，两处都必须是 7 位。 */
const SHORT = "0123456";

/** 四条文案逐字来自 diffSource/git.ts（Task 3 的实现），这里是"在真组件里长什么样"。 */
const CASES: { label: string; note: string }[] = [
  { label: "① round：开轮基线", note: `自开轮时的 ${SHORT} 到工作区（本轮视图）` },
  { label: "② session：会话首基线", note: `自会话起点的 ${SHORT} 到工作区（会话视图）` },
  { label: "③ 基线失效：降级（短号由适配器从 baseRev 截取）", note: `基线 ${SHORT} 已不在仓库中，退回 HEAD 累计` },
  { label: "④ 无基线：兜底（今天的句子，一字不改）", note: "累计视图：显示该文件相对 HEAD 的全部差异（非本轮片段）" },
];

const app = createApp({
  setup() {
    return () =>
      h("div", { style: "display:flex;flex-direction:column;gap:14px;padding:20px;max-width:820px;background:#0a0b11;min-height:100vh" },
        CASES.map((c, i) =>
          h("div", { "data-case": String(i) }, [
            h("div", { style: "font:11px/1.6 var(--aide-font-ui);color:#7c8296;padding:0 0 6px" }, c.label),
            h("div", { style: "height:220px;border:1px solid var(--aide-border);border-radius:8px;overflow:hidden;background:var(--aide-bg-base)" },
              h(WindowDiffPane, {
                diff: { parts: [{ pair, firstLine: 1 }], note: c.note } as WindowDiff,
                filePath: "src/demo.ts",
              })),
          ]),
        ),
      );
  },
});

app.mount("#app");
