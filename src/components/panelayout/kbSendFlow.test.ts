// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { __resetKbSelectionsForTest, useKbSelections } from "@/composables/useKbSelections";
import type { ProviderConfig, ProviderModelMappings } from "@/types";

// ── Tauri（useChatSession 模块级 import 需要）──
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const invokeMock = vi.fn(async (..._a: unknown[]) => undefined as unknown);
const sendMessageMock = vi.fn(async (_p: unknown) => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// ── api mock：sessionModel/sessionProvider 受控；其余方法返回安全默认 ──
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
// 权限快照/批量写入桩（usePermissionRememberContext 消费；「允许并记住」用例 override 返回值）
const permGetMock = vi.fn(async () => ({ revision: 0, scopes: [], rules: [] }));
const permCreateManyMock = vi.fn(async () => ({ revision: 1, scopes: [], rules: [] }));
// toast 桩共享引用（「允许并记住」落盘回执文案断言用）
const showToastMock = vi.fn();
vi.mock("@aide/sdk/api", () => ({
  api: new Proxy(
    {
      sendMessage: (p: unknown) => sendMessageMock(p),
      sessionModel: (id: string) => sessionModelMock(id),
      sessionProvider: (id: string) => sessionProviderMock(id),
      setSessionModel: vi.fn(async () => undefined),
      setSessionProvider: vi.fn(async () => undefined),
      sessionEffort: vi.fn(async () => null),
      setSessionEffort: vi.fn(async () => undefined),
      getDefaultModels: vi.fn(async () => []),
      getDefaultPermissionModes: vi.fn(async () => [{ value: "auto", displayName: "自动模式" }]),
      scanPluginSkills: vi.fn(async () => []),
      readFileContent: vi.fn(async () => ""),
    },
    { get: (t, k) => (typeof k === "string" && k in t ? (t as Record<string, unknown>)[k] : vi.fn(async () => undefined)) },
  ),
}));
vi.mock("@/api/permissions", () => ({
  permissionsApi: {
    get: (project?: string) => permGetMock(project),
    createMany: (scope: string, rules: unknown[], project?: string) =>
      permCreateManyMock(scope, rules, project),
  },
}));

// ── 其余 composable stub（ChatPanel onMounted/watch 依赖）──
// 形状必须与 useChatScroll 的返回值一致（行模型：rows/landing——ramp 时代是
// visibleRows/ramping，已拆；stub 落后会让「组件拿到的字段名写错」这类回归静默通过）
vi.mock("../../composables/useChatScroll", () => ({
  useChatScroll: () => ({
    scrollEl: null, contentEl: null, rows: [], landing: false, restoring: false,
    onScroll: vi.fn(), jumpToBottom: vi.fn(), farFromBottom: false,
    newWhileAway: false, expandOlderAnchored: vi.fn(), restoreAnchored: vi.fn(),
    expandLiveAnchored: vi.fn(),
  }),
}));
vi.mock("../../composables/useBtwSession", () => ({
  useBtwSession: () => ({
    store: { value: { status: "idle", minimized: false, isBusy: false, ownerSessionId: null, model: "", effort: "" } },
    isBtwSid: () => false, startBtw: vi.fn(), handleBtwEvent: vi.fn(), cleanup: vi.fn(),
    minimize: vi.fn(), reopen: vi.fn(), rebindOwner: vi.fn(), setOnDone: vi.fn(),
  }),
}));
vi.mock("../../composables/useQuickActions", () => ({ useQuickActions: () => ({ actions: [] }) }));
vi.mock("../../composables/useChatPaneWidth", () => ({ setChatPaneRect: vi.fn() }));
// AppLogo 导入 /icon.png（vite 公共资源）在 jsdom 下会崩，stub 掉。
vi.mock("../AppLogo.vue", () => ({ default: { name: "AppLogo", template: "<div class='app-logo-stub' />" } }));

// 结算卡在本文件里换成薄壳：接线要验的是"注入了 feed 才渲染、且喂进去的是这份 feed"，
// 卡片内部的形态归 TurnChangeCard.test.ts。壳也顺带挡住卡片那串 composable 依赖。
vi.mock("./TurnChangeCard.vue", () => ({
  default: {
    name: "TurnChangeCard",
    props: { feed: { type: Object, required: true }, sessionId: { type: String, required: false, default: null } },
    template: "<div class='tf-stub' :data-sid='sessionId' />",
  },
}));


import PaneLayout from "../PaneLayout.vue";
import { usePaneLayout, __resetPaneLayoutForTest } from "@/composables/usePaneLayout";
import { __resetKbSelectionsForTest, useKbSelections } from "@/composables/useKbSelections";
import { useProviders } from "@/composables/useProviders";

function pendingKbRecord() {
  const k = useKbSelections();
  const rec = k.begin({
    documentId: "doc-1", title: "发布流程", baseVersion: 3, baseContent: "出现故障时先切流量到旧版本再排查。",
    scope: { start: 6, end: 13, text: "切流量到旧版本", lineStart: 1, lineEnd: 1, precise: true },
  });
  k.confirm(rec.ref.selectionId, "写具体些");
  return { k, id: rec.ref.selectionId };
}
async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await nextTick();
  }
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

function mountLayout() {
  return mount(PaneLayout, { props: { workspacePath: "C:/repo" }, global: { directives: { tooltip: () => {} } } });
}
function noDrift(api: { sessionIdentityDrift: unknown }) {
  api.sessionIdentityDrift = vi.fn(async () => ({ providerDrift: false, modelDrift: false, lastProvider: null, lastModel: null }));
}

describe("整条链路：知识库里点「交给 AI」→ 真实窗格布局 → 发出 send_message", () => {
  beforeEach(async () => {
    __resetPaneLayoutForTest();
    __resetKbSelectionsForTest();
    sendMessageMock.mockClear();
    sessionProviderMock.mockImplementation(async () => "p_test");
    sessionModelMock.mockImplementation(async () => "kimi");
    noDrift((await import("@aide/sdk/api")).api as unknown as { sessionIdentityDrift: unknown });
  });

  it("有会话 tab：圈选被发出（sendMessage 带 kbref 的 display 与展开文本），状态变 sent", async () => {
    usePaneLayout().openSession("uuid-a");
    const w = mountLayout();
    await settle();
    const { k, id } = pendingKbRecord();
    k.requestSend("");
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const p = sendMessageMock.mock.calls[0]![0] as { prompt: string; display: { type: string }[] };
    expect(p.prompt).toContain("知识库选区");
    expect(p.display.map((b) => b.type)).toContain("kbref");
    expect(k.records[id]!.status).toBe("sent");
    w.unmount();
  });

  it("一个会话 tab 都没有（欢迎态）：照样发出，并自动新建会话承接", async () => {
    const pl = usePaneLayout(); // beforeEach 已重置布局：零 tab = 真·欢迎态
    const w = mountLayout();
    await settle();
    const { k, id } = pendingKbRecord();
    k.requestSend("");
    await settle();
    // eslint-disable-next-line no-console
    console.log("hero: status", k.records[id]?.status, "send calls", sendMessageMock.mock.calls.length, "tabs", JSON.stringify(pl.layout.root));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(k.records[id]!.status).toBe("sent");
    w.unmount();
  });
});
