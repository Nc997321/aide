// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import type { ChangeFile, ChangeRound } from "@/types";

const mocks = vi.hoisted(() => ({
  ensureTabShown: vi.fn(),
  openResolved: vi.fn(async () => {}),
  openDiff: vi.fn(async (_row: unknown, _opts?: unknown) => {}),
  workspaceOf: vi.fn((): { wsKey: string; wsPath: string } | null => null),
}));

const showToastMock = vi.hoisted(() => vi.fn());

// mock 边界：diff 窗口的载荷校验不在这里（窗口层自己的用例管），只验「点了行 →
// 递给窗口层的载荷对不对」；撤回走 feed，不需要 mock。这一层 mock 也顺带挡住
// useFileViewer → useRecent/useNotifications 那一串（它们不在本文件的关注面内）。
vi.mock("../../composables/useRightPanel", () => ({
  useRightPanel: () => ({ ensureTabShown: mocks.ensureTabShown }),
}));
vi.mock("../../composables/useFileResolver", () => ({
  useFileResolver: () => ({ openResolved: mocks.openResolved }),
}));
vi.mock("../../composables/useSessionWorkspaces", () => ({
  useSessionWorkspaces: () => ({ workspaceOf: mocks.workspaceOf }),
}));
vi.mock("../../composables/useDiffWindow", () => ({
  useDiffWindow: () => ({ openDiff: (row: unknown, opts: unknown) => mocks.openDiff(row, opts) }),
}));
vi.mock("../../composables/useToast", () => ({
  useToast: () => ({ toastState: { visible: false, text: "", kind: "info" }, showToast: showToastMock }),
}));

import TurnChangeCard from "./TurnChangeCard.vue";
import type { TurnChangesFeed } from "./turnChanges";

const f = (path: string, additions: number, deletions: number, status = "M"): ChangeFile => ({
  path, status, additions, deletions,
});

/** 可控的 feed：rounds 用 reactive 数组，用例可以直接改内容验"实时变"。 */
function makeFeed(rounds: ChangeRound[], sid = "s1", revert = vi.fn(async () => {})): TurnChangesFeed {
  return { sid, rounds, revertSingleFile: revert };
}

function mountCard(feed: TurnChangesFeed, sessionId: string | null = "s1") {
  return mount(TurnChangeCard, {
    props: { feed, sessionId },
    global: { directives: { tooltip: () => {} } },
  });
}

/** 一轮（默认已结算；pending 与 baseRev 由用例显式给）。 */
function round(index: number, files: ChangeFile[], pending = false, baseRev?: string): ChangeRound {
  return { index, time: "10:00", files, pending, baseRev };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceOf.mockReturnValue({ wsKey: "C--repo", wsPath: "C:/repo" });
});

describe("TurnChangeCard — 两态（隐藏 / 已结算）", () => {
  it("0 个文件的轮整卡不渲染——进行中同样适用", () => {
    const w = mountCard(makeFeed(reactive([round(1, [], true)])));
    expect(w.find(".tf").exists()).toBe(false);
  });

  it("本轮没动文件、上一轮动过 → 也没有卡（卡跟随当前轮，不跟随最后一轮有变更的轮）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 9, 0)]), round(2, [])])));
    expect(w.find(".tf").exists()).toBe(false);
  });

  it("进行中（pending）：不渲染任何卡，没有「正在改」", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 12, 0)], true)])));
    expect(w.find(".tf").exists()).toBe(false);
  });

  it("等权限（attention）时轮没结束 → 仍不渲染（判据是 round.pending，不是 sessionState）", () => {
    // pending 是归集器/轮次自己的"账单还没结"，等权限不会清它；按 sessionState === "running" 判会在这里露馅
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 3, 1)], true)])));
    expect(w.find(".tf").exists()).toBe(false);
  });

  it("已结算：卡名「本轮变更」，两个出口都在", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 203, 2)])])));
    expect(w.get(".tf-label").text()).toBe("本轮变更");
    expect(w.get(".tf-panel-link").text()).toBe("变更面板 \u2197");
    expect(w.get(".tf-pill").text()).toContain("展开");
  });

  it("分屏的另一组：feed.sid 与本体会话不符 → 整卡不渲染（不串会话）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 1, 0)])]), "other"), "s1");
    expect(w.find(".tf").exists()).toBe(false);
  });
});

describe("TurnChangeCard — 数字与文案（spec §2.5）", () => {
  it("零值不渲染：纯新增轮没有 `−0`；纯删除轮没有 `+0`", () => {
    const add = mountCard(makeFeed(reactive([round(1, [f("a.ts", 64, 0)])])));
    expect(add.find(".tf-big--del").exists()).toBe(false);
    expect(add.get(".tf-big--add").text()).toBe("+64");

    const del = mountCard(makeFeed(reactive([round(1, [f("a.ts", 0, 5)])])));
    expect(del.find(".tf-big--add").exists()).toBe(false);
    expect(del.get(".tf-big--del").text()).toBe("\u22125");
  });

  it("删除号是 U+2212（从原型复制的字形，不是 ASCII 连字符）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 203, 2)])])));
    expect(w.get(".tf-big--del").text()).toBe("\u22122");
    expect(w.get(".tf-big--del").text()).not.toContain("-");
  });

  it("千分位仅在 ≥4 位时出现（+1,240），文件数同口径", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 1240, 386)])])));
    expect(w.get(".tf-big--add").text()).toBe("+1,240");
    expect(w.get(".tf-big--del").text()).toBe("\u2212386");
    expect(w.get(".tf-unit").text()).toBe("1 个文件");
  });

  it("比例条分段：绿红各一段、零值不产生空段（flex 数值本身由 turnChangeStats 用例钉）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 203, 2)])])));
    const segs = w.findAll(".tf-bar-seg");
    expect(segs).toHaveLength(2);
    expect(segs[0].classes()).toContain("tf-bar-seg--add");
    expect(segs[1].classes()).toContain("tf-bar-seg--del");

    const pure = mountCard(makeFeed(reactive([round(1, [f("a.ts", 64, 0)])])));
    expect(pure.findAll(".tf-bar-seg")).toHaveLength(1);
    expect(pure.find(".tf-bar-seg--del").exists()).toBe(false);
  });

  it("文件数在行 2，行 1 没有", () => {
    const settled = mountCard(makeFeed(reactive([round(1, [f("a.ts", 203, 2)])])));
    expect(settled.get(".tf-nums .tf-unit").text()).toBe("1 个文件");
    expect(settled.find(".tf-top .tf-unit").exists()).toBe(false);
  });
});

describe("TurnChangeCard — 展开、清单与两个出口", () => {
  it("点卡片任意非按钮处展开本轮清单（复用 ChangeFileList），再点收起", async () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])])));
    expect(w.find(".tf-body").exists()).toBe(false);

    await w.get(".tf").trigger("click");
    expect(w.findAll(".cfl-row")).toHaveLength(1);
    expect(w.get(".tf-pill").text()).toContain("收起");

    await w.get(".tf-pill").trigger("click");
    expect(w.find(".tf-body").exists()).toBe(false);
  });

  it("点文件行开 diff（本轮口径 + 该轮基线），且不冒泡成「收起卡片」", async () => {
    const w = mountCard(makeFeed(reactive([
      round(1, [f("src/a.ts", 7, 2)], false, "aaaaaaa1111111111111111111111111111111111"),
    ])));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-row").trigger("click");
    await flushPromises();

    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/a.ts" }),
      {
        scope: "round",
        workspaceRoot: "C:/repo",
        baseRev: "aaaaaaa1111111111111111111111111111111111",
      },
    );
    expect(w.find(".tf-body").exists()).toBe(true); // 清单没被这次点击塌掉
  });

  it("轮记录没有 baseRev（老会话）→ 窗口拿 undefined 基线，退化为 HEAD 累计", async () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 1, 0)])])));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-row").trigger("click");
    await flushPromises();

    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/a.ts" }),
      { scope: "round", workspaceRoot: "C:/repo", baseRev: undefined },
    );
  });

  it("diff 打不开不静默：toast 说清失败", async () => {
    mocks.openDiff.mockRejectedValueOnce(new Error("git 挂了"));
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])])));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-row").trigger("click");
    await flushPromises();

    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining("加载 diff 失败"), "danger");
  });

  it("「变更面板 ↗」走 ensureTabShown（不是 select 的 toggle），且不顺手展开自己", async () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 1, 0)])])));
    await w.get(".tf-panel-link").trigger("click");
    expect(mocks.ensureTabShown).toHaveBeenCalledWith("changes");
    expect(w.find(".tf-body").exists()).toBe(false);
  });

  it("行内「在编辑器打开」用手写回调 + 会话所属工作区根", async () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])])));
    await w.get(".tf").trigger("click");
    await w.findAll(".cfl-act")[0].trigger("click");
    await flushPromises();
    expect(mocks.openResolved).toHaveBeenCalledWith("src/a.ts", "C:/repo");
  });

  it("单文件撤回：走 feed.revertSingleFile(round, path)（面板同款）", async () => {
    const revert = vi.fn(async () => {});
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])]), "s1", revert));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-act--revert").trigger("click");
    await flushPromises();

    expect(revert).toHaveBeenCalledTimes(1);
    expect(revert.mock.calls[0][1]).toBe("src/a.ts");
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("撤回失败出声（不静默）：破坏性动作失败必须让用户知道", async () => {
    const revert = vi.fn(async () => { throw new Error("checkout 失败"); });
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])]), "s1", revert));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-act--revert").trigger("click");
    await flushPromises();

    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining("撤回失败"), "danger");
  });

  it("撤回掉本轮最后一个文件 → 整卡消失（不留 0 个文件的空壳）", async () => {
    const rounds = reactive([round(1, [f("src/a.ts", 7, 2)])]);
    const revert = vi.fn(async () => { rounds[0].files = []; });
    const w = mountCard(makeFeed(rounds, "s1", revert));

    expect(w.find(".tf").exists()).toBe(true);
    await w.get(".tf").trigger("click");
    await w.get(".cfl-act--revert").trigger("click");
    await flushPromises();

    expect(w.find(".tf").exists()).toBe(false);
  });
});

describe("TurnChangeCard — 生命周期（展开态属于这一张账单）", () => {
  it("下一轮开始 → 卡隐藏，展开态不复用", async () => {
    const rounds = reactive([round(1, [f("a.ts", 7, 2)])]);
    const w = mountCard(makeFeed(rounds));
    await w.get(".tf").trigger("click");
    expect(w.find(".tf-body").exists()).toBe(true);

    rounds.push(round(2, [f("b.ts", 3, 0)], true));
    await nextTick();

    expect(w.find(".tf").exists()).toBe(false);

    rounds[1].pending = false;
    await nextTick();

    expect(w.get(".tf-label").text()).toBe("本轮变更");
    expect(w.find(".tf-body").exists()).toBe(false);
  });

  it("换会话（feed.sid 变）→ 展开态不继承", async () => {
    const rounds = reactive([round(1, [f("a.ts", 7, 2)])]);
    const feed = reactive(makeFeed(rounds));
    const w = mountCard(feed);
    await w.get(".tf").trigger("click");
    expect(w.find(".tf-body").exists()).toBe(true);

    feed.sid = "s2";
    await nextTick();

    expect(w.find(".tf-body").exists()).toBe(false);
  });
});
