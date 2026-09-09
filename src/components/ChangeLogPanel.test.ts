// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ChangeLogPanel from "./ChangeLogPanel.vue";
import ChangeDiffPane from "./ChangeDiffPane.vue";

const mocks = vi.hoisted(() => ({
  rounds: [] as any[],
  openResolved: vi.fn(async () => {}),
  workspaceOf: vi.fn((): { wsKey: string; wsPath: string } | null => null),
  getProjectInfo: vi.fn(async () => ({ root: "", name: "", branch: "" })),
  gitDiffPair: vi.fn(async () => ({
    oldText: "a", newText: "b", oldLabel: "修改前", newLabel: "修改后",
    status: "modified", isBinary: false, eolOnly: false, tooBig: false,
  })),
  revertRound: vi.fn(),
  revertSingleFile: vi.fn(),
  revertFileGlobally: vi.fn(),
}));

vi.mock("../composables/useFileResolver", () => ({
  useFileResolver: () => ({ openResolved: mocks.openResolved }),
}));

vi.mock("../composables/useSessionWorkspaces", () => ({
  useSessionWorkspaces: () => ({ workspaceOf: mocks.workspaceOf }),
}));

vi.mock("../api", () => ({
  api: { getProjectInfo: mocks.getProjectInfo, gitDiffPair: mocks.gitDiffPair },
}));

function seedRounds() {
  mocks.rounds = [
    {
      index: 1,
      time: "12:00:00",
      prompt: "改点东西",
      files: [
        { path: "src/App.vue", status: "M", additions: 1, deletions: 0 },
        { path: "src/gone.ts", status: "D", additions: 0, deletions: 5 },
      ],
    },
  ];
}

function mountPanel() {
  return mount(ChangeLogPanel, {
    props: {
      sessionId: "s1",
      rounds: mocks.rounds,
      revertRound: mocks.revertRound,
      revertSingleFile: mocks.revertSingleFile,
      revertFileGlobally: mocks.revertFileGlobally,
    },
    // DiffViewer 是 CodeMirror 实例，jsdom 下挂载会炸；这里只验证「什么时候
    // 展开、传什么参数」，diff 本身的渲染不属于本文件的职责。
    global: { directives: { tooltip: () => {} }, stubs: { ChangeDiffPane: true } },
  });
}

/** 顶部统一树里某文件行的「打开 ↗」图标（第一个 .cft-act 是打开，第二个是撤回）。 */
function openAction(row: any) {
  return row.findAll(".cft-act")[0];
}

describe("ChangeLogPanel — 变更文件点击打开", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedRounds();
    mocks.workspaceOf.mockReturnValue({ wsKey: "C--repo", wsPath: "C:/repo" });
    mocks.getProjectInfo.mockResolvedValue({ root: "C:/current", name: "current", branch: "main" });
  });

  it("统一树条目：以会话所属工作区根交给文件解析器打开", async () => {
    const wrapper = mountPanel();
    await openAction(wrapper.get(".cft-file")).trigger("click");
    await flushPromises();

    expect(mocks.openResolved).toHaveBeenCalledWith("src/App.vue", "C:/repo");
  });

  it("会话未注册工作区时传 undefined，不再回退全局活动工作区", async () => {
    mocks.workspaceOf.mockReturnValue(null);
    const wrapper = mountPanel();
    await openAction(wrapper.get(".cft-file")).trigger("click");
    await flushPromises();

    // 消费端猜根（查不到就退全局）已删除：那正是条目被拼到旧工作区根下的成因
    expect(mocks.openResolved).toHaveBeenCalledWith("src/App.vue", undefined);
    expect(mocks.getProjectInfo).not.toHaveBeenCalled();
  });

  it("「撤回到此处」按钮：纯问答轮（无文件变更）也有入口，无快照轮隐藏", async () => {
    mocks.rounds = [
      // 纯问答轮：rewindTo 有值但 files 空 → 应显示（可回滚对话）
      { index: 1, time: "11:00:00", prompt: "这个函数干嘛的", files: [], rewindTo: 1000 },
      // 快照失败轮：rewindTo 无值 → 不显示（回滚不了对话，避免误导）
      { index: 2, time: "12:00:00", prompt: "改点东西", files: [], rewindTo: undefined },
    ];
    const wrapper = mountPanel();
    const buttons = wrapper.findAll(".changelog-round-revert");

    expect(buttons).toHaveLength(1);
    await buttons[0].trigger("click");
    expect(mocks.revertRound).toHaveBeenCalledTimes(1);
  });

  it("已删除（D）条目没有「打开 ↗」，但保留撤回入口", async () => {
    const wrapper = mountPanel();
    const rows = wrapper.findAll(".cft-file");
    const deleted = rows[1];

    expect(deleted.classes()).toContain("cft-file--deleted");
    expect(deleted.get(".cft-status").text()).toBe("D");

    // 磁盘上已无对应物：不渲染打开按钮（不是渲染了再禁用）
    expect(deleted.findAll(".cft-act")).toHaveLength(1);
    await deleted.findAll(".cft-act")[0].trigger("click");
    expect(mocks.revertFileGlobally).toHaveBeenCalled();
  });

  it("树形渲染：单链目录合并显示，目录聚合 +N/-M", () => {
    mocks.rounds = [
      {
        index: 1,
        time: "12:00:00",
        prompt: "改点东西",
        files: [
          { path: "src/composables/useX.ts", status: "M", additions: 3, deletions: 1 },
          { path: "README.md", status: "M", additions: 2, deletions: 0 },
        ],
      },
    ];
    const wrapper = mountPanel();

    const dirs = wrapper.findAll(".cft-dir");
    expect(dirs).toHaveLength(1);
    expect(dirs[0].text()).toContain("src/composables");
    // 目录行不带行数统计（只有名称）
    expect(dirs[0].text()).not.toContain("+3");
    // 文件行
    const files = wrapper.findAll(".cft-file");
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.text().includes("useX.ts"))).toBe(true);
    expect(files.some((f) => f.text().includes("README.md"))).toBe(true);
  });

  it("进行中轮次：「进行中」徽标 + 空文件显示「等待文件变更…」+ 不进无变更折叠", () => {
    mocks.rounds = [
      { index: 1, time: "11:00", prompt: "问答一轮", files: [], rewindTo: 100 },
      { index: 2, time: "11:01", prompt: "问答二轮", files: [], rewindTo: 200 },
      { index: 3, time: "11:02", prompt: "问答三轮", files: [], rewindTo: 300 },
      { index: 4, time: "11:03", prompt: "正在改代码", files: [], rewindTo: 400, pending: true },
      { index: 5, time: "11:04", prompt: "更早的轮", files: [{ path: "a.ts", status: "M", additions: 1, deletions: 0 }] },
    ];
    const wrapper = mountPanel();

    // 进行中徽标存在且属于轮 4
    const live = wrapper.findAll(".changelog-round-live");
    expect(live).toHaveLength(1);

    // 等待文件变更… 文案（而非「无变更」）
    expect(wrapper.text()).toContain("等待文件变更…");

    // pending 轮不进无变更折叠分组：三连空轮中，1-3 中间的被折叠（组内不含轮 4）
    // 轮 4、5 正常渲染；折叠行只覆盖 1-3 中的中间轮
    const collapsed = wrapper.findAll(".changelog-collapsed");
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].text()).toContain("1 轮无变更");
  });

  it("轮次区是平铺列表（一行一条），树只在顶部出现一次", () => {
    const wrapper = mountPanel();

    expect(wrapper.findAll(".changelog-round")).toHaveLength(1);
    // 轮内：平铺行（每行一条文件）
    expect(wrapper.findAll(".cfl-row")).toHaveLength(2);
    // 顶部统一树：文件节点
    expect(wrapper.findAll(".cft-file")).toHaveLength(2);
  });

  it("点轮内行 = 展开该文件 diff（并排），再点收起", async () => {
    const wrapper = mountPanel();
    expect(wrapper.findAllComponents(ChangeDiffPane)).toHaveLength(0);

    await wrapper.get(".cfl-row").trigger("click");
    await flushPromises();
    const panes = wrapper.findAllComponents(ChangeDiffPane);
    expect(panes).toHaveLength(1);
    expect(panes[0].props("mode")).toBe("split");

    await wrapper.get(".cfl-row").trigger("click");
    await flushPromises();
    expect(wrapper.findAllComponents(ChangeDiffPane)).toHaveLength(0);
  });

  it("顶部统一树 = 全会话累计：跨轮同路径合并一条（行数累加、状态取最新）", () => {
    mocks.rounds = [
      { index: 1, time: "11:00", prompt: "建文件", files: [{ path: "a.ts", status: "A", additions: 3, deletions: 0 }] },
      { index: 2, time: "11:01", prompt: "改文件", files: [{ path: "a.ts", status: "M", additions: 2, deletions: 1 }] },
    ];
    const wrapper = mountPanel();

    const rows = wrapper.findAll(".cft-file");
    expect(rows).toHaveLength(1);
    expect(rows[0].get(".cft-status").text()).toBe("M");
    expect(rows[0].text()).toContain("+5");
    expect(rows[0].text()).toContain("-1");
    // 轮区不建树：两轮各一条平铺行
    expect(wrapper.findAll(".cfl-row")).toHaveLength(2);
  });

  it("撤回按范围分流：轮内 → 单轮撤回，统一树 → 全会话撤回", async () => {
    const wrapper = mountPanel();

    await wrapper.get(".cfl-row").findAll(".cfl-act")[1].trigger("click");
    expect(mocks.revertSingleFile).toHaveBeenCalled();

    await wrapper.get(".cft-file").findAll(".cft-act")[1].trigger("click");
    expect(mocks.revertFileGlobally).toHaveBeenCalled();
  });
});
