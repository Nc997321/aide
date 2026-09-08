import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMetaPatch } from "../../../types/chat";

// ── api mock：sessionProvider/sessionModel 读受控；setSessionMeta 记录写回 ──
const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();
const setSessionMetaMock = vi.fn<(id: string, patch: SessionMetaPatch) => Promise<void>>();

vi.mock("../../../api", () => ({
  api: {
    sessionProvider: (id: string) => sessionProviderMock(id),
    sessionModel: (id: string) => sessionModelMock(id),
    setSessionMeta: (id: string, patch: SessionMetaPatch) => setSessionMetaMock(id, patch),
  },
}));

import { readSessionMeta, writeSessionMeta } from "./sessionMeta";

describe("sessionMeta (L1 persistence)", () => {
  beforeEach(() => {
    sessionProviderMock.mockReset();
    sessionModelMock.mockReset();
    setSessionMetaMock.mockReset();
    setSessionMetaMock.mockResolvedValue(undefined);
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
    it("set 语义 → patch 原样下发", async () => {
      await writeSessionMeta("s1", {
        provider: { op: "set", value: "p_a" },
        model: { op: "set", value: "m1" },
        effort: { op: "set", value: "high" },
      });
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", {
        provider: { op: "set", value: "p_a" },
        model: { op: "set", value: "m1" },
        effort: { op: "set", value: "high" },
      });
    });

    it("回归（2026-09-08）：多字段只发一次 IPC——此前是 Promise.all 两条单字段命令，各写一遍 <sid>.json，后写的覆盖先写的", async () => {
      await writeSessionMeta("s1", {
        provider: { op: "set", value: "p_a" },
        model: { op: "set", value: "m1" },
      });
      expect(setSessionMetaMock).toHaveBeenCalledTimes(1);
    });

    it("clear 语义 → 下发 { op: 'clear' }（取代空串魔法值）", async () => {
      await writeSessionMeta("s1", { provider: { op: "clear" } });
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", { provider: { op: "clear" } });
    });

    it("省略的字段不进 patch（keep 由 api 层补齐）", async () => {
      await writeSessionMeta("s1", { model: { op: "set", value: "m1" } });
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", { model: { op: "set", value: "m1" } });
    });

    it("空 patch → 仍下发一次（全 keep，盘上不动）", async () => {
      await writeSessionMeta("s1", {});
      expect(setSessionMetaMock).toHaveBeenCalledWith("s1", {});
    });

    it("写失败冒泡给调用方（L1 不吞错，落盘失败影响跨重启）", async () => {
      setSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));
      await expect(
        writeSessionMeta("s1", { provider: { op: "set", value: "p_a" } }),
      ).rejects.toThrow("disk full");
    });
  });
});
