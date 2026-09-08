import { describe, it, expect, vi, beforeEach } from "vitest";
import { useProviders } from "../../../composables/useProviders";
import { useSessionProviders } from "../../../composables/useSessionProviders";
import type { ProviderConfig, ProviderModelMappings } from "../../../types";
import type { ModelOption, SessionMetaPatch } from "../../../types/chat";

// ── api mock：sessionProvider/sessionModel 读受控；setSessionMeta 记录写回；getDefaultModels 系统默认兜底列表 ──
const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();
const setSessionMetaMock = vi.fn<(id: string, patch: SessionMetaPatch) => Promise<void>>();
const getDefaultModelsMock = vi.fn<() => Promise<ModelOption[]>>();

vi.mock("../../../api", () => ({
  api: {
    sessionProvider: (id: string) => sessionProviderMock(id),
    sessionModel: (id: string) => sessionModelMock(id),
    setSessionMeta: (id: string, patch: SessionMetaPatch) => setSessionMetaMock(id, patch),
    getDefaultModels: () => getDefaultModelsMock(),
  },
}));

import { sessionIdentityStore } from "./store";

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

describe("sessionIdentityStore (L2a 仓库)", () => {
  const { allProviders, activeProviderId } = useProviders();
  const { providers } = useSessionProviders();
  let id: ReturnType<typeof useSessionIdentity>;

  beforeEach(() => {
    sessionProviderMock.mockReset();
    sessionModelMock.mockReset();
    setSessionMetaMock.mockReset();
    getDefaultModelsMock.mockReset();
    setSessionMetaMock.mockResolvedValue(undefined);
    getDefaultModelsMock.mockResolvedValue([]);
    for (const k of Object.keys(providers)) delete providers[k];
    id = sessionIdentityStore;
    id.__resetForTest();
  });

  describe("resolve 慢路径（无内存绑定）", () => {
    it("provider 仍在 + 模型可信 → setProvider 恢复，不写回", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(setSessionMetaMock).not.toHaveBeenCalled();
      expect(id.lastProviderOf("s1")).toBe("p_a");
    });

    it("provider 被删但模型反查命中 → 修正绑定 + self-heal 写回", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_deleted");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", { provider: { op: "set", value: "p_a" } });
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
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", { provider: { op: "set", value: "p_a" } });
    });

    it("self-heal 写盘失败 → console.warn 降级，仍修正绑定", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      sessionProviderMock.mockResolvedValue("p_deleted");
      sessionModelMock.mockResolvedValue("kimi");
      setSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));
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
      expect(id.lastProviderOf("s1")).toBe("p_a");
    });
  });

  describe("resolve 快路径（有内存绑定）", () => {
    it("有绑定 → 不调 setProvider，只刷基线", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValueOnce("p_a");
      sessionModelMock.mockResolvedValueOnce("kimi");
      await id.resolve("s1");
      setSessionMetaMock.mockClear();
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(setSessionMetaMock).not.toHaveBeenCalled();
      expect(id.lastProviderOf("s1")).toBe("p_a");
    });
  });

  describe("settleOnSend（供应商维度：绑定确保 + 落盘 + 基线同源；模型落盘已移交 model_committed）", () => {
    it("无绑定 → setProvider + 落盘 provider + 推进基线，三者同源；模型不再由它落盘", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      await id.settleOnSend("s1", "p_a");
      expect(id.providerOf("s1")).toBe("p_a");
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", { provider: { op: "set", value: "p_a" } });
      expect(setSessionMetaMock).toHaveBeenCalledTimes(1);
      expect(id.lastProviderOf("s1")).toBe("p_a");
    });

    it("已有绑定且 provider 同值 → 跳过 IPC（省冗余写）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValueOnce("p_a");
      sessionModelMock.mockResolvedValueOnce("kimi");
      await id.resolve("s1");
      setSessionMetaMock.mockClear();
      await id.settleOnSend("s1", "p_a");
      expect(setSessionMetaMock).not.toHaveBeenCalled();
      expect(id.providerOf("s1")).toBe("p_a");
      expect(id.lastProviderOf("s1")).toBe("p_a");
    });

    it("provider 变化 → 只写 provider（model 落盘是 model_committed 的职责）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi"), makeProvider("p_b", "deepseek")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValueOnce("p_a");
      sessionModelMock.mockResolvedValueOnce("kimi");
      await id.resolve("s1");
      await id.settleOnSend("s1", "p_b");
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", { provider: { op: "set", value: "p_b" } });
      expect(setSessionMetaMock).toHaveBeenCalledTimes(1);
      expect(id.lastProviderOf("s1")).toBe("p_b");
    });

    it("落盘失败 → console.warn 降级，基线照常推进", async () => {
      allProviders.value = [makeProvider("p_a", "kimi"), makeProvider("p_b", "deepseek")];
      activeProviderId.value = "p_a";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      sessionProviderMock.mockResolvedValueOnce("p_a");
      sessionModelMock.mockResolvedValueOnce("kimi");
      await id.resolve("s1");
      setSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));
      await id.settleOnSend("s1", "p_b");
      expect(warnSpy).toHaveBeenCalledWith(
        "[sessionIdentity] settleOnSend persist failed:",
        "s1",
        expect.any(Error),
      );
      expect(id.lastProviderOf("s1")).toBe("p_b");
      // 失败后绑定已建立（空绑定，meta 保持盘上状态）→ 后续 resolve 走快路径不崩（不变式回归）。
      // 模型 mock 与 p_b 自洽（deepseek）：consistentProviderId 按模型反查会把它归回 p_a。
      sessionProviderMock.mockResolvedValue("p_b");
      sessionModelMock.mockResolvedValue("deepseek");
      await id.resolve("s1");
      expect(id.lastProviderOf("s1")).toBe("p_b");
      warnSpy.mockRestore();
    });

    it("落盘失败但 binding 已存在 → 注册表不覆盖（setProvider 仅无绑定时兜底）、model 侧不被触碰", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "runtime"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      id.bindRuntime("s1", "runtime");
      setSessionMetaMock.mockClear();
      setSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));
      await id.settleOnSend("s1", "p_b"); // provider 变 → 进 try → catch（落盘失败）
      // 已有绑定注册表不覆盖（if(!providerOf) 守护）——供应商 respawn 的注册表变更
      // 由 provider_switched 链路处理，settleOnSend 只管账面与落盘
      expect(id.providerOf("s1")).toBe("p_a");
      expect(id.effectiveModelOf("s1")).toBe("runtime"); // model 侧 binding 完全未被触碰
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
      expect(id.effectiveModelOf("s1")).toBe("deepseek-v4-flash:0731-cloud");
    });

    it("draft 在列表 → 优先于 runtime/restored", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "user-picked", "runtime-model"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      id.setUserChoice("s1", "user-picked");
      id.bindRuntime("s1", "runtime-model");
      expect(id.effectiveModelOf("s1")).toBe("user-picked");
    });

    it("runtime 在列表 → 优先于 restored（draft 空/不在列表）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "runtime-model"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      id.bindRuntime("s1", "runtime-model");
      expect(id.effectiveModelOf("s1")).toBe("runtime-model");
    });

    it("runtime 别名不在列表 → 跳过用 restored（不污染下拉）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      id.bindRuntime("s1", "sonnet");
      expect(id.effectiveModelOf("s1")).toBe("kimi");
    });

    it("全空 provider（无 model/mappings/knownModels）→ effectiveModel=''", async () => {
      allProviders.value = [makeProvider("p_a", "")];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue(null);
      await id.resolve("s1");
      expect(id.effectiveModelOf("s1")).toBe("");
    });
  });

  describe("lastProvider=null → 门控不误弹（本次 bug 回归）", () => {
    it("resolve 前 lastProvider=null（无基线）", () => {
      expect(id.lastProviderOf("s1")).toBeNull();
    });
  });

  describe("bindRuntime / setUserChoice / releaseBinding / migrateBinding / clearCurrent", () => {
    it("bindRuntime 坐实 runtimeModel（在列表），不落盘", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "sidecar-current"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      setSessionMetaMock.mockClear();
      id.bindRuntime("s1", "sidecar-current");
      expect(id.effectiveModelOf("s1")).toBe("sidecar-current");
      expect(setSessionMetaMock).not.toHaveBeenCalled();
    });

    it("setUserChoice 草稿（在列表），不落盘", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "draft-model"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      setSessionMetaMock.mockClear();
      id.setUserChoice("s1", "draft-model");
      expect(id.effectiveModelOf("s1")).toBe("draft-model");
      expect(setSessionMetaMock).not.toHaveBeenCalled();
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
      expect(id.effectiveProviderOf("s1")).toBe("p_b");
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

    it("settleOnSend sid 空 → 不落盘也不记基线（空白面板首发由 sendMessage 拿 tempId 后坐实）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      setSessionMetaMock.mockClear();
      await id.settleOnSend("", "p_a");
      expect(id.lastProviderOf("s1")).toBeNull();
      expect(setSessionMetaMock).not.toHaveBeenCalled();
    });
  });

  describe("displayModels", () => {
    it("第三方 provider → providerModelList", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "k2"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      expect(id.displayModelsOf("s1").map((m) => m.value)).toEqual(["kimi", "k2"]);
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
      expect(id.displayModelsOf("s1").map((m) => m.value)).toEqual(["sonnet", "opus"]);
    });

    it("系统默认 → 无 sdkModels 则 defaultModels 兜底", async () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      getDefaultModelsMock.mockResolvedValue([{ value: "sonnet", displayName: "Sonnet" }]);
      sessionProviderMock.mockResolvedValue("__system_default__");
      sessionModelMock.mockResolvedValue(null);
      await id.refreshDefaultModels();
      await id.resolve("s1");
      expect(id.displayModelsOf("s1").map((m) => m.value)).toEqual(["sonnet"]);
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
      expect(id.displayModelsOf("s1").map((m) => m.value)).toEqual(["kimi"]);
      // 模拟 deleteProvider：allProviders 移除 p_a（active 重置系统默认），
      // 会话注册表仍悬空指向 p_a（快路径 resolve 不修正悬空绑定）→ 兜底空列表
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      await id.resolve("s1");
      expect(id.displayModelsOf("s1").map((m) => m.value)).toEqual([]);
    });
  });

  describe("分支兜底臂", () => {
    it("setUserChoice 在 binding 不存在时建空 binding", () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "x"] })];
      activeProviderId.value = "p_a";
      id.setUserChoice("s1", "x");
      expect(id.effectiveModelOf("s1")).toBe("x");
    });

    it("bindRuntime 在 binding 不存在时建空 binding", () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "runtime"] })];
      activeProviderId.value = "p_a";
      id.bindRuntime("s1", "runtime");
      expect(id.effectiveModelOf("s1")).toBe("runtime");
    });

    it("setSdkModels 在 binding 不存在时建空 binding", () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      id.setSdkModels("s1", [{ value: "sonnet", displayName: "Sonnet" }]);
      expect(id.displayModelsOf("s1").map((m) => m.value)).toEqual(["sonnet"]);
    });

    it("effectiveModel currentSid 非空但 binding 无 → emptyBinding 兜底", () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      expect(id.effectiveModelOf("s1")).toBe("kimi");
    });

    it("effectiveProvider currentSid null → activeProviderId", () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      expect(id.effectiveProviderOf("s1")).toBe("p_a");
    });

    it("migrateBinding 无 oldSid binding + currentSid !== oldSid → 不迁不动", () => {
      id.migrateBinding("no-exist", "new-id");
      expect(id.providerOf("no-exist")).toBeNull();
      expect(id.providerOf("new-id")).toBeNull();
    });

    it("displayModels currentSid null → activeProviderModels（空白面板/新建会话用 active 列表）", () => {
      allProviders.value = [makeProvider("p_a", "kimi")];
      activeProviderId.value = "p_a";
      expect(id.activeProviderModels().map((m) => m.value)).toEqual(["kimi"]);
    });

    it("effectiveModel currentSid null + activeProvider 无模型 → ''", () => {
      allProviders.value = [makeProvider("p_a", "")];
      activeProviderId.value = "p_a";
      expect(id.effectiveModelOf("s1")).toBe("");
    });

    it("空白面板 + activeProvider 系统默认 → defaultModels 首项", async () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      getDefaultModelsMock.mockResolvedValue([{ value: "sonnet", displayName: "Sonnet" }]);
      await id.refreshDefaultModels();
      expect(id.effectiveModelOf("s1")).toBe("sonnet");
    });

    it("displayModels 系统默认 + binding 无 → defaultModels（sdkModels ?? []）", async () => {
      allProviders.value = [];
      activeProviderId.value = "__system_default__";
      getDefaultModelsMock.mockResolvedValue([{ value: "sonnet", displayName: "Sonnet" }]);
      await id.refreshDefaultModels();
      expect(id.displayModelsOf("s1").map((m) => m.value)).toEqual(["sonnet"]);
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
      expect(id.lastProviderOf("s1")).toBe("p_a");
    });
  });

  describe("commitModelFromRuntime（model_committed 事件驱动落盘）", () => {
    it("带 requestedModel → bindRuntime 坐实 + 落盘 model（用户命名空间别名）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "fable"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      setSessionMetaMock.mockClear();
      await id.commitModelFromRuntime("s1", {
        fromModel: "kimi", toModel: "fable-resolved", requestedModel: "fable", source: "sdk",
      });
      expect(id.effectiveModelOf("s1")).toBe("fable");
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", { model: { op: "set", value: "fable" } });
    });

    it("requestedModel=null（CLI 内部切换）→ 只 bindRuntime，不落盘（无用户选择可恢复）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "auto-model"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      setSessionMetaMock.mockClear();
      await id.commitModelFromRuntime("s1", {
        fromModel: "kimi", toModel: "auto-model", requestedModel: null, source: "auto",
      });
      // 无用户选择可恢复：不 bindRuntime 不落盘，下拉回落盘面恢复值
      expect(id.effectiveModelOf("s1")).toBe("kimi");
      expect(setSessionMetaMock).not.toHaveBeenCalled();
    });

    it("model 同值 → 跳过落盘 IPC（bindRuntime 幂等）", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "fable"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      await id.commitModelFromRuntime("s1", {
        fromModel: "fable-resolved", toModel: "fable-resolved", requestedModel: "fable", source: "sdk",
      });
      setSessionMetaMock.mockClear();
      await id.commitModelFromRuntime("s1", {
        fromModel: "fable-resolved", toModel: "fable-resolved", requestedModel: "fable", source: "sdk",
      });
      expect(setSessionMetaMock).not.toHaveBeenCalled();
      expect(id.effectiveModelOf("s1")).toBe("fable");
    });

    it("落盘失败 → console.warn 降级，runtime 坐实已生效", async () => {
      allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "fable"] })];
      activeProviderId.value = "p_a";
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue("kimi");
      await id.resolve("s1");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));
      await id.commitModelFromRuntime("s1", {
        fromModel: "kimi", toModel: "fable-resolved", requestedModel: "fable", source: "sdk",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[sessionIdentity] commitModelFromRuntime persist failed:",
        "s1",
        expect.any(Error),
      );
      expect(id.effectiveModelOf("s1")).toBe("fable");
      warnSpy.mockRestore();
    });
  });
});