import { describe, it, expect, vi, beforeEach } from "vitest";

// Tauri 层 mock（与 useChatSession.test.ts 同一边界）：整条真实链路
// registry → persistence → api → transport → invoke 都跑起来，断言落在 IPC 载荷上。
const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  useSessionWorkspaces,
  ensureWorkspaceKnown,
  persistWorkspaceIfDirty,
} from "./useSessionWorkspaces";
import type { SessionWorkspaceRef } from "../types/chat";

const WS = { wsKey: "C--proj-a", wsPath: "C:/proj/a" };

/** 档案侧只对 `session_workspace` 回值，其余命令 resolve undefined。 */
function diskReturns(ref: SessionWorkspaceRef | null) {
  invokeMock.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "session_workspace" ? ref : undefined),
  );
}

const setCalls = () => invokeMock.mock.calls.filter((c) => c[0] === "set_session_workspace");
const readCalls = () => invokeMock.mock.calls.filter((c) => c[0] === "session_workspace");

describe("useSessionWorkspaces · 归属落盘对账", () => {
  beforeEach(() => {
    useSessionWorkspaces().clearAll();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  describe("ensureWorkspaceKnown（回种）", () => {
    it("注册表空 + 档案有归属 → 回种（这正是串档事故缺的那一环：cwd 不再回落活动工作区）", async () => {
      diskReturns({ wsPath: "C:/proj/a", wsKey: "C--proj-a" });

      await ensureWorkspaceKnown("s1");

      expect(useSessionWorkspaces().workspaceOf("s1")).toEqual(WS);
    });

    it("已有条目**绝不覆盖**：注册表里的值来自权威来源，档案只是它的副本", async () => {
      const { setWorkspace, workspaceOf } = useSessionWorkspaces();
      setWorkspace("s1", { wsKey: "k-live", wsPath: "C:/live" });
      diskReturns({ wsPath: "C:/stale", wsKey: "k-stale" });

      await ensureWorkspaceKnown("s1");

      expect(workspaceOf("s1")).toEqual({ wsKey: "k-live", wsPath: "C:/live" });
    });

    it("同一会话只读一次盘（打开 + 发送前两次调用 → 一次 IPC）", async () => {
      diskReturns(null);

      await ensureWorkspaceKnown("s1");
      await ensureWorkspaceKnown("s1");

      expect(readCalls()).toHaveLength(1);
    });

    it("档案没记过 → 不回种、不落盘（「查不到」不是归属）", async () => {
      diskReturns(null);

      await ensureWorkspaceKnown("s1");
      await persistWorkspaceIfDirty("s1");

      expect(useSessionWorkspaces().workspaceOf("s1")).toBeNull();
      expect(setCalls()).toHaveLength(0);
    });

    it("空 sid 直接返回（不发 IPC）", async () => {
      await ensureWorkspaceKnown("");
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });

  describe("persistWorkspaceIfDirty（对账落盘）", () => {
    it("未读过盘 → 首次照写（存量会话就是这样把归属补成持久的）", async () => {
      const { setWorkspace } = useSessionWorkspaces();
      setWorkspace("s1", WS);

      await persistWorkspaceIfDirty("s1");

      expect(setCalls()).toHaveLength(1);
      expect(setCalls()[0][1]).toEqual({
        id: "s1",
        wsPath: { op: "set", value: "C:/proj/a" },
        wsKey: { op: "set", value: "C--proj-a" },
      });
    });

    it("盘上已是同值 → 不写（读完盘再对账是零 IPC）", async () => {
      diskReturns(WS);
      await ensureWorkspaceKnown("s1");

      await persistWorkspaceIfDirty("s1");

      expect(setCalls()).toHaveLength(0);
    });

    it("读了盘之后改归属 → 写一次，且不重复写", async () => {
      diskReturns({ wsPath: "C:/old", wsKey: "k-old" });
      await ensureWorkspaceKnown("s1");
      useSessionWorkspaces().setWorkspace("s1", WS);

      await persistWorkspaceIfDirty("s1");
      await persistWorkspaceIfDirty("s1");

      expect(setCalls()).toHaveLength(1);
    });

    it("没有 key → clear 而不是写空串（空串在 Rust 读侧被 filter，写进去是永远读不到的垃圾）", async () => {
      useSessionWorkspaces().setWorkspace("s1", { wsKey: "", wsPath: "C:/proj/a" });

      await persistWorkspaceIfDirty("s1");

      expect(setCalls()[0][1]).toMatchObject({ wsKey: { op: "clear" } });
    });

    it("无归属可写 → 不写（空白会话 / 没记过归属的老会话）", async () => {
      await persistWorkspaceIfDirty("s1");
      expect(setCalls()).toHaveLength(0);
    });

    it("写失败只留痕不抛：它挂在发送路径上，不许把消息拖住", async () => {
      invokeMock.mockImplementation(() => Promise.reject(new Error("disk full")));
      useSessionWorkspaces().setWorkspace("s1", WS);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(persistWorkspaceIfDirty("s1")).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe("生命周期（过户 / 收口）", () => {
    it("定名过户：归属条目搬到真实 id，且真实 id 以「盘上未知」开局（finalize 随后写一次）", async () => {
      const { setWorkspace, migrate, workspaceOf } = useSessionWorkspaces();
      setWorkspace("temp-1", WS);

      migrate("temp-1", "sdk-uuid-1");

      expect(workspaceOf("temp-1")).toBeNull();
      expect(workspaceOf("sdk-uuid-1")).toEqual(WS);
      // 这条落盘不是多余的：注册表刚拿到定名后的归属，档案里还没有
      await persistWorkspaceIfDirty("sdk-uuid-1");
      expect(setCalls()).toHaveLength(1);
      expect(setCalls()[0][1]).toMatchObject({ id: "sdk-uuid-1" });
    });

    it("销毁后重开：快照作废 → 重读档案（取盘上最新值，兼容别的端改过归属）", async () => {
      const { setWorkspace, removeWorkspace, workspaceOf } = useSessionWorkspaces();
      setWorkspace("s1", WS);
      removeWorkspace("s1");

      diskReturns({ wsPath: "C:/proj/a", wsKey: "C--proj-a" });
      await ensureWorkspaceKnown("s1");

      expect(workspaceOf("s1")).toEqual(WS);
      expect(readCalls()).toHaveLength(1);
    });
  });
});
