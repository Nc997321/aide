// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import type { ProviderConfig, ProviderModelMappings } from "@/types";

// ── Tauri（useChatSession 模块级 import 需要）──
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

// ── api mock：sessionModel/sessionProvider 受控；其余方法返回安全默认 ──
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
vi.mock("@/api", () => ({
  api: new Proxy(
    {
      sessionModel: (id: string) => sessionModelMock(id),
      sessionProvider: (id: string) => sessionProviderMock(id),
      setSessionModel: vi.fn(async () => undefined),
      setSessionProvider: vi.fn(async () => undefined),
      sessionEffort: vi.fn(async () => null),
      setSessionEffort: vi.fn(async () => undefined),
      getDefaultModels: vi.fn(async () => []),
      getDefaultPermissionModes: vi.fn(async () => [{ value: "default", displayName: "默认" }]),
      scanPluginSkills: vi.fn(async () => []),
      readFileContent: vi.fn(async () => ""),
    },
    { get: (t, k) => (typeof k === "string" && k in t ? (t as Record<string, unknown>)[k] : vi.fn(async () => undefined)) },
  ),
}));
vi.mock("@/api/permissions", () => ({
  permissionsApi: { get: vi.fn(async () => ({ scopes: [], rules: [] })) },
}));
vi.mock("../../utils/diagnostics/scrollTrail", () => ({ trail: vi.fn(), snapshotScrollTrail: vi.fn() }));

// ── 其余 composable stub（ChatPanel onMounted/watch 依赖）──
vi.mock("../../composables/useChatScroll", () => ({
  useChatScroll: () => ({
    scrollEl: null, contentEl: null, visibleMessages: [], hiddenCount: 0,
    ramping: false, onScroll: vi.fn(), jumpToBottom: vi.fn(), farFromBottom: false,
    newWhileAway: false, expandOlderAnchored: vi.fn(),
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
vi.mock("../../composables/useModal", () => ({ useModal: () => ({ confirm: vi.fn(async () => true), choice: vi.fn(async () => "cancel"), notice: vi.fn(async () => undefined) }) }));
vi.mock("../../composables/useToast", () => ({ useToast: () => ({ toastState: { visible: false, text: "", kind: "info" }, showToast: vi.fn() }) }));
vi.mock("../../composables/useMentionInserter", () => ({ useMentionInserter: () => ({ pending: { value: null }, insertMention: vi.fn(), consumeMention: vi.fn() }) }));
vi.mock("../../composables/useInlineMention", () => ({ useInlineMention: () => ({ onInput: vi.fn(), scan: vi.fn() }) }));
vi.mock("../../composables/useChatPaneWidth", () => ({ setChatPaneRect: vi.fn() }));
vi.mock("../../composables/useFileClipboard", () => ({ peekFileClipboard: () => null, clearFileClipboard: vi.fn() }));
// AppLogo 导入 /icon.png（vite 公共资源）在 jsdom 下会崩，stub 掉。
vi.mock("../AppLogo.vue", () => ({ default: { name: "AppLogo", template: "<div class='app-logo-stub' />" } }));

import ChatPanel from "./ChatPanel.vue";
import { useSessionProviders } from "../../composables/useSessionProviders";
import { useProviders } from "../../composables/useProviders";

const emptyMappings = (): ProviderModelMappings => ({
  anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "",
});
function makeProvider(id: string, model: string, knownModels: string[]): ProviderConfig {
  return {
    id, kind: "custom", name: id, icon: "provider", baseUrl: "",
    apiKeyConfigured: false, authTokenConfigured: false, model, modelMappings: emptyMappings(),
    effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", maxContextTokens: "", knownModels,
  };
}
const PROVIDER_P = makeProvider("p_test", "kimi", ["kimi", "deepseek"]);

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: null,
    messages: [],
    isBusy: false,
    models: [],
    currentModel: "",
    currentEffort: "",
    permissionModes: [{ value: "default", displayName: "默认" }],
    currentPermissionMode: "default",
    focused: true,
    ...overrides,
  };
}

/** 让 watcher 的 async restore（refreshLastUsed/restoreBinding await api）跑完。 */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

/** 取模型 ThemedSelect 的 modelValue（按 title="模型" 区分三个下拉）。 */
function modelValueOf(wrapper: VueWrapper): string {
  const stubs = wrapper.findAllComponents({ name: "ThemedSelect" });
  const model = stubs.find((s) => s.props("title") === "模型");
  return (model?.props("modelValue") as string) ?? "";
}
function permValueOf(wrapper: VueWrapper): string {
  const stubs = wrapper.findAllComponents({ name: "ThemedSelect" });
  const perm = stubs.find((s) => s.props("title") === "权限模式");
  return (perm?.props("modelValue") as string) ?? "";
}
function effortValueOf(wrapper: VueWrapper): string {
  const stubs = wrapper.findAllComponents({ name: "ThemedSelect" });
  const eff = stubs.find((s) => typeof s.props("title") === "string" && (s.props("title") as string).startsWith("effort"));
  return (eff?.props("modelValue") as string) ?? "";
}

describe("ChatPanel 跨会话串修复", () => {
  beforeEach(() => {
    sessionModelMock.mockReset();
    sessionProviderMock.mockReset();
    // 默认返回 null（无持久化），用例可 override；避免 api.sessionProvider() 返回 undefined 炸 .catch
    sessionModelMock.mockResolvedValue(null);
    sessionProviderMock.mockResolvedValue(null);
    // 清 useSessionProviders / useProviders 模块级单例
    const { providers, setProvider } = useSessionProviders();
    for (const k of Object.keys(providers)) delete providers[k];
    setProvider("A", "p_test");
    setProvider("B", "p_test");
    const prov = useProviders();
    prov.__resetForTest();
    prov.allProviders.value = [PROVIDER_P];
    prov.activeProviderId.value = "p_test";
  });

  it("模型：同供应商两个存活会话（currentModel 都是 Claude 别名，不在真实列表），切 A→B 显示 B 的 remembered，不串 A", async () => {
    sessionProviderMock.mockImplementation(async () => "p_test");
    sessionModelMock.mockImplementation(async (id) => (id === "A" ? "kimi" : id === "B" ? "deepseek" : null));

    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentModel: "haiku" }) });
    await flush()
    expect(modelValueOf(wrapper)).toBe("kimi"); // A 的 remembered

    await wrapper.setProps({ sessionId: "B", currentModel: "haiku" });
    await flush()
    // 关键：旧实现把 A 的 "kimi" 当 existing 留下（跨会话串）；修复后恢复 B 的 "deepseek"
    expect(modelValueOf(wrapper)).toBe("deepseek");

    wrapper.unmount();
  });

  it("权限模式：两会话 currentPermissionMode 同值（都 default），A 用户改下拉到 acceptEdits 后切 B，B 显示 default 不串", async () => {
    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentPermissionMode: "default" }) });
    await flush()
    // 模拟用户在 A 把下拉改成 acceptEdits（selectedPermissionMode 本地值）
    const permStub = wrapper.findAllComponents({ name: "ThemedSelect" }).find((s) => s.props("title") === "权限模式");
    permStub?.vm.$emit("update:modelValue", "acceptEdits");
    await nextTick();
    expect(permValueOf(wrapper)).toBe("acceptEdits");

    // 切到 B：B 的 currentPermissionMode 也是 default（同值，currentPermissionMode watcher 不触发）
    await wrapper.setProps({ sessionId: "B", currentPermissionMode: "default" });
    await flush()
    // 修复后 sessionId watcher 每次切换都重置 → 从 B 的 currentPermissionMode 落 default
    expect(permValueOf(wrapper)).toBe("default");

    wrapper.unmount();
  });

  it("effort：A 存活 currentEffort=max，B 存活 currentEffort=low（未持久化），切 B 显示 low，不串 A 的 max 也不退 providerDefault", async () => {
    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentEffort: "max" }) });
    await flush()
    expect(effortValueOf(wrapper)).toBe("max");

    await wrapper.setProps({ sessionId: "B", currentEffort: "low" });
    await flush()
    expect(effortValueOf(wrapper)).toBe("low");

    wrapper.unmount();
  });

  it("发送前确认：waiting 会话（isBusy=false）切换模型后发送 → 弹确认、不直接发；同模型发送不弹", async () => {
    sessionProviderMock.mockImplementation(async () => "p_test");
    sessionModelMock.mockImplementation(async () => "kimi"); // lastUsed = kimi
    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentModel: "haiku", isBusy: false }) });
    await flush();
    expect(modelValueOf(wrapper)).toBe("kimi"); // 恢复 lastUsed

    // 用户切换模型到 deepseek
    const modelStub = wrapper.findAllComponents({ name: "ThemedSelect" }).find((s) => s.props("title") === "模型");
    modelStub?.vm.$emit("update:modelValue", "deepseek");
    await nextTick();
    expect(modelValueOf(wrapper)).toBe("deepseek");

    // 输入并发送
    await wrapper.find("textarea").setValue("hello");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    await flush();

    // 门控触发：send 未发出；PermissionDialog 显示 __sendConfirm__ 确认形态
    expect(wrapper.emitted("send")).toBeUndefined();
    const permDialog = wrapper.findComponent({ name: "PermissionDialog" });
    const perm = permDialog?.props("permission") as { name: string } | null;
    expect(perm?.name).toBe("__sendConfirm__");

    // 点「继续发送」→ 才真正发送；PermissionDialog 回传的 id 必须匹配 sendConfirm.request.id
    await wrapper.find("button.perm-btn--solid").trigger("click");
    await flush();
    expect(wrapper.emitted("send")).toBeTruthy();
    const sendArgs = wrapper.emitted("send")![0];
    expect(sendArgs[0]).toBe("hello"); // 原始 prompt
    // 确认形态已关闭（displayedPermission 不再是 __sendConfirm__）
    const pdAfter = wrapper.findComponent({ name: "PermissionDialog" });
    expect((pdAfter?.props("permission") as { name: string } | null)?.name).not.toBe("__sendConfirm__");

    // 同模型再发不弹：取消确认后把 selectedModel 维持 deepseek、noteSent 未推进前，再发仍弹；
    // 这里验证「未切换」场景——重新 mount 一个会话，selectedModel==lastUsed 时发送不弹。
    wrapper.unmount();
    sessionModelMock.mockImplementation(async () => "deepseek"); // lastUsed = deepseek
    const w2 = mount(ChatPanel, { props: baseProps({ sessionId: "C", currentModel: "haiku", isBusy: false }) });
    await flush();
    expect(modelValueOf(w2)).toBe("deepseek"); // lastUsed=deepseek
    await w2.find("textarea").setValue("hello");
    await w2.find("textarea").trigger("keydown", { key: "Enter" });
    await flush();
    // selectedModel == lastUsed → needsConfirm false → 直接发（send 已 emit），无确认
    expect(w2.emitted("send")).toBeTruthy();
    const pd2 = w2.findComponent({ name: "PermissionDialog" });
    expect((pd2?.props("permission") as { name: string } | null)?.name).not.toBe("__sendConfirm__");
    w2.unmount();
  });
});