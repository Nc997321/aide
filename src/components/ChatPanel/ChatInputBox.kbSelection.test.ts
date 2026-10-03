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

function mountBox(): VueWrapper {
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
    },
    global: { directives: { tooltip: () => {} } },
  });
}


import { __resetKbSelectionsForTest, useKbSelections } from "@/composables/useKbSelections";

function pendingRecord(comment = "写具体些") {
  const k = useKbSelections();
  const rec = k.begin({
    documentId: "doc-1", title: "发布流程", baseVersion: 3, baseContent: "出现故障时先切流量到旧版本再排查。",
    scope: { start: 6, end: 13, text: "切流量到旧版本", lineStart: 1, lineEnd: 1, precise: true },
  });
  k.confirm(rec.ref.selectionId, comment);
  return { k, id: rec.ref.selectionId };
}

beforeEach(() => __resetKbSelectionsForTest());

describe("ChatInputBox · 没发出的圈选以芯片出现在输入框上方", () => {
  it("输入框上方出现圈选芯片，× 摘掉后文档侧的记录同步消失", async () => {
    const w = mountBox();
    const { k, id } = pendingRecord();
    await flushPromises();
    expect(w.find(".kb-chip").exists()).toBe(true);
    expect(w.find(".kb-chip").text()).toContain("发布流程");
    await w.find(".kb-chip .mention-chip-remove").trigger("click");
    expect(k.records[id]).toBeUndefined();
  });
});
