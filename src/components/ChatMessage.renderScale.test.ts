// @vitest-environment jsdom
/**
 * 渲染规模回归守卫：**过程胶囊必须真的在收拢**，以及单个块组件的节点数不许膨胀。
 *
 * 由来（2026-09-14 实测）：ChatMessage 的 segments 在定稿后才走二阶段合并成过程胶囊
 * （`segmentBlocks(blocks, { finalized: !message.streaming })`），流式期是平铺。
 * 实测一条 170 块的长回合：**平铺 1355 节点 vs 收拢 82 节点 = 16.5×**。
 *
 * 这个 16.5× 不是任何一次冻结的主因（250 块 ≈ 2000 节点，量级太小），但它是
 * **一个真实的退化面**：一旦二阶段合并失效（finalized 门控写错、mergeProcessRuns
 * 的判定被改坏、变更卡误入可折叠集），DOM 会静默涨 16 倍而没人发现。
 * 本文件钉的就是这条——不是性能测试，是"收拢有没有在工作"的守卫。
 *
 * 量的是 DOM 节点数（布局成本的乘数）。jsdom 没有布局引擎，量不出毫秒。
 */
import { describe, it, expect, vi } from "vitest";

// xterm 的实际构造在 jsdom 下会炸；本测量只关心节点数，用非变更类工具
// （Bash/Read/Grep）保证变更卡的 diff 视图不进渲染路径，同时 mock 掉 xterm。
// 变更卡自己那一路（静态 diff：无 CodeMirror、节点数量级）由
// fileviewer/StaticDiff.test.ts 守。
const t = vi.hoisted(() => {
  class Terminal {
    write = () => {};
    clear = () => {};
    open = () => {};
    loadAddon = () => {};
    dispose = () => {};
    options: Record<string, unknown> = {};
  }
  class FitAddon {
    fit = () => {};
  }
  return { Terminal, FitAddon };
});
vi.mock("xterm", () => ({ Terminal: t.Terminal }));
vi.mock("xterm-addon-fit", () => ({ FitAddon: t.FitAddon }));
vi.mock("../utils/xterm", () => ({ buildXtermTheme: () => ({}) }));
vi.mock("../utils/platform", () => ({ windowsPtyConfig: () => null }));
vi.mock("../composables/useSettings", () => ({
  useSettings: () => ({ settings: { terminalFontFamily: "", codeWrap: false } }),
}));

import { mount } from "@vue/test-utils";
import ChatMessage from "./ChatMessage.vue";
import type { ChatMessage as ChatMessageType, ContentBlock } from "@/types/chat";

/** 一条消息的 DOM 子树节点数（根节点本身 +1）。 */
function nodeCount(wrapperElement: Element): number {
  return wrapperElement.querySelectorAll("*").length + 1;
}

/** 挂载一条消息，返回其 DOM 子树节点数。 */
function measure(message: ChatMessageType): number {
  const w = mount(ChatMessage, { props: { message } });
  const n = nodeCount(w.element);
  w.unmount();
  return n;
}

let seq = 0;
const nextId = () => `blk-${++seq}`;

/** 工具调用块（非变更类 → 不建 DiffViewer/CodeMirror）。结果取中位行长量级 ~1.5KB。 */
function toolCall(i: number): ContentBlock {
  return {
    type: "tool_call",
    id: nextId(),
    name: i % 3 === 0 ? "Bash" : i % 3 === 1 ? "Read" : "Grep",
    input: { command: `cmd-${i}` },
    result: `line\n`.repeat(200),
    isPending: false,
  };
}

function thinking(i: number): ContentBlock {
  return { type: "thinking", text: `思考段落 ${i}：${"内容".repeat(60)}` };
}

function text(i: number): ContentBlock {
  return { type: "text", text: `正文段落 ${i}。${"这是一句话。".repeat(20)}` };
}

/** 造一条 assistant 消息。blocks 顺序模拟真实回合：思考 → 一批工具 → 正文，循环。 */
function makeMessage(blocks: ContentBlock[], streaming: boolean): ChatMessageType {
  return { id: nextId(), role: "assistant", blocks, timestamp: 0, streaming };
}

/** 真机那个回合的形状：工具调用占大头。10 × (1 思考 + 15 工具 + 1 正文) = 170 块。 */
function longTurnBlocks(): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (let round = 0; round < 10; round++) {
    out.push(thinking(round));
    for (let k = 0; k < 15; k++) out.push(toolCall(round * 15 + k));
    out.push(text(round));
  }
  return out;
}

describe("ChatMessage 渲染规模守卫", () => {
  // 这个用例一回合就是 200+ 个块、要渲染两遍，**单独跑约 3.7s**——贴着默认的 5s
  // 预算。全量跑时同时挂载的文件多，它会被挤出界（表现为 Test timed out）。
  // 这里给的是与它实际成本相称的预算，不是把失败掩盖掉。
  it("长回合的过程胶囊真的在收拢：平铺 ≥ 收拢的 10 倍", { timeout: 30_000 }, () => {
    const blocks = longTurnBlocks();
    const flat = measure(makeMessage(blocks, true)); // 流式期 = 平铺
    const folded = measure(makeMessage(blocks, false)); // 定稿后 = 过程胶囊（默认折叠）

    // 数字进断言消息——失败时一眼看到量级，不用去翻日志（vitest 会吞 console）。
    expect(
      flat,
      `平铺 ${flat} 节点 / 收拢 ${folded} 节点（${(flat / folded).toFixed(1)}×）——二阶段合并疑似失效`,
    ).toBeGreaterThan(folded * 10);
  });

  // 它比上面那条更重（300 个组件实例：工具卡/思考/正文各 100），同样会被挤出 vitest 的 5s
  // 默认预算（2026-09-19 全量跑实测 5671ms，失败形态是 Test timed out、下面的节点数断言
  // 根本没跑到）。这里给的仍是与成本相称的预算——断言是**结构性**的（节点数上限），
  // 放宽超时不掩盖任何东西。
  it("单个块组件的节点数不许膨胀（工具卡 / 思考 / 正文各 100 块）", { timeout: 30_000 }, () => {
    const kinds: Array<[string, (i: number) => ContentBlock]> = [
      ["工具调用", toolCall],
      ["思考", thinking],
      ["正文", text],
    ];
    for (const [label, make] of kinds) {
      const blocks = Array.from({ length: 100 }, (_, i) => make(i));
      const n = measure(makeMessage(blocks, true));
      // 2026-09-14 基线：工具卡 ~8 / 思考 ~6.7 / 正文 ~3.7 节点每块。
      // 钉 20 是防"某个块组件悄悄变成重组件"（多包几层壳、加了装饰节点之类）。
      expect(n, `${label} ×100 = ${n} 节点（基线 ~800 以内）`).toBeLessThan(100 * 20);
    }
  });
});

/**
 * data-msg-id 契约：useChatScroll 的「定位到某轮提问」（变更面板入口）靠它找气泡
 * ——量位置（messageTop）与加高亮脉冲（flashMessage）都按这个属性遍历 DOM。
 * 属性要是没渲染出来，定位会**静默**降级成「找不到」（用户只看到一句提示，不会
 * 知道是根元素少了属性），所以钉在这里。
 */
describe("ChatMessage — 定位锚点属性", () => {
  /** 注意：本文件这套 mount 下 `w.element` 是 VTU 的挂载容器（data-v-app），
   *  不是组件根元素——要按选择器取根。 */
  function rootOf(message: ChatMessageType) {
    const w = mount(ChatMessage, { props: { message } });
    const root = w.find("[data-msg-id]");
    return { w, root };
  }

  it("根元素带 data-msg-id，等于消息 id", () => {
    const message = makeMessage([text(1)], true);
    const { w, root } = rootOf(message);

    expect(root.exists()).toBe(true);
    expect(root.attributes("data-msg-id")).toBe(message.id);
    expect(root.classes()).toContain("msg-row");
    w.unmount();
  });

  it("user 与 assistant 两边都有（定位目标是用户气泡，但契约不按角色分叉）", () => {
    for (const role of ["user", "assistant"] as const) {
      const message: ChatMessageType = { ...makeMessage([text(1)], true), role };
      const { w, root } = rootOf(message);

      expect(root.attributes("data-msg-id"), `role=${role}`).toBe(message.id);
      w.unmount();
    }
  });
});
