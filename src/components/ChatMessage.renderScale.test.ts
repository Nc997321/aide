// @vitest-environment jsdom
/**
 * 渲染规模回归守卫：连续过程共用一个入口，收起时历史子树不挂载；
 * 普通块与正文隔开的单步过程也不能膨胀为重组件。
 * 量的是 DOM 节点数（布局成本的乘数），jsdom 不测真实布局耗时。
 */
import { describe, it, expect, vi } from "vitest";

// xterm 的实际构造在 jsdom 下会炸；本测量只关心节点数，用非变更类工具
// （Bash/Read/Grep）保证变更卡的 diff 视图不进渲染路径，同时 mock 掉 xterm。
// 变更卡自己那一路（静态 diff：无 CodeMirror、节点数量级）由
// fileviewer/StaticDiff.test.ts 守。
const media = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@aide/sdk/api/media", () => ({ mediaApi: { open: media.open } }));

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
  useSettings: () => ({ settings: { terminalFontFamily: "", codeWrap: false, showThinking: true } }),
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
  // 连续过程默认收起，历史子树按需挂载；15 次 Read 的节点数应与 1 次同量级。
  it("连续过程按需挂载：15 次读文件 ≈ 1 次的节点数", { timeout: 30_000 }, () => {
    const reads = (n: number): ContentBlock[] =>
      Array.from({ length: n }, (_, i) => ({
        type: "tool_call" as const,
        id: nextId(),
        name: "Read",
        input: { file_path: `/w/f${i}.ts` },
        result: "line\n".repeat(200),
        isPending: false,
      }));
    const one = measure(makeMessage([...reads(1), text(0)], false));
    const fifteen = measure(makeMessage([...reads(15), text(0)], false));
    expect(fifteen, `1 次 ${one} 节点 / 15 次 ${fifteen} 节点——合并疑似失效`).toBeLessThan(one * 2);
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
      // 非正文块之间插入正文，确保测到 100 个独立入口，而非一个折叠组。
      const blocks = Array.from({ length: 100 }, (_, i) => make(i)).flatMap((b): ContentBlock[] =>
        b.type === "text" ? [b] : [b, { type: "text", text: "。" }],
      );
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

describe("ChatMessage — 过程接线", () => {
  it("正文保留原位且不撤掉写入预览，下一指令与结束才收起", async () => {
    const write: ContentBlock = {
      type: "tool_call", id: "write", name: "Write", input: { file_path: "src/a.ts", content: "const a = 2;" },
      isPending: false, result: "updated",
    };
    const message = makeMessage([toolCall(1), write], true);
    const w = mount(ChatMessage, {
      props: { message }, global: { directives: { tooltip: {} }, stubs: { StaticDiff: true } },
    });
    try {
      expect(w.findAll(".ti-row")).toHaveLength(1);
      expect(w.find(".ti-peek-diff").exists()).toBe(true);
      const withBody: ChatMessageType = { ...message, blocks: [...message.blocks, { type: "text", text: "保留的解释正文" }, thinking(0)] };
      await w.setProps({ message: withBody });
      expect(w.find(".msg-text").text()).toBe("保留的解释正文");
      expect(w.find(".ti-peek-diff").exists()).toBe(true);
      const next = { ...withBody, blocks: [...withBody.blocks, toolCall(2)] };
      await w.setProps({ message: next });
      expect(w.findAll(".process-group")).toHaveLength(2);
      expect(w.find(".ti-peek").exists()).toBe(false);
      await w.find(".ti-row").trigger("click");
      expect(w.find(".process-history").exists()).toBe(true);
      // 非当前组也必须在结束时收起，不能只依赖 current 从 true 变 false。
      await w.setProps({ message: { ...next, streaming: false } });
      expect(w.find(".process-history").exists()).toBe(false);
    } finally { w.unmount(); }
  });

  it("后台入口经过当前行与历史行均可透传，点击徽章不展开过程", async () => {
    const bash: ContentBlock = {
      type: "tool_call", id: "bash-bg", name: "Bash", input: { command: "pnpm test" }, result: "running", isPending: false,
    };
    const message = makeMessage([toolCall(1), bash], true);
    const w = mount(ChatMessage, {
      props: {
        message,
        bgTasks: [{ id: "task-bg", toolUseId: "bash-bg", status: "running", output: "", startedAt: 0 }],
      },
      global: { directives: { tooltip: {} }, stubs: { BashOutputBlock: true } },
    });
    try {
      await w.find(".ti-bgchip").trigger("click");
      expect(w.emitted("open-bg-dock")).toEqual([["task-bg"]]);
      expect(w.find(".process-history").exists()).toBe(false);
      await w.setProps({ message: { ...message, blocks: [...message.blocks, toolCall(2)] } });
      await w.find(".ti-row").trigger("click");
      await w.find(".process-history .ti-bgchip").trigger("click");
      expect(w.emitted("open-bg-dock")).toEqual([["task-bg"], ["task-bg"]]);
    } finally { w.unmount(); }
  });

  it("用户引用附件保留卡片，不进入过程分组", () => {
    const w = mount(ChatMessage, {
      props: { message: { ...makeMessage([toolCall(1)], false), role: "user" } },
      global: { directives: { tooltip: {} } },
    });
    try {
      expect(w.find(".process-group").exists()).toBe(false);
      expect(w.find(".tool-item").exists()).toBe(true);
      expect(w.find(".tool-item--line").exists()).toBe(false);
    } finally { w.unmount(); }
  });
});

describe("ChatMessage — 媒体成果", () => {
  const body = "[开场](media/opening.mp4) · [配乐](media/music.wav) · [重复](media/opening.mp4)";

  it("定稿助手正文提取并去重卡片，保留正文，点击统一打开媒体列表", async () => {
    const message = makeMessage([{ type: "text", text: body }], true);
    const w = mount(ChatMessage, {
      props: { message, workspacePath: "C:/project", draftKey: "session-media" },
    });
    expect(w.findAll(".media-artifact")).toHaveLength(0);
    await w.setProps({ message: { ...message, streaming: false } });
    expect(w.findAll(".media-artifact")).toHaveLength(2);
    expect(w.find(".msg-text").text()).toContain("开场");
    expect(w.find(".msg-text").text()).toContain("配乐");
    media.open.mockClear();
    await w.findAll(".media-artifact")[1].trigger("click");
    expect(media.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      files: [
        { path: "C:/project/media/opening.mp4", title: "开场" },
        { path: "C:/project/media/music.wav", title: "配乐" },
      ],
      selected: 1,
      target: { draftKey: "session-media" },
    }));
    w.unmount();
  });

  it("用户消息与没有消息工作区的正文不生成媒体成果卡", () => {
    const assistant = makeMessage([{ type: "text", text: body }], false);
    const user = mount(ChatMessage, {
      props: { message: { ...assistant, role: "user" }, workspacePath: "C:/project" },
    });
    expect(user.findAll(".media-artifact")).toHaveLength(0);
    user.unmount();
    const noWorkspace = mount(ChatMessage, { props: { message: assistant } });
    expect(noWorkspace.findAll(".media-artifact")).toHaveLength(0);
    noWorkspace.unmount();
  });
});

describe("ChatMessage — 文档成果", () => {
  const declaration = '```aide-document\n{"version":1,"path":"docs/design.md","title":"设计方案"}\n```';

  it("流式期保留正文，结束后生成卡片；历史重新挂载结果相同", async () => {
    const message = makeMessage([{ type: "text", text: `已完成。\n\n${declaration}` }], true);
    const w = mount(ChatMessage, { props: { message, workspacePath: "/project" } });
    expect(w.find(".document-artifact").exists()).toBe(false);
    await w.setProps({ message: { ...message, streaming: false } });
    expect(w.findAll(".document-artifact")).toHaveLength(1);
    expect(w.find(".msg-text").text()).toBe("已完成。");
    w.unmount();
    const history = mount(ChatMessage, { props: { message: { ...message, streaming: false }, workspacePath: "/project" } });
    expect(history.findAll(".document-artifact")).toHaveLength(1);
    history.unmount();
  });

  it("用户粘贴的协议示例不生成成果卡片", () => {
    const w = mount(ChatMessage, { props: { message: { ...makeMessage([{ type: "text", text: declaration }], false), role: "user" } } });
    expect(w.find(".document-artifact").exists()).toBe(false);
    expect(w.text()).toContain("version");
    w.unmount();
  });
});
