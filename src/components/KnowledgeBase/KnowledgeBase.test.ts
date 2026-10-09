// @vitest-environment jsdom
//
// 面板主组件的接线测试：目录渲染、上传（进度 + 传完直接打开）、删除确认走
// **应用统一的对话框**（不是 window.confirm）。数据闭包与状态机各自另有单测，
// 这里只钉「组件把闭包与对话框接对了没有」。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, enableAutoUnmount, flushPromises } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  health: vi.fn(),
  me: vi.fn(),
  listSpaces: vi.fn(),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  formats: vi.fn(),
  ingest: vi.fn(),
  createDocument: vi.fn(),
  updateStatus: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("./kbClient", () => ({
  kb: {
    status: mocks.status,
    health: mocks.health,
    me: mocks.me,
    listSpaces: mocks.listSpaces,
    listDocuments: mocks.listDocuments,
    getDocument: mocks.getDocument,
    formats: mocks.formats,
    ingest: mocks.ingest,
    createDocument: mocks.createDocument,
    updateStatus: mocks.updateStatus,
    previewToken: vi.fn(),
    updateDocument: vi.fn(),
    acquireLock: vi.fn(),
    lockHeartbeat: vi.fn(),
    releaseLock: vi.fn(),
    revisions: vi.fn(),
    revert: vi.fn(),
    deleteDocument: vi.fn(),
  },
  getToken: () => "t",
  setToken: vi.fn(),
  getBaseUrl: () => "http://kb.invalid",
  KbError: class KbError extends Error {},
}));

import { DEFAULT_RELEASE_REPO, upgradeCommand } from "./serverVersion";

// 圈选层的卡片对话会话在这里不是被测对象，且会接全局聊天事件监听（jsdom 里没有 Tauri）。
vi.mock("@/composables/useKbCardSession", async () => {
  const { ref } = await import("vue");
  return {
    useKbCardSession: () => ({
      sid: ref(null), thread: ref([]), permission: ref(null), editRequest: ref(null), busy: ref(false),
      sendError: ref(null), send: async () => undefined, respond: async () => {}, forget: () => {},
    }),
  };
});
vi.mock("./kbRuntime", () => ({ pushKnowledgeRuntime: vi.fn(async () => {}) }));

vi.mock("../../composables/useModal", () => ({
  useModal: () => ({ confirm: mocks.confirm, choice: vi.fn(), notice: vi.fn(), custom: vi.fn() }),
}));

import KnowledgeBase from "./KnowledgeBase.vue";

enableAutoUnmount(afterEach);

const USER = { id: "u1", username: "heaven", email: null, displayName: "heaven", isAdmin: true };
const SPACE = { id: "s1", key: "mine", name: "我的资料库", description: null, visibility: "private", role: "owner" };

function summary(id: string, title: string, mime = "text/markdown") {
  return {
    id,
    parentId: null,
    kind: "doc" as const,
    slug: id,
    title,
    mime,
    versionNo: 1,
    status: "draft",
    updatedAt: "2026-09-30T00:00:00Z",
  };
}

function mountPanel() {
  return mount(KnowledgeBase, {
    global: {
      stubs: { Icon: true },
      // 面板里 v-tooltip 由应用的指令注册；测试里给个空实现
      directives: { tooltip: {} },
    },
  });
}

/** 等 init + 目录渲染落地。两态之间是 `mode="out-in"` 的过渡，DOM 会晚一两拍。 */
async function settle(): Promise<void> {
  await flushPromises();
  await new Promise((r) => setTimeout(r, 0));
  await flushPromises();
}

beforeEach(() => {
  mocks.status.mockResolvedValue({ initialized: true });
  mocks.health.mockResolvedValue({
    status: "ok",
    service: "aide-knowledge",
    version: "0.5.0",
    parsers: [],
    tokenizer: "jieba-rs",
  });
  mocks.me.mockResolvedValue(USER);
  mocks.listSpaces.mockResolvedValue([SPACE]);
  mocks.listDocuments.mockResolvedValue([summary("d1", "数据说明.md")]);
  mocks.getDocument.mockImplementation(async (id: string) => ({
    ...summary(id, id === "d2" ? "复盘.html" : "数据说明.md", id === "d2" ? "text/html" : "text/markdown"),
    spaceId: "s1",
    content: id === "d2" ? "<p>x</p>" : "# 数据说明",
  }));
  mocks.formats.mockResolvedValue({ extensions: ["md", "html", "htm", "txt"] });
  // 默认：已是最新——横幅不出现
  mocks.updateStatus.mockResolvedValue({ current: "0.5.0", latest: "0.5.0", repo: "r.example/ns/kb", error: null });
  mocks.confirm.mockReset();
});

describe("索引态", () => {
  it("有凭据时静默进入并渲染目录", async () => {
    const w = mountPanel();
    await settle();

    expect(w.findAll("[data-kb-node]")).toHaveLength(1);
    expect(w.text()).toContain("数据说明.md");
  });
});

describe("聊天需要被看见", () => {
  it("文档侧发出的圈选被聊天里的确认框拦下（revealChat）→ 面板收起自己，让聊天露出来", async () => {
    const { useKbSelections } = await import("@/composables/useKbSelections");
    const w = mountPanel();
    await settle();
    expect(w.emitted("close")).toBeUndefined();
    useKbSelections().revealChat();
    await flushPromises();
    expect(w.emitted("close")).toHaveLength(1);
  });
});

describe("上传", () => {
  /** 造一个「用户选了文件」的现场（jsdom 里 files 只读） */
  async function pickFile(w: ReturnType<typeof mountPanel>, file: File): Promise<void> {
    const input = w.find<HTMLInputElement>("[data-kb-file]");
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await flushPromises();
  }

  it("上传中显示文件名与字节进度，传完自动打开它", async () => {
    let report: ((pct: number) => void) | null = null;
    let done: ((v: unknown) => void) | null = null;
    mocks.ingest.mockImplementation((input: { onProgress?: (p: number) => void }) => {
      report = input.onProgress ?? null;
      return new Promise((resolve) => {
        done = resolve;
      });
    });
    mocks.listDocuments
      .mockResolvedValueOnce([summary("d1", "数据说明.md")])
      .mockResolvedValue([summary("d1", "数据说明.md"), summary("d2", "复盘.html", "text/html")]);

    const w = mountPanel();
    await settle();
    await pickFile(w, new File(["<p>x</p>"], "复盘.html", { type: "text/html" }));

    expect(w.find(".kb-progress").exists()).toBe(true);
    expect(w.text()).toContain("正在上传「复盘.html」");

    report?.(37);
    await flushPromises();
    expect(w.text()).toContain("37%");

    report?.(99);
    await flushPromises();
    // 字节发完不等于完成：服务端还在解析落库，文案要改口
    expect(w.text()).toContain("服务端正在处理");

    done?.({ documentId: "d2", revisionId: "r1", title: "复盘", backend: "html", warnings: [] });
    await settle();

    expect(w.find(".kb-progress").exists()).toBe(false);
    expect(mocks.getDocument).toHaveBeenCalledWith("d2");
    expect(w.text()).toContain("这是一份网页产物");
  });
});

describe("更新横幅", () => {
  it("老服务端（没有版本）：说清版本，给出写入 .env 的升级命令并可复制", async () => {
    mocks.health.mockResolvedValue({ status: "ok", service: "aide-knowledge", parsers: [], tokenizer: "jieba-rs" });
    mocks.updateStatus.mockRejectedValue(new Error("404"));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const w = mountPanel();
    await settle();

    const strip = w.find("[data-kb-update]");
    expect(strip.text()).toContain("旧版本");
    const cmd = w.find(".kb-update-cmd").text();
    expect(cmd).toBe(upgradeCommand(DEFAULT_RELEASE_REPO, "stable"));
    expect(strip.text()).not.toContain("以后再说"); // 低于最低要求：必须升

    await w.findAll("button").find((b) => b.text().includes("复制命令"))?.trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(cmd);
    expect(w.text()).toContain("已复制");
  });

  it("有新版：提示版本，命令升到的就是那一版；「以后再说」后收起", async () => {
    mocks.updateStatus.mockResolvedValue({ current: "0.5.0", latest: "0.6.0", repo: "r.example/ns/kb", error: null });
    const w = mountPanel();
    await settle();

    const strip = w.find("[data-kb-update]");
    expect(strip.text()).toContain("0.6.0");
    expect(w.find(".kb-update-cmd").text()).toBe(upgradeCommand("r.example/ns/kb", "0.6.0"));
    await strip.findAll("button").find((b) => b.text() === "以后再说")?.trigger("click");
    await settle();
    expect(w.find("[data-kb-update]").exists()).toBe(false);
  });

  it("已是最新时不出现", async () => {
    const w = mountPanel();
    await settle();
    expect(w.find("[data-kb-update]").exists()).toBe(false);
  });
});

describe("删除确认", () => {
  it("走应用统一的对话框，不用 window.confirm", async () => {
    const native = vi.spyOn(window, "confirm");
    mocks.confirm.mockResolvedValue(false);

    const w = mountPanel();
    await settle();
    await w.find("[data-kb-node]").trigger("click");
    await settle();

    await w.findAll("button").find((b) => b.text() === "删除")?.trigger("click");
    await flushPromises();

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    const [title, message] = mocks.confirm.mock.calls[0] as [string, string];
    expect(title).toContain("删除「数据说明.md」");
    expect(message).toContain("没有恢复入口");
    expect(native).not.toHaveBeenCalled();
  });
});
