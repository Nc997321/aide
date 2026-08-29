import { describe, it, expect, vi, beforeEach } from "vitest";

// ── api mock：sessionProvider/sessionModel 读受控；setSessionProvider/setSessionModel 记录写回 ──
const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();
const setSessionProviderMock = vi.fn<(id: string, provider: string) => Promise<void>>();
const setSessionModelMock = vi.fn<(id: string, model: string) => Promise<void>>();

vi.mock("../../../api", () => ({
  api: {
    sessionProvider: (id: string) => sessionProviderMock(id),
    sessionModel: (id: string) => sessionModelMock(id),
    setSessionProvider: (id: string, provider: string) => setSessionProviderMock(id, provider),
    setSessionModel: (id: string, model: string) => setSessionModelMock(id, model),
  },
}));

import { readSessionMeta, writeSessionMeta } from "./sessionMeta";

describe("sessionMeta (L1 persistence)", () => {
  beforeEach(() => {
    sessionProviderMock.mockReset();
    sessionModelMock.mockReset();
    setSessionProviderMock.mockReset();
    setSessionModelMock.mockReset();
    setSessionProviderMock.mockResolvedValue(undefined);
    setSessionModelMock.mockResolvedValue(undefined);
  });

  describe("readSessionMeta", () => {
    it("provider 与 model 皆空 → null", async () => {
      sessionProviderMock.mockResolvedValue(null);
      sessionModelMock.mockResolvedValue(null);
      expect(await readSessionMeta("s1")).toBeNull();
    });

    it("只 provider → { provider, model: null }", async () => {
      sessionProviderMock.mockResolvedValue("p_a");
      sessionModelMock.mockResolvedValue(null);
      expect(await readSessionMeta("s1")).toEqual({ provider: "p_a", model: null });
    });

    it("只 model → { provider: null, model }", async () => {
      sessionProviderMock.mockResolvedValue(null);
      sessionModelMock.mockResolvedValue("deepseek-v4-flash:0731-cloud");
      expect(await readSessionMeta("s1")).toEqual({ provider: null, model: "deepseek-v4-flash:0731-cloud" });
    });

    it("IPC 失败 → null（读降级为无元数据）", async () => {
      sessionProviderMock.mockRejectedValue(new Error("ipc"));
      sessionModelMock.mockRejectedValue(new Error("ipc"));
      expect(await readSessionMeta("s1")).toBeNull();
    });

    it("空串视为无（防 api 返回空串）→ null", async () => {
      sessionProviderMock.mockResolvedValue("" as string | null);
      sessionModelMock.mockResolvedValue("" as string | null);
      expect(await readSessionMeta("s1")).toBeNull();
    });
  });

  describe("writeSessionMeta", () => {
    it("provider 非空 → 调 setSessionProvider，不调 setSessionModel", async () => {
      await writeSessionMeta("s1", { provider: "p_a" });
      expect(setSessionProviderMock).toHaveBeenCalledWith("s1", "p_a");
      expect(setSessionModelMock).not.toHaveBeenCalled();
    });

    it("model 非空 → 调 setSessionModel，不调 setSessionProvider", async () => {
      await writeSessionMeta("s1", { model: "deepseek-v4-flash:0731-cloud" });
      expect(setSessionModelMock).toHaveBeenCalledWith("s1", "deepseek-v4-flash:0731-cloud");
      expect(setSessionProviderMock).not.toHaveBeenCalled();
    });

    it("provider=null → 删字段（传空串）", async () => {
      await writeSessionMeta("s1", { provider: null });
      expect(setSessionProviderMock).toHaveBeenCalledWith("s1", "");
    });

    it("model='' → 删字段（传空串）", async () => {
      await writeSessionMeta("s1", { model: "" });
      expect(setSessionModelMock).toHaveBeenCalledWith("s1", "");
    });
    it("model=null → 删字段（传空串，?? null 臂）", async () => {
      await writeSessionMeta("s1", { model: null });
      expect(setSessionModelMock).toHaveBeenCalledWith("s1", "");
    });
    it("provider=null → 删字段（传空串，?? null 臂）", async () => {
      await writeSessionMeta("s1", { provider: null });
      expect(setSessionProviderMock).toHaveBeenCalledWith("s1", "");
    });

    it("provider=undefined → 不调 setSessionProvider", async () => {
      await writeSessionMeta("s1", { model: "x" });
      expect(setSessionProviderMock).not.toHaveBeenCalled();
    });

    it("model=undefined → 不调 setSessionModel", async () => {
      await writeSessionMeta("s1", { provider: "p_a" });
      expect(setSessionModelMock).not.toHaveBeenCalled();
    });

    it("同时 provider+model → 两个都调", async () => {
      await writeSessionMeta("s1", { provider: "p_a", model: "m1" });
      expect(setSessionProviderMock).toHaveBeenCalledWith("s1", "p_a");
      expect(setSessionModelMock).toHaveBeenCalledWith("s1", "m1");
    });

    it("空 patch → 两个都不调", async () => {
      await writeSessionMeta("s1", {});
      expect(setSessionProviderMock).not.toHaveBeenCalled();
      expect(setSessionModelMock).not.toHaveBeenCalled();
    });
  });
});