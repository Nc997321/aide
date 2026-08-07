// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ChangeLogPanel from "./ChangeLogPanel.vue";

const mocks = vi.hoisted(() => ({
  rounds: [] as any[],
  openResolved: vi.fn(async () => {}),
  workspaceOf: vi.fn((): { wsKey: string; wsPath: string } | null => null),
  getProjectInfo: vi.fn(async () => ({ root: "", name: "", branch: "" })),
  revertRound: vi.fn(),
  revertSingleFile: vi.fn(),
}));

vi.mock("../composables/useConversationChanges", async () => {
  const { ref } = await import("vue");
  return {
    useConversationChanges: () => ({
      rounds: ref(mocks.rounds),
      revertRound: mocks.revertRound,
      revertSingleFile: mocks.revertSingleFile,
    }),
  };
});

vi.mock("../composables/useFileResolver", () => ({
  useFileResolver: () => ({ openResolved: mocks.openResolved }),
}));

vi.mock("../composables/useSessionWorkspaces", () => ({
  useSessionWorkspaces: () => ({ workspaceOf: mocks.workspaceOf }),
}));

vi.mock("../api", () => ({
  api: { getProjectInfo: mocks.getProjectInfo },
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
    props: { sessionId: "s1" },
    global: { directives: { tooltip: () => {} } },
  });
}

describe("ChangeLogPanel — 变更文件点击打开", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedRounds();
    mocks.workspaceOf.mockReturnValue({ wsKey: "C--repo", wsPath: "C:/repo" });
    mocks.getProjectInfo.mockResolvedValue({ root: "C:/current", name: "current", branch: "main" });
  });

  it("普通条目：以会话所属工作区根交给文件解析器打开", async () => {
    const wrapper = mountPanel();
    await wrapper.get(".changelog-file").trigger("click");
    await flushPromises();

    expect(mocks.openResolved).toHaveBeenCalledWith("src/App.vue", "C:/repo");
  });

  it("会话未注册工作区时回退当前活动工作区根", async () => {
    mocks.workspaceOf.mockReturnValue(null);
    const wrapper = mountPanel();
    await wrapper.get(".changelog-file").trigger("click");
    await flushPromises();

    expect(mocks.openResolved).toHaveBeenCalledWith("src/App.vue", "C:/current");
  });

  it("注册表与当前工作区都缺失时传 undefined，由解析器自报不存在", async () => {
    mocks.workspaceOf.mockReturnValue(null);
    mocks.getProjectInfo.mockResolvedValue({ root: "", name: "", branch: "" });
    const wrapper = mountPanel();
    await wrapper.get(".changelog-file").trigger("click");
    await flushPromises();

    expect(mocks.openResolved).toHaveBeenCalledWith("src/App.vue", undefined);
  });

  it("已删除（D）条目不可点开，但保留撤回入口", async () => {
    const wrapper = mountPanel();
    const rows = wrapper.findAll(".changelog-file");
    const deleted = rows[1];

    expect(deleted.classes()).toContain("changelog-file--deleted");
    expect(deleted.get(".changelog-file-status").text()).toBe("D");

    await deleted.trigger("click");
    await flushPromises();
    expect(mocks.openResolved).not.toHaveBeenCalled();

    // 撤回按钮仍可用（删除的文件靠它恢复）
    await deleted.get(".changelog-file-revert").trigger("click");
    expect(mocks.revertSingleFile).toHaveBeenCalled();
  });
});
