// @vitest-environment jsdom
// FileWindow 的 vim ex 命令处理（onVimEx）：
// :w 保存 / :wq 保存并关闭（保存失败不关）/ :q 走关闭确认 / :q! 强制关闭。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount, type VueWrapper } from "@vue/test-utils";
import { ref } from "vue";
import CodeEditor from "../CodeEditor.vue";

const saveMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const closeWindowMock = vi.hoisted(() => vi.fn());
const choiceMock = vi.hoisted(() => vi.fn().mockResolvedValue("cancel"));
let dirtyState = false;
let stackDirtyState = false;

vi.mock("../../composables/useFileViewer", () => ({
  useFileViewer: () => ({
    closeWindow: closeWindowMock,
    save: saveMock,
    projectRoot: ref(""),
    gotoOwnerId: ref(null),
    indexHintWinId: ref(null),
    revealInTreePath: vi.fn(),
    navigateInPlace: vi.fn(),
    navigateBack: vi.fn(),
    navStackHasDirty: () => stackDirtyState,
    openAndScrollTo: vi.fn(),
  }),
  isWindowDirty: () => dirtyState,
}));
vi.mock("../../composables/useGotoDefinition", () => ({
  useGotoDefinition: () => ({
    visible: ref(false),
    mode: ref("definitions"),
    searching: ref(false),
    degraded: ref(null),
    results: ref([]),
    selectedIndex: ref(-1),
    searchWord: ref({ value: "" }),
    search: vi.fn(),
    searchImplementations: vi.fn(),
    searchAllReferences: vi.fn(),
    localManualSearch: vi.fn(),
    dismiss: vi.fn(),
    selectNext: vi.fn(),
    selectPrev: vi.fn(),
    getSelected: vi.fn(),
    jumpToResult: vi.fn(),
  }),
}));
vi.mock("../../composables/useModal", () => ({
  useModal: () => ({ choice: choiceMock, prompt: vi.fn() }),
}));
vi.mock("../../composables/useNotifications", () => ({
  useNotifications: () => ({ push: vi.fn() }),
}));
vi.mock("../../composables/useContextMenu", () => ({
  useContextMenu: () => ({ show: vi.fn() }),
}));
vi.mock("../../api", () => ({ api: new Proxy({}, { get: () => vi.fn() }) }));

import FileWindow from "./FileWindow.vue";

let wrapper: VueWrapper | undefined;

const win = {
  id: "w1",
  filePath: "/p/a.ts",
  fileName: "a.ts",
  content: "hello",
  editContent: "hello",
  imageUrl: "",
  language: "",
  diffPair: null,
  error: "",
  saving: false,
  readonly: false,
  virtual: false,
  isMarkdown: false,
  mdMode: "edit" as const,
  scrollToLine: null,
  scrollViewportY: null,
  navStack: [],
  x: 0,
  y: 0,
  w: 600,
  h: 400,
  userResized: false,
};

beforeEach(() => {
  dirtyState = false;
  stackDirtyState = false;
  saveMock.mockClear();
  closeWindowMock.mockClear();
  choiceMock.mockClear();
  choiceMock.mockResolvedValue("cancel");
});

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = "";
});

function mountWindow() {
  wrapper = shallowMount(FileWindow, {
    props: { win, bounds: { w: 1200, h: 800 } },
    attachTo: document.body,
    global: { stubs: { Teleport: false } },
  });
  return wrapper;
}

describe("FileWindow vim ex commands", () => {
  it("w_saves_only", async () => {
    mountWindow();
    wrapper!.findComponent(CodeEditor).vm.$emit("vim-ex", "w");
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalledWith("w1"));
    expect(closeWindowMock).not.toHaveBeenCalled();
  });

  it("wq_saves_then_closes", async () => {
    mountWindow();
    wrapper!.findComponent(CodeEditor).vm.$emit("vim-ex", "wq");
    await vi.waitFor(() => expect(closeWindowMock).toHaveBeenCalledWith("w1"));
    expect(saveMock).toHaveBeenCalledWith("w1");
    expect(choiceMock).not.toHaveBeenCalled();
  });

  it("wq_save_failure_keeps_window_open", async () => {
    dirtyState = true; // save 后仍 dirty ⇒ 保存失败（save 里 error 已 toast）
    mountWindow();
    wrapper!.findComponent(CodeEditor).vm.$emit("vim-ex", "wq");
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    // 等一个微任务让 isWindowDirty 检查执行
    await new Promise((r) => setTimeout(r, 0));
    expect(closeWindowMock).not.toHaveBeenCalled();
  });

  it("q_clean_closes_directly", async () => {
    mountWindow();
    wrapper!.findComponent(CodeEditor).vm.$emit("vim-ex", "q");
    await vi.waitFor(() => expect(closeWindowMock).toHaveBeenCalledWith("w1"));
    expect(choiceMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("q_dirty_asks_and_save_close_on_confirm", async () => {
    dirtyState = true;
    choiceMock.mockResolvedValue("confirm");
    mountWindow();
    wrapper!.findComponent(CodeEditor).vm.$emit("vim-ex", "q");
    await vi.waitFor(() => expect(choiceMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(closeWindowMock).toHaveBeenCalledWith("w1"));
    expect(saveMock).toHaveBeenCalledWith("w1");
  });

  it("q_dirty_cancel_keeps_open", async () => {
    dirtyState = true;
    choiceMock.mockResolvedValue("cancel");
    mountWindow();
    wrapper!.findComponent(CodeEditor).vm.$emit("vim-ex", "q");
    await vi.waitFor(() => expect(choiceMock).toHaveBeenCalled());
    expect(saveMock).not.toHaveBeenCalled();
    expect(closeWindowMock).not.toHaveBeenCalled();
  });

  it("q_bang_discards_and_closes", async () => {
    dirtyState = true; // 有修改也直接丢弃
    mountWindow();
    wrapper!.findComponent(CodeEditor).vm.$emit("vim-ex", "q!");
    await vi.waitFor(() => expect(closeWindowMock).toHaveBeenCalledWith("w1"));
    expect(saveMock).not.toHaveBeenCalled();
    expect(choiceMock).not.toHaveBeenCalled();
  });
});
