import { describe, it, expect, vi, beforeEach } from "vitest";
import { useProviders } from "@/composables/useProviders";
import { useSessionProviders } from "@/composables/useSessionProviders";
import type { ProviderConfig, ProviderModelMappings } from "@/types";
import type { ModelOption } from "@/types/chat";

// ── api mock：sessionProvider/sessionModel 读受控；setSession* 记录写回；getDefaultModels 系统默认兜底列表 ──
const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();
const setSessionProviderMock = vi.fn<(id: string, provider: string) => Promise<void>>();
const setSessionModelMock = vi.fn<(id: string, model: string) => Promise<void>>();
const getDefaultModelsMock = vi.fn<() => Promise<ModelOption[]>>();

vi.mock("@/api", () => ({
  api: {
    sessionProvider: (id: string) => sessionProviderMock(id),
    sessionModel: (id: string) => sessionModelMock(id),
    setSessionProvider: (id: string, provider: string) => setSessionProviderMock(id, provider),
    setSessionModel: (id: string, model: string) => setSessionModelMock(id, model),
    getDefaultModels: () => getDefaultModelsMock(),
  },
}));

import { useSessionIdentity } from "./useSessionIdentity";

const emptyMappings = (): ProviderModelMappings => ({
  anthropicModel: "",
  defaultOpusModel: "",
  defaultSonnetModel: "",
  defaultHaikuModel: "",
  subagent: "",
});

function makeProvider(id: string, model = `${id}-default`, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    kind: "custom",
    name: id,
    icon: "p",
    baseUrl: "",
    apiKeyConfigured: false,
    authTokenConfigured: false,
    model,
    modelMappings: emptyMappings(),
    effortLevel: "",
    autoCompactWindow: "",
    autocompactPctOverride: "",
    maxContextTokens: "",
    knownModels: [],
    ...extra,
  };
}

describe("useSessionIdentity (L2 identity)", () => {
  const { allProviders, activeProviderId } = useProviders();
  const { providers } = useSessionProviders();
  let id: ReturnType<typeof useSessionIdentity>;

  beforeEach(() => {
    sessionProviderMock.mockReset();
    sessionModelMock.mockReset();
    setSessionProviderMock.mockReset();
    setSessionModelMock.mockReset();
    getDefaultModelsMock.mockReset();
    setSessionProviderMock.mockResolvedValue(undefined);
    setSessionModelMock.mockResolvedValue(undefined);
    getDefaultModelsMock.mockResolvedValue([]);
    for (const k of Object.keys(providers)) delete providers[k];
    id = useSessionIdentity();
    id.__resetIdentityForTest();
  });

  describe("resolve 慢路径（无内存绑定）", () => {
    it("provider 仍在 + 模型可信 → setProvider 恢复，不写回", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(setSessionProviderMock).not.toHaveBeenCalled();
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "kimi" });
    });

    it("provider 被删但模型反查命中 → 修正绑定 + self-heal 写回", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_deleted");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(setSessionProviderMock).toHaveBeenCalledWith("s1", "p_a");
    });

    it("provider 被删且模型反查无果 → 回落 activeProvider", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_deleted");
      sessionModelMock.mockResolvedValue("unknown-model");
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
    });

    it("污染特征（provider 被盖写、model 是原供应商的）→ 按模型修正 + self-heal", async () => {
      allProviders.value = [makeProvider("p_a", "kimi"), makeProvider("p_b", "deepseek")];
      activeProviderId.value = "p_b";
      sessionProviderMock.mockResolvedValue("p_b");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(setSessionProviderMock).toHaveBeenCalledWith("s1", "p_a");
    });

    it("self-heal 写盘失败 → console.warn 降级，仍修正绑定", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      sessionProviderMock.mockResolvedValue("p_deleted");
      sessionModelMock.mockResolvedValue("kimi");
      setSessionProviderMock.mockRejectedValueOnce(new Error("disk full"));
      await id.resolve("s1");
      expect(warnSpy).toHaveBeenCalledWith(
        "[sessionIdentity] self-heal provider failed:",
        "s1",
        "p_a",
        expect.any(Error),
      );
      expect(id.providerOf("s1")).toBe("p_a");
      warnSpy.mockRestore();
    });

    it("readSessionMeta null（全新会话无元数据）→ 回落 activeProvider", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue(null);
      sessionModelMock.mockResolvedValue(null);
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "kimi" });
    });
  });

  describe("resolve 快路径（有内存绑定）", () => {
    it("有绑定 → 不调 setProvider，只刷基线", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValueOnce("p_a");
      sessionModelMock.mockResolvedValueOnce("kimi");
      await id.resolve("s1");
      setSessionProviderMock.mockClear();
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(setSessionProviderMock).not.toHaveBeenCalled();
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "kimi" });
    });
  });

  describe("settleOnSend（落盘 = 基线同源）", () => {
    it("无绑定 → setProvider + 落盘 + 推进基线，三者同源", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      await id.settleOnSend("s1", { provider: "p_a", model: "kimi" });
      expect(id.providerOf("s1")).toBe("p_a");
      expect(setSessionProviderMock).toHaveBeenCalledWith("s1", "p_a");
      expect(setSessionModelMock).toHaveBeenCalledWith("s1", "kimi");
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "kimi" });
    });

    it("已有绑定 → 仍落盘 model + 推进基线（注册表由 if(!providerOf) 保护不覆盖）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValueOnce("p_a");
      sessionModelMock.mockResolvedValueOnce("kimi");
      await id.resolve("s1");
      setSessionProviderMock.mockClear();
      setSessionModelMock.mockClear();
      await id.settleOnSend("s1", { provider: "p_a", model: "new-model" });
      expect(setSessionModelMock).toHaveBeenCalledWith("s1", "new-model");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "new-model" });
    });

    it("model 为空 + 盘已有 model → 落盘空串（删字段）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      await id.settleOnSend("s1", { provider: "p_a", model: "kimi" }); // 盘建 model
      setSessionModelMock.mockClear();
      await id.settleOnSend("s1", { provider: "p_a", model: "" }); // model 变 kimi → ""（删）
      expect(setSessionModelMock).toHaveBeenCalledWith("s1", "");
    });

    it("provider+model 都没变 → 跳过 IPC（省冗余写）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      await id.settleOnSend("s1", { provider: "p_a", model: "kimi" });
      setSessionProviderMock.mockClear();
      setSessionModelMock.mockClear();
      await id.settleOnSend("s1", { provider: "p_a", model: "kimi" });
      expect(setSessionProviderMock).not.toHaveBeenCalled();
      expect(setSessionModelMock).not.toHaveBeenCalled();
    });

    it("首次 + model 空 → 只写 provider（model 盘无，删=no-op）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      await id.settleOnSend("s1", { provider: "p_a", model: "" });
      expect(setSessionProviderMock).toHaveBeenCalledWith("s1", "p_a");
      expect(setSessionModelMock).not.toHaveBeenCalled();
    });

    it("落盘失败 → console.warn 降级，基线照常推进", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setSessionModelMock.mockRejectedValueOnce(new Error("disk full"));
      await id.settleOnSend("s1", { provider: "p_a", model: "kimi" });
      expect(warnSpy).toHaveBeenCalledWith(
        "[sessionIdentity] settleOnSend persist failed:",
        "s1",
        expect.any(Error),
      );
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "kimi" });
      // 失败后绑定已建立（空绑定，meta 保持盘上状态）→ 后续 resolve 走快路径不崩（不变式回归）
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "kimi" });
      warnSpy.mockRestore();
    });

    it("落盘失败但 binding 已存在 → 不覆写（runtimeModel 等保持）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "runtime"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      id.bindRuntime("s1", "runtime");
      setSessionModelMock.mockRejectedValueOnce(new Error("disk full"));
      await id.settleOnSend("s1", { provider: "p_a", model: "new-model" }); // model 变 → 进 try → catch（落盘失败）
      expect(id.effectiveModel.value).toBe("runtime"); // binding 未覆写，runtimeModel 保持
    });
  });

  describe("effectiveModel 兜底链（本次 bug 回归）", () => {
    it("p.model='' + anthropicModel='deepseek-v4-flash:0731-cloud' → effectiveModel 该值", async () => {
      allProviders.value = [
        makeProvider("p_a", "", { modelMappings: { ...emptyMappings(), anthropicModel: "deepseek-v4-flash:0731-cloud" } }),
      ];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue(null);
      await id.resolve("s1");
      expect(id.effectiveModel.value).toBe("deepseek-v4-flash:0731-cloud");
    });

    it("draft 在列表 → 优先于 runtime/restored", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "user-picked", "runtime-model"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      id.setUserChoice("user-picked");
      id.bindRuntime("s1", "runtime-model");
      expect(id.effectiveModel.value).toBe("user-picked");
    });

    it("runtime 在列表 → 优先于 restored（draft 空/不在列表）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "runtime-model"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      id.bindRuntime("s1", "runtime-model");
      expect(id.effectiveModel.value).toBe("runtime-model");
    });

    it("runtime 别名不在列表 → 跳过用 restored（不污染下拉）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      id.bindRuntime("s1", "sonnet");
      expect(id.effectiveModel.value).toBe("kimi");
    });

    it("全空 provider（无 model/mappings/knownModels）→ effectiveModel=''", async () => {
      allProviders.value = [makeProvider("p_a", "")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue(null);
      await id.resolve("s1");
      expect(id.effectiveModel.value).toBe("");
    });
  });

  describe("lastIdentity=null → 门控不误弹（本次 bug 回归）", () => {
    it("resolve 前 lastIdentity=null（无基线）", () => {
      expect(id.lastIdentity.value).toBeNull();
    });
  });

  describe("bindRuntime / setUserChoice / releaseBinding / migrateBinding / clearCurrent", () => {
    it("bindRuntime 坐实 runtimeModel（在列表），不落盘", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "sidecar-current"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      setSessionModelMock.mockClear();
      id.bindRuntime("s1", "sidecar-current");
      expect(id.effectiveModel.value).toBe("sidecar-current");
      expect(setSessionModelMock).not.toHaveBeenCalled();
    });

    it("setUserChoice 草稿（在列表），不落盘", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "draft-model"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      setSessionModelMock.mockClear();
      id.setUserChoice("draft-model");
      expect(id.effectiveModel.value).toBe("draft-model");
      expect(setSessionModelMock).not.toHaveBeenCalled();
    });

    it("releaseBinding 删绑定，effectiveProvider 回落 activeProvider", async () => {
      allProviders.value = [makeProvider("p_a", "kimi"), makeProvider("p_b", "deepseek")];
      activeProviderId.value = "p_b";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
      id.releaseBinding("s1");
      expect(id.providerOf("s1")).toBeNull();
      expect(id.effectiveProvider.value).toBe("p_b");
    });

    it("migrateBinding 迁移绑定到新 sid", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("temp-id");
      id.migrateBinding("temp-id", "real-id");
      expect(id.providerOf("temp-id")).toBeNull();
      expect(id.providerOf("real-id")).toBe("p_a");
    });

    it("clearCurrent 清 lastIdentity + currentSid（effectiveModel 回落 activeProvider 默认）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.lastIdentity.value).not.toBeNull();
      id.clearCurrent();
      expect(id.lastIdentity.value).toBeNull();
      expect(id.effectiveModel.value).toBe("kimi");
    });

    it("空白面板（currentSid null）setUserChoice → pendingDraft，effectiveModel 用它", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "picked"] })];
      activeProviderId.value = "p_a";
      id.setUserChoice("picked");
      expect(id.effectiveModel.value).toBe("picked");
    });

    it("空白面板 pendingDraft 不在 activeProvider 列表 → 回落列表首项", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      id.setUserChoice("not-in-list");
      expect(id.effectiveModel.value).toBe("kimi");
    });

    it("adoptSid 设 currentSid（定名后跟到 realId，不读盘）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("temp-id");
      id.migrateBinding("temp-id", "real-id");
      id.adoptSid("real-id");
      expect(id.effectiveProvider.value).toBe("p_a");
      expect(id.effectiveModel.value).toBe("kimi");
    });

    it("settleOnSend sid 空 → 只推进基线不落盘（空白面板首发）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      setSessionModelMock.mockClear();
      setSessionProviderMock.mockClear();
      await id.settleOnSend("", { provider: "p_a", model: "kimi" });
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "kimi" });
      expect(setSessionModelMock).not.toHaveBeenCalled();
      expect(setSessionProviderMock).not.toHaveBeenCalled();
    });
  });

  describe("displayModels", () => {
    it("第三方 provider → providerModelList", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "k2"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.displayModels.value.map((m) => m.value)).toEqual(["kimi", "k2"]);
    });

    it("系统默认 → sdkModels 优先", async () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      sessionProviderMock.mockResolvedValue("__system_default__");
      sessionModelMock.mockResolvedValue(null);
      await id.resolve("s1");
      id.setSdkModels("s1", [
        { value: "sonnet", displayName: "Sonnet" },
        { value: "opus", displayName: "Opus" },
      ]);
      expect(id.displayModels.value.map((m) => m.value)).toEqual(["sonnet", "opus"]);
    });

    it("系统默认 → 无 sdkModels 则 defaultModels 兜底", async () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      getDefaultModelsMock.mockResolvedValue([{ value: "sonnet", displayName: "Sonnet" }]);
      sessionProviderMock.mockResolvedValue("__system_default__");
      sessionModelMock.mockResolvedValue(null);
      await id.refreshDefaultModels();
      await id.resolve("s1");
      expect(id.displayModels.value.map((m) => m.value)).toEqual(["sonnet"]);
    });

    it("refreshDefaultModels 失败 → console.warn 降级", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      getDefaultModelsMock.mockRejectedValueOnce(new Error("net"));
      await id.refreshDefaultModels();
      expect(warnSpy).toHaveBeenCalledWith(
        "[sessionIdentity] load default models failed:",
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it("已绑定供应商被删除（悬空绑定）→ 第三方分支兜底 []，不崩", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.displayModels.value.map((m) => m.value)).toEqual(["kimi"]);
      // 模拟 deleteProvider：allProviders 移除 p_a（active 重置系统默认），
      // 会话注册表仍悬空指向 p_a（快路径 resolve 不修正悬空绑定）→ 兜底空列表
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      await id.resolve("s1");
      expect(id.displayModels.value.map((m) => m.value)).toEqual([]);
    });
  });

  describe("分支兜底臂", () => {
    it("setUserChoice 在 binding 不存在时建空 binding", () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "x"] })];
      activeProviderId.value = "p_a";
      id.adoptSid("s1");
      id.setUserChoice("x");
      expect(id.effectiveModel.value).toBe("x");
    });

    it("bindRuntime 在 binding 不存在时建空 binding", () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "runtime"] })];
      activeProviderId.value = "p_a";
      id.adoptSid("s1");
      id.bindRuntime("s1", "runtime");
      expect(id.effectiveModel.value).toBe("runtime");
    });

    it("setSdkModels 在 binding 不存在时建空 binding", () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      id.adoptSid("s1");
      id.setSdkModels("s1", [{ value: "sonnet", displayName: "Sonnet" }]);
      expect(id.displayModels.value.map((m) => m.value)).toEqual(["sonnet"]);
    });

    it("effectiveModel currentSid 非空但 binding 无 → emptyBinding 兜底", () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      id.adoptSid("s1");
      expect(id.effectiveModel.value).toBe("kimi");
    });

    it("effectiveProvider currentSid null → activeProviderId", () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      expect(id.effectiveProvider.value).toBe("p_a");
    });

    it("migrateBinding 无 oldSid binding + currentSid !== oldSid → 不迁不动", () => {
      id.migrateBinding("no-exist", "new-id");
      expect(id.providerOf("no-exist")).toBeNull();
      expect(id.providerOf("new-id")).toBeNull();
    });

    it("displayModels currentSid null → activeProviderModels（空白面板/新建会话用 active 列表）", () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      expect(id.displayModels.value.map((m) => m.value)).toEqual(["kimi"]);
    });

    it("effectiveModel currentSid null + activeProvider 无模型 → ''", () => {
      allProviders.value = [makeProvider("p_a", "")];
      activeProviderId.value = "p_a";
      expect(id.effectiveModel.value).toBe("");
    });

    it("空白面板 + activeProvider 系统默认 → defaultModels 首项", async () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      getDefaultModelsMock.mockResolvedValue([{ value: "sonnet", displayName: "Sonnet" }]);
      await id.refreshDefaultModels();
      expect(id.effectiveModel.value).toBe("sonnet");
    });

    it("displayModels 系统默认 + binding 无 → defaultModels（sdkModels ?? []）", async () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      getDefaultModelsMock.mockResolvedValue([{ value: "sonnet", displayName: "Sonnet" }]);
      await id.refreshDefaultModels();
      id.adoptSid("s1");
      expect(id.displayModels.value.map((m) => m.value)).toEqual(["sonnet"]);
    });

    it("resolve 快路径 meta.provider 被删 + model 反查无果 → consistentProviderId null ?? bound", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValueOnce("p_a");
      sessionModelMock.mockResolvedValueOnce("kimi");
      await id.resolve("s1");
      sessionProviderMock.mockResolvedValue("p_deleted");
      sessionModelMock.mockResolvedValue("unknown-model");
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
    });

    it("resolve 快路径 readSessionMeta null → meta?.provider/model ?? null", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValueOnce("p_a");
      sessionModelMock.mockResolvedValueOnce("kimi");
      await id.resolve("s1");
      sessionProviderMock.mockResolvedValue(null);
      sessionModelMock.mockResolvedValue(null);
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(id.lastIdentity.value).toEqual({ provider: "p_a", model: "kimi" });
    });
  });
});