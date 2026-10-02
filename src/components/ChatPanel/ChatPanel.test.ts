// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { __resetKbSelectionsForTest, useKbSelections } from "@/composables/useKbSelections";
import type { ProviderConfig, ProviderModelMappings } from "@/types";

// ── Tauri（useChatSession 模块级 import 需要）──
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

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
vi.mock("../../composables/useModal", () => ({ useModal: () => ({ confirm: vi.fn(async () => true), choice: vi.fn(async () => "cancel"), notice: vi.fn(async () => undefined) }) }));
vi.mock("../../composables/useToast", () => ({ useToast: () => ({ toastState: { visible: false, text: "", kind: "info" }, showToast: showToastMock }) }));
vi.mock("../../composables/useMentionInserter", () => ({ useMentionInserter: () => ({ pending: { value: null }, insertMention: vi.fn(), consumeMention: vi.fn() }) }));
vi.mock("../../composables/useInlineMention", () => ({ useInlineMention: () => ({ onInput: vi.fn(), scan: vi.fn() }) }));
vi.mock("../../composables/useChatPaneWidth", () => ({ setChatPaneRect: vi.fn() }));
vi.mock("../../composables/useFileClipboard", () => ({ peekFileClipboard: () => null, clearFileClipboard: vi.fn() }));
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

import ChatPanel from "./ChatPanel.vue";
import { TURN_CHANGES_KEY } from "./turnChanges";
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
    permissionModes: [{ value: "auto", displayName: "自动模式" }],
    currentPermissionMode: "auto",
    focused: true,
    // 子代理 dock 的数据源（PaneGroup 恒传）——不传会触发「缺少必需 prop」告警
    subagents: [],
    subagentDockOpen: false,
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
/** 取 effort ThemedSelect 组件本身（用户手选档位 = 给它 emit update:modelValue）。 */
function effortStubOf(wrapper: VueWrapper) {
  const stubs = wrapper.findAllComponents({ name: "ThemedSelect" });
  return stubs.find((s) => typeof s.props("title") === "string" && (s.props("title") as string).startsWith("effort"));
}
function effortValueOf(wrapper: VueWrapper): string {
  return (effortStubOf(wrapper)?.props("modelValue") as string) ?? "";
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

  it("权限模式：两会话 currentPermissionMode 同值（都 auto），A 用户改下拉到 manual 后切 B，B 显示 auto 不串", async () => {
    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentPermissionMode: "auto" }) });
    await flush()
    // 模拟用户在 A 把下拉改成 manual（selectedPermissionMode 本地值）
    const permStub = wrapper.findAllComponents({ name: "ThemedSelect" }).find((s) => s.props("title") === "权限模式");
    permStub?.vm.$emit("update:modelValue", "manual");
    await nextTick();
    expect(permValueOf(wrapper)).toBe("manual");

    // 切到 B：B 的 currentPermissionMode 也是 auto（同值，currentPermissionMode watcher 不触发）
    await wrapper.setProps({ sessionId: "B", currentPermissionMode: "auto" });
    await flush()
    // 修复后 sessionId watcher 每次切换都重置 → 从 B 的 currentPermissionMode 落 auto
    expect(permValueOf(wrapper)).toBe("auto");

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

  it("发送门控改为供应商+模型两维：同会话切换模型后发送会弹确认（2026-09-08 修订；模型维度的「上次发送基线对比」现仅用于发送门控）", async () => {
    // drift mock 反映「基线 kimi，用户切换 deepseek」：供应商维度无漂移（都 p_test），
    // 模型维度漂移。基线侧 last=null/lastModel="kimi"——盘上只记了模型没记供应商的
    // 老数据场景，验证 dialog 文案不再出现「未记录」。
    const driftMock = vi.fn(async () => ({
      providerDrift: false,
      modelDrift: true,
      lastProvider: null,
      lastModel: "kimi",
    }));
    const api = (await import("@aide/sdk/api")).api as unknown as {
      sessionIdentityDrift: typeof driftMock;
    };
    api.sessionIdentityDrift = driftMock;

    sessionProviderMock.mockImplementation(async () => "p_test");
    sessionModelMock.mockImplementation(async () => "kimi");
    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentModel: "haiku", isBusy: false }) });
    await flush();
    expect(modelValueOf(wrapper)).toBe("kimi"); // 恢复身份

    // 用户切换模型到 deepseek：仅模型漂移，弹「模型变更」确认形态
    const modelStub = wrapper.findAllComponents({ name: "ThemedSelect" }).find((s) => s.props("title") === "模型");
    modelStub?.vm.$emit("update:modelValue", "deepseek");
    await nextTick();
    expect(modelValueOf(wrapper)).toBe("deepseek");

    await wrapper.find("textarea").setValue("hello");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    await flush();
    expect(wrapper.emitted("send")).toBeFalsy(); // 门控拦截，尚未真发
    const pd = wrapper.findComponent({ name: "PermissionDialog" });
    const input = (pd?.props("permission") as { input: { title: string; chip: string; question: string; info: string } } | null)?.input;
    expect(input?.name === undefined || true).toBe(true); // 形状断言在下
    expect(pd?.props("permission") as { name: string } | null).toMatchObject({ name: "__sendConfirm__" });
    expect(input).toMatchObject({
      chip: "模型变更",
      // 旧实现会渲染 "原 未记录/kimi"——自相矛盾。新规则 providerDrift=false ⟹ 旧供应商取当前
      question: "将以 p_test/deepseek 发送（原 p_test/kimi）",
      info: "供应商仍是 p_test，仅模型由 kimi 改为 deepseek。确认后模型选择会写入会话记录。",
    });

    wrapper.unmount();
  });
});

describe("ChatPanel · 知识库圈选发送遇到「发送前确认」（回归：一直停在待发送）", () => {
  async function setupDrift() {
    const driftMock = vi.fn(async () => ({ providerDrift: false, modelDrift: true, lastProvider: null, lastModel: "kimi" }));
    const api = (await import("@aide/sdk/api")).api as unknown as { sessionIdentityDrift: typeof driftMock };
    api.sessionIdentityDrift = driftMock;
    sessionProviderMock.mockImplementation(async () => "p_test");
    sessionModelMock.mockImplementation(async () => "kimi");
    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentModel: "haiku", isBusy: false }) });
    await flush();
    // 用户在聊天里换过模型 → 下一次发送会触发「模型变更」确认
    const modelStub = wrapper.findAllComponents({ name: "ThemedSelect" }).find((s) => s.props("title") === "模型");
    modelStub?.vm.$emit("update:modelValue", "deepseek");
    await nextTick();
    return wrapper;
  }
  function pendingKbRecord() {
    const k = useKbSelections();
    const rec = k.begin({
      documentId: "doc-1", title: "发布流程", baseVersion: 3, baseContent: "出现故障时先切流量到旧版本再排查。",
      scope: { start: 6, end: 13, text: "切流量到旧版本", lineStart: 1, lineEnd: 1, precise: true },
    });
    k.confirm(rec.ref.selectionId, "写具体些");
    return { k, id: rec.ref.selectionId };
  }

  it("文档侧发送被确认门拦下：确认框画在聊天里，此时圈选仍是待发送；并且请求「把聊天亮出来」", async () => {
    __resetKbSelectionsForTest();
    const wrapper = await setupDrift();
    const { k, id } = pendingKbRecord();
    const before = k.chatRequest.value?.nonce ?? 0;
    k.requestSend("");
    await flush();
    expect(wrapper.emitted("send")).toBeFalsy();
    expect(wrapper.findComponent({ name: "PermissionDialog" }).props("permission")).toMatchObject({ name: "__sendConfirm__" });
    expect(k.records[id]!.status).toBe("pending");
    // 知识库打开时聊天面板是隐藏的——不亮出来，用户永远看不到这个确认框
    expect(k.chatRequest.value?.nonce).toBe(before + 1);
    wrapper.unmount();
  });

  it("没有门控时（模型没变）直接发出，不打扰：不请求亮出聊天", async () => {
    __resetKbSelectionsForTest();
    // 显式声明「没有漂移」：同文件里别的用例会把这个桩改成有漂移，不能依赖默认
    const api = (await import("@aide/sdk/api")).api as unknown as { sessionIdentityDrift: unknown };
    api.sessionIdentityDrift = vi.fn(async () => ({ providerDrift: false, modelDrift: false, lastProvider: null, lastModel: null }));
    sessionProviderMock.mockImplementation(async () => "p_test");
    sessionModelMock.mockImplementation(async () => "kimi");
    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentModel: "haiku", isBusy: false }) });
    await flush();
    const { k } = pendingKbRecord();
    const before = k.chatRequest.value?.nonce ?? 0;
    k.requestSend("");
    await flush();
    expect(wrapper.emitted("send")).toBeTruthy();
    expect(k.chatRequest.value?.nonce ?? 0).toBe(before);
    wrapper.unmount();
  });
});

describe("ChatPanel — 允许并记住上下文（usePermissionRememberContext 接线）", () => {
  const localScope = { scope: "local", editable: true, reason: "", storagePath: null, description: "" };
  const viewWith = (rules: unknown[]) => ({ revision: 1, scopes: [localScope], rules });
  const allowRuleBash = (value: string) => ({
    id: `r-${value}`,
    scope: "local",
    order: 0,
    effect: "allow",
    tool: "Bash",
    matcher: { kind: "bash", mode: "prefix", value },
    source: { label: "test", readOnly: false },
  });
  const chainPermission = () => ({
    id: "p1",
    name: "Bash",
    input: { command: 'cd "C:/x" && cargo check 2>&1 | tail -30' },
  });

  /** mount + flush 到快照就绪。 */
  async function mountWithPermission() {
    const wrapper = mount(ChatPanel, {
      props: baseProps({ permission: chainPermission(), workspacePath: "C:/ws" }),
    });
    await flush();
    return wrapper;
  }

  beforeEach(() => {
    permGetMock.mockReset().mockImplementation(async () => viewWith([allowRuleBash("cd"), allowRuleBash("tail")]));
    permCreateManyMock.mockReset().mockImplementation(async () => viewWith([]));
    showToastMock.mockClear();
  });

  it("权限请求挂起 → 快照就绪，弹窗收到 ready 上下文（rules 透传、scope=local）", async () => {
    const wrapper = await mountWithPermission();
    const ctx = wrapper.findComponent({ name: "PermissionDialog" }).props("rememberContext");
    expect(ctx).toEqual({
      status: "ready",
      rules: [allowRuleBash("cd"), allowRuleBash("tail")],
      scope: "local",
    });
    wrapper.unmount();
  });

  it("点「允许并记住」：预览只列未覆盖段（cargo check），createMany 收到该段 + 成功 toast", async () => {
    const wrapper = await mountWithPermission();
    // 预览行：cd/tail 已被宽规则覆盖 → 只剩 cargo check 一行
    const inputs = wrapper.findAll(".perm-remember-value");
    expect(inputs).toHaveLength(1);
    expect((inputs[0].element as HTMLInputElement).value).toBe("cargo check");

    await wrapper.get('[data-action="remember"]').trigger("click");
    await flush();

    // 落盘前现拉（get 共两次：快照 1 + persist 1），写入钉在弹窗会话工作区
    expect(permGetMock).toHaveBeenCalledTimes(2);
    expect(permCreateManyMock).toHaveBeenCalledWith(
      "local",
      [
        {
          effect: "allow",
          tool: "Bash",
          matcher: { kind: "bash", mode: "prefix", value: "cargo check" },
        },
      ],
      "C:/ws",
    );
    expect(showToastMock).toHaveBeenCalledWith(
      expect.stringContaining("已记住到本项目本地"),
      "success",
    );
    wrapper.unmount();
  });

  it("挂起期间规则库新增等价规则 → 落盘时现拉发现已覆盖：不写入 + 无需重复记住 toast", async () => {
    // get#1（弹窗快照）：库里有 cd/tail 宽规则 → 预览只剩 cargo check；
    // get#2（persist 现拉）：挂起期间别处已写入 cargo check 等价规则 → all-covered
    let call = 0;
    permGetMock.mockImplementation(async () => {
      call++;
      const base = [allowRuleBash("cd"), allowRuleBash("tail")];
      return viewWith(call === 1 ? base : [...base, allowRuleBash("cargo check")]);
    });
    const wrapper = await mountWithPermission();
    expect(wrapper.findAll(".perm-remember-value")).toHaveLength(1);

    await wrapper.get('[data-action="remember"]').trigger("click");
    await flush();

    expect(permGetMock).toHaveBeenCalledTimes(2);
    expect(permCreateManyMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith("现有规则已放行同类调用，无需重复记住", "success");
    wrapper.unmount();
  });
});

describe("ChatPanel — 档位跟随模式（日常 / 工程）", () => {
  beforeEach(() => {
    sessionModelMock.mockReset();
    sessionProviderMock.mockReset();
    sessionModelMock.mockResolvedValue(null);
    sessionProviderMock.mockResolvedValue(null);
    const { providers, setProvider } = useSessionProviders();
    for (const k of Object.keys(providers)) delete providers[k];
    setProvider("A", "p_test");
    setProvider("B", "p_test");
    const prov = useProviders();
    prov.__resetForTest();
    // 实机配置同款：活动供应商 effortLevel=MAX → provider 默认档位是「极致」
    prov.allProviders.value = [{ ...PROVIDER_P, effortLevel: "MAX" }];
    prov.activeProviderId.value = "p_test";
  });

  it("零 tab 欢迎态：日常默认「快速」，切到工程落回 provider 默认「极致」（此前停在快速），来回切对称", async () => {
    const wrapper = mount(ChatPanel, { props: baseProps({ mode: "daily" }) });
    await flush();
    expect(effortValueOf(wrapper)).toBe("low");

    await wrapper.setProps({ mode: "project" });
    await flush();
    expect(effortValueOf(wrapper)).toBe("max");

    await wrapper.setProps({ mode: "daily" });
    await flush();
    expect(effortValueOf(wrapper)).toBe("low");

    wrapper.unmount();
  });

  it("hero 上手选过档位，切模式仍按模式重算（pre-send 语境，模式赢）", async () => {
    const wrapper = mount(ChatPanel, { props: baseProps({ mode: "daily" }) });
    await flush();
    effortStubOf(wrapper)?.vm.$emit("update:modelValue", "max");
    await nextTick();
    expect(effortValueOf(wrapper)).toBe("max");

    await wrapper.setProps({ mode: "project" });
    await flush();
    // 工程默认也是 max（provider 配置），换一条反向路径验：日常把它按回 low
    await wrapper.setProps({ mode: "daily" });
    await flush();
    expect(effortValueOf(wrapper)).toBe("low");

    wrapper.unmount();
  });

  it("存活会话不归模式管：mode 变化不覆盖会话坐实的 currentEffort", async () => {
    sessionProviderMock.mockImplementation(async () => "p_test");
    const wrapper = mount(ChatPanel, { props: baseProps({ sessionId: "A", currentEffort: "max" }) });
    await flush();
    expect(effortValueOf(wrapper)).toBe("max");

    await wrapper.setProps({ mode: "daily" });
    await flush();
    expect(effortValueOf(wrapper)).toBe("max");

    wrapper.unmount();
  });
});

describe("ChatPanel — 回合结算卡的接线", () => {
  const feed = { sid: "s1", rounds: [], revertSingleFile: async () => {} };

  it("没有 feed（非桌面宿主 / 测试）→ 整块不渲染", () => {
    const w = mount(ChatPanel, { props: baseProps({ sessionId: "s1" }) });
    expect(w.find(".tf-stub").exists()).toBe(false);
  });

  it("注入了 feed → 渲染在消息流行末，并把 feed 与本面板会话一起交给卡片", () => {
    const w = mount(ChatPanel, {
      props: baseProps({ sessionId: "s1" }),
      global: { provide: { [TURN_CHANGES_KEY]: ref(feed) } },
    });
    const stub = w.get(".tf-stub");
    expect(stub.attributes("data-sid")).toBe("s1");
    expect(w.findComponent({ name: "TurnChangeCard" }).props("feed")).toEqual(feed);
    // 位置：消息流行末（v-for 之后、内容盒之内）
    expect(w.get(".chat-messages-body").element.lastElementChild?.classList.contains("tf-stub")).toBe(true);
  });
});