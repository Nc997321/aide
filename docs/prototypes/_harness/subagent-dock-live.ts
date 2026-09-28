/**
 * 子代理 dock 活体夹具（2026-09-28）：把**真实的** SubagentDock 挂进浏览器核对观感 ——
 * 原型页是手抄 CSS，这里跑的是组件自己的 scoped 样式，能抓到抄错。
 *
 * 验三件事：
 *   ① 状态条的子代理身份（agentAccent 左条 + 节点字形 + 大写字距类型名）实际长什么样；
 *   ② 面板阅读区用的是与消息流内联块同一份时间线组件（subagent/SubagentTimeline.vue）；
 *   ③ 阅读区是真滚动容器（scrollHeight > clientHeight，滚得到尾部）。
 *
 * sessionId 传 null：点击状态条不会真的调 store（夹具里没有 Tauri），只验渲染。
 *
 * 复跑：cd aide && npx vite --port 5199
 *   → http://localhost:5199/docs/prototypes/_harness/subagent-dock-live.html
 */
import { createApp, h, ref } from "vue";
import "../../../src/styles/global.css";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import { vTooltip } from "../../../src/directives/tooltip";
import SubagentDock from "../../../src/components/SubagentDock.vue";
import type { SubagentBlock, SubagentEntry } from "../../../src/types/chat";

applyTheme(glass);

const steps = (n: number): SubagentEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    type: "tool",
    toolUseId: `t${i}`,
    toolName: i % 4 === 3 ? "Grep" : "Read",
    input: { file_path: `src/file-${i}.ts` },
    result: `// ${i}`,
  }));

const running: SubagentBlock = {
  type: "subagent",
  id: "sa-run",
  agentName: "CODE-ARCHITECT:TS-REVIEWER",
  description: "Re-review final fix wave",
  model: "qwen3.8-max",
  prompt: "You are re-reviewing the fix wave that followed a whole-branch review. ".repeat(30),
  entries: [
    { type: "thinking", text: "I need to read the diff file and the related source files, verify the fix contents, and validate the claims." },
    ...steps(8),
    { type: "text", text: "Alright, let me read all the source files." },
  ],
  isPending: true,
};

const running2: SubagentBlock = {
  type: "subagent",
  id: "sa-run2",
  agentName: "general-purpose",
  description: "核对 ledger 收口行",
  entries: steps(2),
  isPending: true,
};

const done: SubagentBlock = {
  type: "subagent",
  id: "sa-done",
  agentName: "Explore",
  description: "清点 workspace 引用",
  model: "qwen3.8-max",
  entries: steps(11),
  result: "11 处引用：src/a.ts / src/b.ts / …",
  isPending: false,
};

const failed: SubagentBlock = {
  type: "subagent",
  id: "sa-err",
  agentName: "general-purpose",
  description: "跑全量回归",
  entries: steps(4),
  isPending: false,
  isError: true,
};

const App = {
  setup() {
    const selected = ref<string | null>("sa-run");
    const open = ref(true);
    return () =>
      h("div", { style: "max-width:1000px;margin:24px auto;padding:0 16px" }, [
        h(SubagentDock, {
          sessionId: null,
          subagents: [running, running2, done, failed],
          open: open.value,
          selectedId: selected.value,
          "onUpdate:selectedId": (id: string) => (selected.value = id),
        }),
      ]);
  },
};

createApp(App).directive("tooltip", vTooltip).mount("#app");

// 读数：阅读区是否真的可滚（内容够长 → 能滚到尾部）
requestAnimationFrame(() => {
  const body = document.querySelector<HTMLElement>(".sadock-body");
  const verdict = body
    ? { clientH: body.clientHeight, scrollH: body.scrollHeight, canScroll: body.scrollHeight > body.clientHeight + 1 }
    : null;
  (window as unknown as { __dockVerdict: unknown }).__dockVerdict = verdict;
  console.log("[subagent-dock fixture]", verdict);
});
