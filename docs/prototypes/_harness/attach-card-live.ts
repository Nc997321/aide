/**
 * 截图用活体夹具（一次性验证，不入产品路径）：把**真实的** ToolCallBlock 挂进浏览器，
 * 用真实主题 token 渲染目录卡（isDir）/ 文件卡 / 展开态——原型页是手抄 CSS，这个跑的是
 * 组件自己的 scoped 样式，能抓到抄错（token 名写错、scoped 选择器没生效都会露出来）。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/attach-card-live.html
 */
import { createApp, h } from "vue";
import "../../../src/styles/global.css";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import { vTooltip } from "../../../src/directives/tooltip";
import ToolCallBlock from "../../../src/components/ToolCallBlock.vue";
import type { ToolCallBlock as Block } from "../../../src/types/chat";

applyTheme(glass);

const DIR = "C:\\Users\\<user>\\IdeaProjects\\backend-gateway";

const dirCard: Block = {
  type: "tool_call",
  id: "dir-1",
  name: "Read",
  input: { file_path: DIR },
  result: [
    `目录：${DIR}（已授权访问，可直接 Read/Edit 其中文件）`,
    "一级条目（3 个）：",
    "  cmd/\n  internal/\n  go.mod",
  ].join("\n"),
  isError: false,
  isPending: false,
  isDir: true,
};

const fileCard: Block = {
  type: "tool_call",
  id: "file-1",
  name: "Read",
  input: { file_path: "src/api/client.ts" },
  result: "export const client = createClient();",
  isError: false,
  isPending: false,
};

/** 真 Read 卡（无 isDir）：确认药丸不会误出在普通工具卡上。 */
const realRead: Block = {
  type: "tool_call",
  id: "read-1",
  name: "Read",
  input: { file_path: "src/components/ToolCallBlock.vue", offset: 130, limit: 40 },
  result: "…",
  isError: false,
  isPending: false,
};

const rows: Array<[string, Block, boolean]> = [
  ["目录引用卡（isDir，收起）", dirCard, false],
  ["目录引用卡（isDir，展开）", dirCard, true],
  ["文件引用卡（无 isDir）", fileCard, false],
  ["真 Read 卡（无 isDir，带行号区间）", realRead, false],
];

const app = createApp({
  render: () =>
    h("div", { class: "wrap" }, [
      h("h1", "@目录 引用卡 · 真实组件（ToolCallBlock.vue）"),
      h(
        "p",
        "每条都是真组件实例：目录卡应出现右侧 accent 色「目录」药丸，文件卡与真 Read 卡不应出现。",
      ),
      ...rows.map(([label, block, expanded]) =>
        h("section", [
          h("h2", label),
          h(ToolCallBlock, { block, defaultExpanded: expanded }),
        ]),
      ),
    ]),
});

const style = document.createElement("style");
style.textContent = `
  body { background: radial-gradient(560px 380px at 10% -8%, rgba(124,108,255,.32), transparent 65%), #0a0b11;
         font-family: var(--aide-font-ui); color: var(--aide-text-primary); padding: 24px 28px 64px; }
  .wrap { max-width: 720px; }
  h1 { font-size: 16px; font-weight: 600; }
  .wrap > p { margin-top: 7px; font-size: 12px; color: var(--aide-text-muted); line-height: 1.7; }
  section { margin-top: 22px; }
  section h2 { font-size: 12px; font-weight: 600; color: var(--aide-text-secondary); margin-bottom: 9px; }
`;
document.head.appendChild(style);

app.directive("tooltip", vTooltip);
app.mount("#app");
