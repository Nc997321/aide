import { describe, expect, it } from "vitest";
import type { BgTask, SubagentBlock } from "@/types/chat";
import { bgTaskChip, subagentChip, subsessionChip, type ChildActivity } from "./activityChips";

const sa = (id: string, over: Partial<SubagentBlock> = {}): SubagentBlock =>
  ({ type: "subagent", id, agentName: "Explore", description: `任务 ${id}`, isPending: true, steps: [], ...over }) as SubagentBlock;
const bg = (id: string, over: Partial<BgTask> = {}): BgTask =>
  ({ id, status: "running", output: "", startedAt: 0, command: `cmd ${id}`, ...over }) as BgTask;

describe("activityChips", () => {
  it("空列表且面板没开：没有 chip", () => {
    expect(subagentChip([], false)).toBeNull();
    expect(bgTaskChip([], false)).toBeNull();
  });

  it("有运行中：报运行中个数，悬停列出名字", () => {
    const c = subagentChip([sa("a"), sa("b"), sa("c", { isPending: false })], false)!;
    expect(c).toMatchObject({ tab: "subagent", running: 2, tone: "run", open: false });
    expect(c.title).toBe("任务 a 等 2 个");
  });

  it("全部结束：完成 / 失败两态，不报个数", () => {
    expect(subagentChip([sa("a", { isPending: false })], false)).toMatchObject({ running: null, tone: "done" });
    expect(subagentChip([sa("a", { isPending: false, isError: true })], false)).toMatchObject({ tone: "err" });
    expect(bgTaskChip([bg("x", { status: "failed" })], true)).toMatchObject({ running: null, tone: "err", open: true });
  });

  it("后台任务按命令名", () => {
    expect(bgTaskChip([bg("x")], false)).toMatchObject({ tab: "bg", running: 1, title: "cmd x" });
  });
});

describe("subsessionChip", () => {
  const kids = [
    { id: "a", title: "gopls 条目" },
    { id: "b", title: "pyright 条目" },
    { id: "c", title: "回归测试" },
  ];

  it("没有子会话：没有 chip", () => {
    expect(subsessionChip([], () => "waiting", false)).toBeNull();
  });

  it("有在等批准的：黄色，运行中个数含它，附注待批准数", () => {
    const act: Record<string, ChildActivity> = { a: "running", b: "attention", c: "waiting" };
    expect(subsessionChip(kids, (id) => act[id], false)).toMatchObject({
      tab: "subsession",
      running: 2,
      tone: "attn",
      note: "1 待批准",
      title: "gopls 条目 等 2 个",
    });
  });

  it("全部空闲：已完成", () => {
    expect(subsessionChip(kids, () => "waiting", true)).toMatchObject({ running: null, tone: "done", open: true });
  });
});
