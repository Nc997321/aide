/**
 * 胶囊展开体压扁 · 回归夹具（2026-09-28）。
 *
 * 背景：过程胶囊的展开体 `.pg-body` 是 `display:flex; flex-direction:column;
 * max-height:440px; overflow:auto`，而子项（`.sa` 子代理块 / `.tool-item` 工具卡）
 * 带 `overflow:hidden`。按 flexbox 规则，flex 子项只要 overflow 不是 visible，
 * 其自动最小高度就是 0 —— 于是子项被压到胶囊剩余空间、超出部分被它自己的
 * overflow:hidden 裁掉；又因为子项被压到刚好装下，`.pg-body` 永不溢出
 * → 没有滚动条、没有可滚区域（用户看到的「点开后看不全，滚不动」）。
 *
 * 这个夹具挂**真实**的 ProcessGroup + SubagentCallBlock，展开到长内容后验三件事：
 *   ① `.pg-body` 真的能滚（scrollHeight > clientHeight）
 *   ② `.sa` 没被压扁（自身不裁内容）
 *   ③ 滚到底后最后一条产出真的可见（内容够得着，不是「看起来有滚动条」）
 *
 * 复跑：cd aide && npx vite --port 5199
 *   → http://localhost:5199/docs/prototypes/_harness/process-capsule-clip-live.html
 *   页面底部打印 PASS/FAIL，`window.__verdict` 是同一份读数。
 */
import { createApp, h, nextTick } from "vue";
import "../../../src/styles/global.css";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import { vTooltip } from "../../../src/directives/tooltip";
import ProcessGroup from "../../../src/components/ProcessGroup.vue";
import type { Segment } from "../../../src/utils/blockSegments";
import type { SubagentBlock, ThinkingBlock } from "../../../src/types/chat";

applyTheme(glass);

/** 足够长的子代理时间线：远超胶囊 440px 的限高，保证「不修必被压扁」。 */
const SUBAGENT: SubagentBlock = {
  type: "subagent",
  id: "sa-fixture",
  agentName: "CODE-ARCHITECT:TS-REVIEWER",
  description: "Re-review final fix wave",
  model: "qwen3.8-max",
  prompt: "You are re-reviewing the fix wave that followed a whole-branch review. ".repeat(40),
  entries: [
    { type: "thinking", text: "I need to read the diff file and the related source files, verify the fix contents, and validate the claims." },
    { type: "tool", toolUseId: "t1", toolName: "Read", input: { file_path: "review-3089610..40e2687.diff" }, result: "+  const list = useConversations();\n-  const query = new ConversationListQuery();" },
    { type: "tool", toolUseId: "t2", toolName: "Read", input: { file_path: "task-5-report.md" }, result: "## Task 5 report\n- [x] ledger 收口行\n- [x] workspace 删除" },
    { type: "text", text: "Alright, let me read all the source files." },
    { type: "tool", toolUseId: "t3", toolName: "Read", input: { file_path: "useConversations.ts" }, result: "export function useConversations() { /* … */ }" },
    { type: "tool", toolUseId: "t4", toolName: "Read", input: { file_path: "useConversations.test.ts" }, result: "describe('useConversations', () => { /* … */ });" },
    { type: "tool", toolUseId: "t5", toolName: "Grep", input: { pattern: "ConversationListQuery" }, result: "src/composables/useConversations.ts:12\nsrc/components/ConversationItem.vue:31" },
    { type: "tool", toolUseId: "t6", toolName: "Read", input: { file_path: "ConversationItem.vue" }, result: "<template>\n  <div class=\"conv-item\">…</div>\n</template>" },
    { type: "tool", toolUseId: "t7", toolName: "Bash", input: { command: 'rg -n "conversationListQuery" README.md' }, result: "README.md:88:会话列表查询已迁移" },
    { type: "thinking", text: "Removing the import is safe — nothing else references it." },
    { type: "tool", toolUseId: "t8", toolName: "Read", input: { file_path: "README.md" }, result: "…" },
  ],
  result: "复审结论：修复正确，import 删除无副作用，README 计数一致。",
  isPending: false,
};

const THINKING: ThinkingBlock = {
  type: "thinking",
  text: "先把 diff 和报告读一遍，再核对实际文件状态。",
};

const segments: Segment[] = [
  { kind: "block", block: THINKING, index: 0 },
  { kind: "block", block: SUBAGENT, index: 1 },
];

/** 等 n 帧（展开是 v-if + 布局，下一帧才量得到真实几何）。 */
function afterFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (n-- > 0 ? requestAnimationFrame(tick) : resolve());
    requestAnimationFrame(tick);
  });
}

interface Verdict {
  pgClientH: number;
  pgScrollH: number;
  pgCanScroll: boolean;
  saClientH: number;
  saScrollH: number;
  saClipped: boolean;
  tailVisibleAfterScroll: boolean;
  pass: boolean;
}

async function run() {
  const host = document.getElementById("app")!;
  host.style.cssText = "max-width:900px;margin:24px auto;padding:0 16px;font-family:var(--aide-font-ui);color:var(--aide-text-secondary)";

  createApp({ render: () => h(ProcessGroup, { segments }) })
    .directive("tooltip", vTooltip)
    .mount(host);

  await nextTick();
  // 展开胶囊 → 展开子代理时间线（走真实点击，不绕过组件状态机）
  document.querySelector<HTMLElement>(".pg-head")!.click();
  await nextTick();
  document.querySelector<HTMLElement>(".sa-head")!.click();
  await afterFrames(2);

  const pg = document.querySelector<HTMLElement>(".pg-body")!;
  const sa = document.querySelector<HTMLElement>(".sa")!;
  const tail = sa.querySelector<HTMLElement>(".sa-result");

  pg.scrollTop = pg.scrollHeight; // 滚到底：能滚的话最后一条产出应可见
  await afterFrames(1);

  const pgRect = pg.getBoundingClientRect();
  const tailRect = tail?.getBoundingClientRect();
  const verdict: Verdict = {
    pgClientH: pg.clientHeight,
    pgScrollH: pg.scrollHeight,
    pgCanScroll: pg.scrollHeight > pg.clientHeight + 1,
    saClientH: sa.clientHeight,
    saScrollH: sa.scrollHeight,
    saClipped: sa.scrollHeight > sa.clientHeight + 1,
    tailVisibleAfterScroll: !!tailRect && tailRect.bottom <= pgRect.bottom + 1 && tailRect.top >= pgRect.top - 1,
    pass: false,
  };
  verdict.pass = verdict.pgCanScroll && !verdict.saClipped && verdict.tailVisibleAfterScroll;

  host.insertAdjacentHTML(
    "beforeend",
    `<pre id="verdict" style="margin:20px 0;padding:12px;border:1px solid var(--aide-border);border-radius:10px;
      background:var(--aide-bg-base);font-family:var(--aide-font-mono);font-size:12px;line-height:1.7;white-space:pre-wrap">
胶囊展开体压扁 · 回归夹具
  .pg-body  clientH=${verdict.pgClientH}  scrollH=${verdict.pgScrollH}  可滚=${verdict.pgCanScroll}
  .sa       clientH=${verdict.saClientH}  scrollH=${verdict.saScrollH}  被压扁=${verdict.saClipped}
  滚到底后最后一条产出可见=${verdict.tailVisibleAfterScroll}
  VERDICT: ${verdict.pass ? "PASS" : "FAIL"}
</pre>`,
  );
  (window as unknown as { __verdict: Verdict }).__verdict = verdict;
  console.log("[capsule-clip fixture]", verdict);
}

void run();
