// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ChangeLogPanel from "./ChangeLogPanel.vue";
import type { WindowDiff } from "../composables/useFileViewer";

const mocks = vi.hoisted(() => ({
  rounds: [] as any[],
  openResolved: vi.fn(async () => {}),
  viewerOpen: vi.fn(async (_path: string, _opts?: { diff?: WindowDiff }) => {}),
  workspaceOf: vi.fn((): { wsKey: string; wsPath: string } | null => null),
  getProjectInfo: vi.fn(async () => ({ root: "", name: "", branch: "" })),
  gitDiffPair: vi.fn(async () => ({
    oldText: "a", newText: "b", oldLabel: "修改前", newLabel: "修改后",
    status: "modified", isBinary: false, eolOnly: false, tooBig: false,
  })),
  revertRound: vi.fn(),
  revertSingleFile: vi.fn(),
  revertFileGlobally: vi.fn(),
  locateSessionMessage: vi.fn(async (_sid: string, _prompt: string, _roundIndex: number) => "scrolled"),
}));

vi.mock("../composables/useFileResolver", () => ({
  useFileResolver: () => ({ openResolved: mocks.openResolved }),
}));

vi.mock("../composables/useSessionWorkspaces", () => ({
  useSessionWorkspaces: () => ({ workspaceOf: mocks.workspaceOf }),
}));

// diff 窗口由窗口层打开（useDiffWindow → useFileViewer）：本文件只验证「点了行 →
// 递给窗口层的载荷对不对」，窗口内部渲染不属于这里。
vi.mock("../composables/useFileViewer", () => ({
  useFileViewer: () => ({ open: mocks.viewerOpen }),
}));

vi.mock("../api", () => ({
  api: { getProjectInfo: mocks.getProjectInfo, gitDiffPair: mocks.gitDiffPair },
}));

// 定位能力住在 useChatScroll（sid 注册表）——本文件只验证「点了标题 → 递出去的
// 载荷对不对、失败有没有出声」，真正的滚动逻辑在 useChatScroll 那边测。
vi.mock("../composables/useChatScroll", () => ({
  locateSessionMessage: mocks.locateSessionMessage,
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
    global: { directives: { tooltip: () => {} } },
  });
}

/** 顶部统一树里某文件行的「打开 ↗」图标（第一个 .cft-act 是打开，第二个是撤回）。 */
function openAction(row: any) {
  return row.findAll(".cft-act")[0];
}

type Panel = ReturnType<typeof mountPanel>;

/** 展开一轮（轮次默认收起）。roundIndex 是**轮号**，不是列表下标——列表是倒序的。 */
async function expandRound(wrapper: Panel, roundIndex: number) {
  await wrapper
    .get(`.changelog-round[data-round="${roundIndex}"] .changelog-round-toggle`)
    .trigger("click");
}

/** 某轮展开后的平铺文件行 */
function roundRows(wrapper: Panel, roundIndex: number) {
  return wrapper.findAll(`.changelog-round[data-round="${roundIndex}"] .cfl-row`);
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

  it("「撤回到此处」按钮：纯问答轮（无文件变更）也有入口，无锚点轮隐藏（undefined / null 同判）", async () => {
    mocks.rounds = [
      // 纯问答轮：rewindTo 有值但 files 空 → 应显示（可回滚对话）
      { index: 1, time: "11:00:00", prompt: "这个函数干嘛的", files: [], rewindTo: 1000 },
      // 快照失败轮：rewindTo 无值 → 不显示（回滚不了对话，避免误导）
      { index: 2, time: "12:00:00", prompt: "改点东西", files: [], rewindTo: undefined },
      // 磁盘上的"没有锚点"是 **null**（Rust `Option::None` 经 IPC 序列化成 null，
      // 不是 undefined）——旧数据全是这个形状，不能给它亮一个点了必失败的按钮
      { index: 3, time: "12:01:00", prompt: "又改点东西", files: [], rewindTo: null },
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

  it("轮次区是平铺列表（一行一条），树只在顶部出现一次", async () => {
    const wrapper = mountPanel();

    expect(wrapper.findAll(".changelog-round")).toHaveLength(1);
    await expandRound(wrapper, 1);
    // 轮内：平铺行（每行一条文件）
    expect(roundRows(wrapper, 1)).toHaveLength(2);
    // 顶部统一树：文件节点
    expect(wrapper.findAll(".cft-file")).toHaveLength(2);
  });

  it("统计口径常驻一行：空状态也说明「Bash 改动不在列」", () => {
    mocks.rounds = [];
    const wrapper = mountPanel();

    // 空状态最容易被误读成「Bash 改了文件但面板漏了」——口径必须在此时也可见
    expect(wrapper.find(".changelog-empty").exists()).toBe(true);
    expect(wrapper.get(".changelog-scope").text()).toContain("Bash");
  });

  it("点轮内行 = 弹该文件的 diff 窗口，载荷用本轮片段（逐段逐行）", async () => {
    mocks.rounds = [
      {
        index: 1,
        time: "12:00:00",
        prompt: "改点东西",
        files: [{ path: "src/App.vue", status: "M", additions: 1, deletions: 1 }],
        touches: [
          {
            path: "src/App.vue",
            status: "M",
            additions: 1,
            deletions: 1,
            segments: [{ oldText: "a", newText: "b", addCount: 1, delCount: 1 }],
          },
        ],
      },
    ];
    const wrapper = mountPanel();

    await expandRound(wrapper, 1);
    await wrapper.get(".cfl-row").trigger("click");
    await flushPromises();

    // 有片段就不查 git：本轮精确 diff 与 HEAD 无关；窗口拿绝对路径
    expect(mocks.gitDiffPair).not.toHaveBeenCalled();
    expect(mocks.viewerOpen).toHaveBeenCalledWith("C:/repo/src/App.vue", {
      diff: {
        parts: [expect.objectContaining({ pair: expect.objectContaining({ newText: "b" }) })],
      },
    });
  });

  it("点顶部统一树文件 = 累计视图窗口（跨轮视图没有片段）", async () => {
    const wrapper = mountPanel();

    await wrapper.get(".cft-file").trigger("click");
    await flushPromises();

    // 老会话的轮没有 baseRev → 无基线，退回 HEAD 累计（今天的句子照旧）
    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/App.vue", { mode: { kind: "unstaged" }, cwd: "C:/repo" });
    expect(mocks.viewerOpen).toHaveBeenCalledWith("C:/repo/src/App.vue", {
      diff: expect.objectContaining({ note: expect.stringContaining("累计视图") }),
    });
  });

  it("全部文件树：以**会话口径**取 diff（基线 = 首轮 baseRev，会话起点）", async () => {
    mocks.rounds = [
      { index: 1, time: "10:00", prompt: "第一轮", files: [], baseRev: "aaaaaaa1111111111111111111111111111111111" },
      {
        index: 2,
        time: "10:10",
        prompt: "第二轮",
        files: [{ path: "src/App.vue", status: "M", additions: 1, deletions: 0 }],
        baseRev: "bbbbbbb2222222222222222222222222222222222",
      },
    ];
    const wrapper = mountPanel();

    await wrapper.get(".cft-file").trigger("click");
    await flushPromises();

    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/App.vue", {
      mode: { kind: "since", rev: "aaaaaaa1111111111111111111111111111111111" }, // 首轮 = 会话起点
      cwd: "C:/repo",
    });
  });

  it("轮次行：以**本轮口径**取 diff（基线 = 该轮自己的 baseRev）", async () => {
    mocks.rounds = [
      { index: 1, time: "10:00", prompt: "第一轮", files: [], baseRev: "aaaaaaa1111111111111111111111111111111111" },
      {
        index: 2,
        time: "10:10",
        prompt: "第二轮",
        files: [{ path: "src/App.vue", status: "M", additions: 1, deletions: 0 }],
        baseRev: "bbbbbbb2222222222222222222222222222222222",
      },
    ];
    const wrapper = mountPanel();

    await expandRound(wrapper, 2);
    await wrapper.get(".cfl-row").trigger("click");
    await flushPromises();

    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/App.vue", {
      mode: { kind: "since", rev: "bbbbbbb2222222222222222222222222222222222" }, // 本轮，不是会话起点
      cwd: "C:/repo",
    });
  });

  it("diff 打不开（git 报错）：面板给 toast，不静默", async () => {
    mocks.gitDiffPair.mockRejectedValueOnce(new Error("not a git repository"));
    const wrapper = mountPanel();

    await wrapper.get(".cft-file").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("加载 diff 失败");
    expect(mocks.viewerOpen).not.toHaveBeenCalled();
  });

  it("顶部统一树 = 全会话累计：跨轮同路径合并一条（行数累加、状态取最新）", async () => {
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
    await expandRound(wrapper, 1);
    await expandRound(wrapper, 2);
    expect(wrapper.findAll(".cfl-row")).toHaveLength(2);
  });

  it("撤回按范围分流：轮内 → 单轮撤回，统一树 → 全会话撤回", async () => {
    const wrapper = mountPanel();

    await expandRound(wrapper, 1);
    await wrapper.get(".cfl-row").findAll(".cfl-act")[1].trigger("click");
    expect(mocks.revertSingleFile).toHaveBeenCalled();

    await wrapper.get(".cft-file").findAll(".cft-act")[1].trigger("click");
    expect(mocks.revertFileGlobally).toHaveBeenCalled();
  });

  it("撤回失败：面板给 toast，不静默（git 回滚失败必须让用户看见）", async () => {
    mocks.revertSingleFile.mockRejectedValueOnce(new Error("not a git repository"));
    const wrapper = mountPanel();

    await expandRound(wrapper, 1);
    await wrapper.get(".cfl-row").findAll(".cfl-act")[1].trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("撤回失败");
  });

  it("统一树撤回失败：同样给 toast", async () => {
    mocks.revertFileGlobally.mockRejectedValueOnce(new Error("boom"));
    const wrapper = mountPanel();

    await wrapper.get(".cft-file").findAll(".cft-act")[1].trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("撤回失败");
  });

  it("「撤回到此处」失败：同样给 toast（三条撤回路径一个出口）", async () => {
    mocks.revertRound.mockRejectedValueOnce(new Error("truncate failed"));
    mocks.rounds = [{ index: 1, time: "11:00:00", prompt: "改点东西", files: [], rewindTo: 100 }];
    const wrapper = mountPanel();

    await wrapper.get(".changelog-round-revert").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("撤回失败");
  });
});

describe("ChangeLogPanel — 轮次默认收起", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedRounds();
    mocks.workspaceOf.mockReturnValue(null);
  });

  it("默认收起：只有一行头，文件行不渲染", () => {
    const wrapper = mountPanel();

    expect(roundRows(wrapper, 1)).toHaveLength(0);
    expect(wrapper.get(".changelog-round-toggle").attributes("aria-expanded")).toBe("false");
  });

  it("点轮次头展开，再点收起", async () => {
    const wrapper = mountPanel();

    await expandRound(wrapper, 1);
    expect(roundRows(wrapper, 1)).toHaveLength(2);
    expect(wrapper.get(".changelog-round-toggle").attributes("aria-expanded")).toBe("true");

    await expandRound(wrapper, 1);
    expect(roundRows(wrapper, 1)).toHaveLength(0);
  });

  it("展开态按轮隔离：点哪轮开哪轮", async () => {
    mocks.rounds = [
      { index: 1, time: "12:00:00", prompt: "第一轮", files: [{ path: "a.ts", status: "M", additions: 1, deletions: 0 }] },
      { index: 2, time: "12:01:00", prompt: "第二轮", files: [{ path: "b.ts", status: "M", additions: 2, deletions: 0 }] },
    ];
    const wrapper = mountPanel();

    await expandRound(wrapper, 2);
    expect(roundRows(wrapper, 2)).toHaveLength(1);
    expect(roundRows(wrapper, 1)).toHaveLength(0);
  });

  it("纯问答轮（无文件）：头是禁用态，不摆一个点开也没东西的折叠入口", () => {
    mocks.rounds = [{ index: 1, time: "12:00:00", prompt: "这个函数干嘛的", files: [], rewindTo: 100 }];
    const wrapper = mountPanel();

    expect(wrapper.get(".changelog-round-toggle").attributes("disabled")).toBeDefined();
  });

  it("换会话清空展开态：新会话的轮次回到默认收起", async () => {
    const wrapper = mountPanel();

    await expandRound(wrapper, 1);
    expect(roundRows(wrapper, 1)).toHaveLength(2);

    // 轮号在两个会话里都从 1 开始：不清就是"新会话第 1 轮莫名开着"（张冠李戴）
    await wrapper.setProps({ sessionId: "s2" });
    expect(roundRows(wrapper, 1)).toHaveLength(0);
  });
});

describe("ChangeLogPanel — 轮次头元信息", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedRounds();
    mocks.workspaceOf.mockReturnValue(null);
  });

  it("有变更：文件数 + 汇总 ± + 时间收在同一行头里", () => {
    const wrapper = mountPanel();
    const meta = wrapper.get(".changelog-round-meta");

    expect(meta.text()).toContain("2 文件");
    expect(meta.text()).toContain("+1");
    expect(meta.text()).toContain("-5");
    expect(wrapper.get(".changelog-round-time").text()).toBe("12:00:00");
  });

  it("无变更轮：元信息位显示「无变更」，不再单占一行", () => {
    mocks.rounds = [{ index: 1, time: "11:13:57", prompt: "可以，跑吧", files: [] }];
    const wrapper = mountPanel();

    expect(wrapper.get(".changelog-round-meta").text()).toContain("无变更");
    expect(wrapper.find(".changelog-nochange").exists()).toBe(false);
  });

  it("进行中轮同样默认收起，元信息给「等待文件变更…」", () => {
    mocks.rounds = [{ index: 1, time: "11:03:00", prompt: "正在改代码", files: [], pending: true }];
    const wrapper = mountPanel();

    expect(wrapper.get(".changelog-round-toggle").attributes("aria-expanded")).toBe("false");
    expect(wrapper.get(".changelog-round-meta").text()).toContain("等待文件变更…");
  });
});

describe("ChangeLogPanel — 分区", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedRounds();
    mocks.workspaceOf.mockReturnValue(null);
  });

  it("全部文件树在可收缩的滚动容器内，轮次在容器外（树再长也顶不走轮次）", () => {
    const wrapper = mountPanel();
    const scroller = wrapper.get(".changelog-all-tree");

    expect(scroller.find(".cft-file").exists()).toBe(true);
    expect(scroller.find(".changelog-round").exists()).toBe(false);
  });
});

describe("ChangeLogPanel — 轮次定位到聊天区", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedRounds();
    mocks.workspaceOf.mockReturnValue(null);
    mocks.locateSessionMessage.mockResolvedValue("scrolled");
  });

  function locateBtn(wrapper: Panel, roundIndex = 1) {
    return wrapper.get(`.changelog-round[data-round="${roundIndex}"] .changelog-round-locate`);
  }

  it("点提问标题：按会话 id、提问文本、轮号递给定位入口", async () => {
    const wrapper = mountPanel();
    await locateBtn(wrapper).trigger("click");
    await flushPromises();

    expect(mocks.locateSessionMessage).toHaveBeenCalledWith("s1", "改点东西", 1);
  });

  it("标题不是展开按钮的嵌套后代（嵌套交互元素键盘到不了），点它不展开", async () => {
    const wrapper = mountPanel();
    const btn = locateBtn(wrapper);
    // 结构判据：定位按钮与展开按钮是兄弟，不在同一个 button 内
    expect(btn.element.closest("button.changelog-round-toggle")).toBeNull();

    await btn.trigger("click");
    await flushPromises();
    expect(wrapper.findAll(`.changelog-round[data-round="1"] .cfl-row`)).toHaveLength(0);
  });

  it("无 prompt 的轮次置灰且点了不触发（远程端发的消息没有可对上的文本）", async () => {
    mocks.rounds = [{ index: 1, time: "12:00:00", files: [] }];
    const wrapper = mountPanel();
    const btn = locateBtn(wrapper);

    expect(btn.attributes("disabled")).toBeDefined();
    await btn.trigger("click");
    await flushPromises();
    expect(mocks.locateSessionMessage).not.toHaveBeenCalled();
  });

  it("失败出声：找不到 / 没面板 文案分开（静默失败会被当成点了没反应）", async () => {
    mocks.locateSessionMessage.mockResolvedValue("not-found");
    const wrapper = mountPanel();
    await locateBtn(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.get(".a-toast-text").text()).toContain("不在已加载的历史里");

    mocks.locateSessionMessage.mockResolvedValue("unavailable");
    const w2 = mountPanel();
    await locateBtn(w2).trigger("click");
    await flushPromises();
    expect(w2.get(".a-toast-text").text()).toContain("没有这个会话的面板");
  });

  it("成功只留「正在定位…」，不落失败文案（补历史可能要等几百毫秒，先给回执）", async () => {
    const wrapper = mountPanel();
    await locateBtn(wrapper).trigger("click");
    await flushPromises();

    const text = wrapper.get(".a-toast-text").text();
    expect(text).toContain("正在定位");
    expect(text).not.toContain("历史");
  });
});
