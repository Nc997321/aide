// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import type { ProviderConfig } from "@/types";

// 关掉的窗口监听/定时器随卸载一起清（本组件当前没有 window 监听，防后续新增时残留）
enableAutoUnmount(afterEach);

// ── Tauri（useChatSession 模块级 import 需要）──
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

// ── api mock：@ 补全的两条数据源受控，其余方法返回安全默认 ──
// 必须走 vi.hoisted：vi.mock 工厂被提到文件顶部，工厂里直接引用顶层 const 会 TDZ。
const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn<
    (path: string, showHidden?: boolean, includeIgnored?: boolean) => Promise<{ name: string; is_dir: boolean }[]>
  >(),
  findFilesByName: vi.fn<(query: string, cwd: string, limit?: number) => Promise<string[]>>(),
  pathTypes: vi.fn<(paths: string[]) => Promise<string[]>>(),
  readFileContent: vi.fn<(path: string) => Promise<string>>(),
}));
vi.mock("@aide/sdk/api", () => ({
  api: new Proxy(
    {
      listDirectory: mocks.listDirectory,
      findFilesByName: mocks.findFilesByName,
      pathTypes: mocks.pathTypes,
      readFileContent: mocks.readFileContent,
    },
    { get: (t, k) => (typeof k === "string" && k in t ? (t as Record<string, unknown>)[k] : vi.fn(async () => undefined)) },
  ),
}));
const { listDirectory: listDirectoryMock, findFilesByName: findFilesByNameMock, pathTypes: pathTypesMock } = mocks;
vi.mock("@/api/permissions", () => ({
  permissionsApi: {
    get: vi.fn(async () => ({ revision: 0, scopes: [], rules: [] })),
    createMany: vi.fn(async () => ({ revision: 1, scopes: [], rules: [] })),
  },
}));
vi.mock("../../composables/useBtwSession", () => ({
  useBtwSession: () => ({
    store: { value: { status: "idle", minimized: false, isBusy: false, ownerSessionId: null, model: "", effort: "" } },
    isBtwSid: () => false, startBtw: vi.fn(), handleBtwEvent: vi.fn(), cleanup: vi.fn(),
    minimize: vi.fn(), reopen: vi.fn(), rebindOwner: vi.fn(), setOnDone: vi.fn(),
  }),
}));
vi.mock("../../composables/useQuickActions", () => ({ useQuickActions: () => ({ actions: [] }) }));
vi.mock("../../composables/useModal", () => ({
  useModal: () => ({ confirm: vi.fn(async () => true), choice: vi.fn(async () => "cancel"), notice: vi.fn(async () => undefined) }),
}));
vi.mock("../../composables/useToast", () => ({
  useToast: () => ({ toastState: { visible: false, text: "", kind: "info" }, showToast: vi.fn() }),
}));
vi.mock("../../composables/useMentionInserter", () => ({
  useMentionInserter: () => ({ pending: { value: null }, insertMention: vi.fn(), consumeMention: vi.fn() }),
}));
vi.mock("../../composables/useFileClipboard", () => ({
  peekFileClipboard: () => null, clearFileClipboard: vi.fn(),
}));

import ChatInputBox from "./ChatInputBox.vue";
import { useWorkspaces } from "@/composables/useWorkspaces";
import { __resetUsageTipsForTest } from "@/composables/useUsageTips";

const WORKSPACE = "C:/repo";

function makeProvider(): ProviderConfig {
  return {
    id: "p_test", kind: "custom", name: "p_test", icon: "provider", baseUrl: "",
    apiKeyConfigured: false, authTokenConfigured: false, model: "kimi",
    modelMappings: {
      anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "",
    },
    effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", maxContextTokens: "", knownModels: [],
  };
}

function mountBox(over: Record<string, unknown> = {}): VueWrapper {
  return mount(ChatInputBox, {
    props: {
      sessionId: null,
      workspacePath: WORKSPACE,
      isBusy: false,
      isHero: false,
      models: [],
      permissionModes: [],
      sessionProvider: makeProvider(),
      sendConfirmedNonce: 0,
      focused: true,
      ...over,
    },
    global: { directives: { tooltip: () => {} } },
  });
}

const textarea = (w: VueWrapper) => w.find("textarea.chat-input");
const items = (w: VueWrapper) => w.findAll(".mention-item");
const namesOf = (w: VueWrapper) => items(w).map((el) => el.find(".mention-item-name").text());
const activeIndex = (w: VueWrapper) =>
  w.findAll(".mention-item").findIndex((el) => el.classes().includes("skill-item--active"));

/** 落字：写 value + 摆光标 + 触发 input（v-model 与 @ 补全都靠这一个事件醒） */
async function typeAt(w: VueWrapper, text: string, caret = text.length) {
  const el = textarea(w).element as HTMLTextAreaElement;
  el.value = text;
  el.setSelectionRange(caret, caret);
  await textarea(w).trigger("input");
  await flushPromises();
  await nextTick();
}

describe("ChatInputBox · @ 补全接线", () => {
  const { workspaces } = useWorkspaces();

  beforeEach(() => {
    vi.clearAllMocks();
    workspaces.value = []; // 工作区列表是模块级单例：每条用例自己摆

    listDirectoryMock.mockResolvedValue([
      { name: "src", is_dir: true },
      { name: "docs", is_dir: true },
    ]);
    findFilesByNameMock.mockResolvedValue([]);
    pathTypesMock.mockImplementation(async (paths) => paths.map(() => "file"));
    mocks.readFileContent.mockResolvedValue("");
  });

  it("打 @ 弹候选（数据源＝list_directory），目录在前", async () => {
    const w = mountBox();
    await typeAt(w, "@");

    expect(listDirectoryMock).toHaveBeenCalledWith(WORKSPACE, false, false);
    expect(w.find(".mention-dropdown").exists()).toBe(true);
    expect(items(w).map((el) => el.find(".mention-item-name").text())).toEqual(["docs", "src"]);
  });

  it("回车在菜单开着时只选中、**不发消息**（并转成引用芯片）", async () => {
    const w = mountBox();
    await typeAt(w, "@");
    await textarea(w).trigger("keydown", { key: "Enter" });
    await flushPromises();
    await nextTick();

    expect(w.emitted("send-request")).toBeUndefined();
    expect(w.find(".mention-chip-name").text()).toBe("docs"); // 高亮在首行（目录在前、按名升序）
    expect((textarea(w).element as HTMLTextAreaElement).value).toBe("");
  });

  it("Tab 与回车同义：引用当前高亮项", async () => {
    const w = mountBox();
    await typeAt(w, "@");
    await textarea(w).trigger("keydown", { key: "Tab" });
    await flushPromises();
    await nextTick();

    expect(w.emitted("send-request")).toBeUndefined();
    expect(w.find(".mention-chip").exists()).toBe(true);
  });

  it("→ 进入目录：文本续成 @<该目录>/ 并列出该层子项（不发消息）", async () => {
    const w = mountBox();
    await typeAt(w, "@");
    await textarea(w).trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    await nextTick();

    expect((textarea(w).element as HTMLTextAreaElement).value).toBe("@docs/");
    expect(listDirectoryMock).toHaveBeenLastCalledWith(`${WORKSPACE}/docs`, false, false);
    expect(w.emitted("send-request")).toBeUndefined();
  });

  it("↑↓ 移动高亮；随后的 keyup 不会把高亮打回首行", async () => {
    const w = mountBox();
    await typeAt(w, "@");
    await textarea(w).trigger("keydown", { key: "ArrowDown" });
    await textarea(w).trigger("keyup", { key: "ArrowDown" });
    await flushPromises();

    expect(activeIndex(w)).toBe(1);
  });

  it("有分隔符时不再跑全仓模糊兜底", async () => {
    const w = mountBox();
    await typeAt(w, "@src/");

    expect(findFilesByNameMock).not.toHaveBeenCalled();
  });

  it("无分隔符时补全仓兜底，兜底行挂「全仓」标签（走生产防抖）", async () => {
    vi.useFakeTimers();
    try {
      const w = mountBox();
      findFilesByNameMock.mockResolvedValue([`${WORKSPACE}/src/a/chat.rs`]);
      await typeAt(w, "@cha");
      expect(findFilesByNameMock).not.toHaveBeenCalled(); // 防抖窗口内还没发

      await vi.advanceTimersByTimeAsync(200); // 越过 180ms 防抖
      await flushPromises();

      const last = items(w)[items(w).length - 1];
      expect(last.find(".mention-item-name").text()).toBe("chat.rs");
      expect(last.find(".mention-item-tag").text()).toBe("全仓");
      expect(last.find(".mention-item-rel").text()).toBe("src/a"); // 不带尾斜杠（RTL 会把斜杠翻到左边）
    } finally {
      vi.useRealTimers();
    }
  });

  it("@ 时其它已注册工作区排在前面（标「项目」），回车得到绝对路径芯片", async () => {
    workspaces.value = [
      { key: "k1", name: "C:/other/backend-api", missing: false },
      { key: "k2", name: WORKSPACE, missing: false }, // 会话自己：不列
      { key: "k3", name: "D:/repo/gone", missing: true }, // 登记的路径不在了：不列
    ];
    const w = mountBox();
    await typeAt(w, "@");

    expect(namesOf(w)[0]).toBe("backend-api");
    expect(items(w)[0].find(".mention-item-tag").text()).toBe("项目");
    expect(items(w)[0].find(".mention-item-rel").text()).toBe("C:/other"); // 行尾父目录
    expect(namesOf(w)).not.toContain("gone");

    await textarea(w).trigger("keydown", { key: "Enter" });
    await flushPromises();
    await nextTick();

    expect(w.emitted("send-request")).toBeUndefined();
    expect(w.find(".mention-chip-name").text()).toBe("backend-api");
  });

  it("项目名按包含匹配（@back → backend-api）", async () => {
    workspaces.value = [{ key: "k1", name: "C:/other/backend-api", missing: false }];
    const w = mountBox();
    await typeAt(w, "@back");

    expect(namesOf(w)).toEqual(["backend-api"]);
  });

  it("进项目：→ 续成绝对路径 + 斜杠，并列出该项目的子项", async () => {
    workspaces.value = [{ key: "k1", name: "C:/other/backend-api", missing: false }];
    listDirectoryMock.mockImplementation(async (path: string) =>
      path === "C:/other/backend-api"
        ? [{ name: "prisma", is_dir: true }, { name: "package.json", is_dir: false }]
        : []);
    const w = mountBox();
    await typeAt(w, "@back");

    await textarea(w).trigger("keydown", { key: "ArrowRight" });
    await flushPromises();
    await nextTick();

    expect((textarea(w).element as HTMLTextAreaElement).value).toBe("@C:/other/backend-api/");
    expect(namesOf(w)).toEqual(["prisma", "package.json"]);
    expect(w.emitted("send-request")).toBeUndefined();
  });

  it("光标离开 token → 菜单关（@ 是光标锚定的，文本保留）", async () => {
    const w = mountBox();
    await typeAt(w, "看下 @");
    expect(w.find(".mention-dropdown").exists()).toBe(true);

    const el = textarea(w).element as HTMLTextAreaElement;
    el.setSelectionRange(0, 0);
    await textarea(w).trigger("keyup", { key: "Home" });
    await flushPromises();

    expect(w.find(".mention-dropdown").exists()).toBe(false);
    expect(el.value).toBe("看下 @");
  });

  it("Esc 关菜单但保留文本", async () => {
    const w = mountBox();
    await typeAt(w, "@");
    await textarea(w).trigger("keydown", { key: "Escape" });
    await nextTick();

    expect(w.find(".mention-dropdown").exists()).toBe(false);
    expect((textarea(w).element as HTMLTextAreaElement).value).toBe("@");
  });

  it("无命中不弹空菜单；回车回到正常发送", async () => {
    const w = mountBox();
    listDirectoryMock.mockResolvedValue([]);
    await typeAt(w, "@zzz");
    expect(w.find(".mention-dropdown").exists()).toBe(false);

    await textarea(w).trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(w.emitted("send-request")).toHaveLength(1);
  });
});

describe("ChatInputBox · 使用小提示（时机提示）", () => {
  const { workspaces } = useWorkspaces();
  const tipRow = (w: VueWrapper) => w.find(".input-tip-row");

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    __resetUsageTipsForTest();
    workspaces.value = [];
    listDirectoryMock.mockResolvedValue([]);
    findFilesByNameMock.mockResolvedValue([]);
    pathTypesMock.mockImplementation(async (paths) => paths.map(() => "file"));
  });

  it("生成中开始打字 → 提示排队与 /btw；这一轮结束即收起", async () => {
    const w = mountBox({ sessionId: "s1", isBusy: true });
    expect(tipRow(w).exists()).toBe(false); // 没打字不出
    await typeAt(w, "再改一下");
    expect(tipRow(w).text()).toContain("/btw");
    await w.setProps({ isBusy: false });
    expect(tipRow(w).exists()).toBe(false);
  });

  it("空闲时打字不出；未聚焦的输入框不出", async () => {
    const idle = mountBox({ sessionId: "s1" });
    await typeAt(idle, "hi");
    expect(tipRow(idle).exists()).toBe(false);
    const unfocused = mountBox({ sessionId: "s1", isBusy: true, focused: false });
    await typeAt(unfocused, "hi");
    expect(tipRow(unfocused).exists()).toBe(false);
  });

  it("点 × = 这条退役，下一轮生成中打字不再出", async () => {
    const w = mountBox({ sessionId: "s1", isBusy: true });
    await typeAt(w, "a");
    await w.find(".input-tip-x").trigger("click");
    expect(tipRow(w).exists()).toBe(false);
    await w.setProps({ isBusy: false });
    await w.setProps({ isBusy: true });
    await typeAt(w, "b");
    expect(tipRow(w).exists()).toBe(false);
  });

  it("每个忙碌期计一次出场，看满 3 次退役（第 3 次照常显示，不会一出来就消失）", async () => {
    const w = mountBox({ sessionId: "s1" });
    for (let i = 0; i < 3; i++) {
      await w.setProps({ isBusy: true });
      await typeAt(w, `x${i}`);
      expect(tipRow(w).exists()).toBe(true);
      await typeAt(w, `x${i}y`); // 同一轮继续打字不重复计数
      await w.setProps({ isBusy: false });
    }
    await w.setProps({ isBusy: true });
    await typeAt(w, "z");
    expect(tipRow(w).exists()).toBe(false);
  });

  it("@ 菜单里出现别的项目 → 菜单底部提示跨项目授权", async () => {
    workspaces.value = [{ key: "k1", name: "C:/other/backend-api", missing: false }];
    const w = mountBox();
    await typeAt(w, "@");
    expect(w.find(".mention-tip").text()).toContain("跨项目");
  });

  it("@ 菜单里没有别的项目 → 不提示", async () => {
    listDirectoryMock.mockResolvedValue([{ name: "src", is_dir: true }]);
    const w = mountBox();
    await typeAt(w, "@");
    expect(w.find(".mention-dropdown").exists()).toBe(true);
    expect(w.find(".mention-tip").exists()).toBe(false);
  });
});
