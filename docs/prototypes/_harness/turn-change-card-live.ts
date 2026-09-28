/**
 * 截图用活体夹具（一次性验证，不入产品路径）：把**真实的** TurnChangeCard 挂进浏览器，
 * 用真实主题 token 渲染，核对与原型页 turn-change-footer.html 的形态一致——原型是手抄
 * CSS，这里跑的是组件自己的 scoped 样式，能抓到抄错。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/turn-change-card-live.html
 */
import { createApp, h } from "vue";
import "../../../src/styles/global.css";
import "../../../src/themes/apply";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import { vTooltip } from "../../../src/directives/tooltip";
import TurnChangeCard from "../../../src/components/ChatPanel/TurnChangeCard.vue";
import type { TurnChangesFeed } from "../../../src/components/ChatPanel/turnChanges";
import type { ChangeRound } from "../../../src/types";

applyTheme(glass);

const revertSingleFile = async () => {};

function feed(rounds: ChangeRound[]): TurnChangesFeed {
  return { sid: "live", rounds, revertSingleFile };
}

const CASES: { label: string; round: ChangeRound; expanded?: boolean }[] = [
  { label: "① 进行中 · 1 个文件（纯新增）", round: { index: 1, time: "10:00", pending: true, files: [{ path: "src/components/PermissionDialog.vue", status: "M", additions: 12, deletions: 0 }] } },
  { label: "② 进行中 · 2 个文件（有增有删）", round: { index: 2, time: "10:01", pending: true, files: [
    { path: "src/components/PermissionDialog.vue", status: "M", additions: 46, deletions: 6 },
    { path: "src/composables/useKeyboardConsume.ts", status: "M", additions: 2, deletions: 0 },
  ] } },
  { label: "③ 已结算 · 4 个文件 +203 −2", round: { index: 3, time: "10:02", files: [
    { path: "src/components/PermissionDialog.vue", status: "M", additions: 7, deletions: 2 },
    { path: "src/composables/useKeyboardConsume.ts", status: "M", additions: 3, deletions: 0 },
    { path: "docs/specs/2026-08-20-evidence-results-review-brief.md", status: "A", additions: 129, deletions: 0 },
    { path: "src/components/PermissionDialog.test.ts", status: "M", additions: 64, deletions: 0 },
  ] } },
  { label: "④ 已结算 · 大数 12 个文件 +1,266 −426（千分位）", round: { index: 4, time: "10:03", files: Array.from({ length: 12 }, (_, i) => ({ path: `src/deep/dir${i}/file-${i}.ts`, status: "M", additions: 100 + i, deletions: 30 + i })) } },
  { label: "⑤ 已结算 · 纯删除轮（无 +0、无空绿段）", round: { index: 5, time: "10:04", files: [{ path: "src/old/legacy.ts", status: "D", additions: 0, deletions: 412 }] } },
  { label: "⑥ 已结算 · 展开态", round: { index: 6, time: "10:05", files: [
    { path: "src/components/PermissionDialog.vue", status: "M", additions: 7, deletions: 2 },
    { path: "docs/specs/2026-08-20-evidence-results-review-brief.md", status: "A", additions: 64, deletions: 0 },
  ] }, expanded: true },
];

const app = createApp({
  setup() {
    return () =>
      h("div", { style: "display:flex;flex-direction:column;gap:14px;padding:20px;max-width:820px;background:#0a0b11;min-height:100vh" },
        CASES.map((c, i) =>
          h("div", { "data-case": String(i) }, [
            h("div", { style: "font:11px/1.6 var(--aide-font-ui);color:#7c8296;padding:0 0 6px" }, c.label),
            h(TurnChangeCard, { feed: feed([c.round]), sessionId: "live" }),
          ]),
        ),
      );
  },
});

app.directive("tooltip", vTooltip);
app.mount("#app");

/* 展开态没有对外开关：卡片没有 prop 也没有事件，直接点它（点非按钮区 = 展开/收起） */
setTimeout(() => {
  CASES.forEach((c, i) => {
    if (!c.expanded) return;
    document.querySelector<HTMLElement>(`[data-case="${i}"] .tf:not(.tf--live)`)?.click();
  });
}, 50);
