import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useLsp } from "./useLsp";

describe("useLsp", () => {
  beforeEach(() => useLsp().__resetForTest());

  it("isLspOn false by default", () => {
    const { isLspOn } = useLsp();
    expect(isLspOn("/any")).toBe(false);
  });

  it("diagnosticsFor empty when none", () => {
    const { diagnosticsFor } = useLsp();
    expect(diagnosticsFor("/x.rs")).toEqual([]);
  });

  it("enableLsp adds workspace and calls workspaceSetLspEnabled", async () => {
    const { enableLsp, isLspOn } = useLsp();
    const { invoke } = await import("@tauri-apps/api/core");
    await enableLsp("/root");
    expect(isLspOn("/root")).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("workspace_set_lsp_enabled", {
      workspaceRoot: "/root",
      enabled: true,
    });
  });

  it("disableLsp removes workspace and calls shutdown + set false", async () => {
    const { enableLsp, disableLsp, isLspOn } = useLsp();
    const { invoke } = await import("@tauri-apps/api/core");
    await enableLsp("/root");
    expect(isLspOn("/root")).toBe(true);

    await disableLsp("/root");
    expect(isLspOn("/root")).toBe(false);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("lsp_shutdown_workspace", {
      workspaceRoot: "/root",
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("workspace_set_lsp_enabled", {
      workspaceRoot: "/root",
      enabled: false,
    });
  });

  it("enableLsp no-ops on empty root", async () => {
    const { enableLsp, isLspOn } = useLsp();
    await enableLsp("");
    expect(isLspOn("")).toBe(false);
  });

  it("disableLsp no-ops on empty root", async () => {
    const { disableLsp } = useLsp();
    // Should not throw
    await expect(disableLsp("")).resolves.toBeUndefined();
  });

  it("clearDiagnostics empties the map", () => {
    const { diagnostics, clearDiagnostics } = useLsp();
    diagnostics.value.set("/x.rs", [{
      fromLine: 0, toLine: 0, fromCol: 0, toCol: 0,
      severity: "error" as const, message: "test",
    }]);
    clearDiagnostics();
    expect(diagnostics.value.size).toBe(0);
  });

  it("__resetForTest clears all state", () => {
    const { lspEnabledWorkspaces, diagnostics, __resetForTest } = useLsp();
    lspEnabledWorkspaces.value.add("/root");
    diagnostics.value.set("/x.rs", [{
      fromLine: 0, toLine: 0, fromCol: 0, toCol: 0,
      severity: "error" as const, message: "test",
    }]);
    __resetForTest();
    expect(lspEnabledWorkspaces.value.size).toBe(0);
    expect(diagnostics.value.size).toBe(0);
  });
});

describe("useLsp 开关与 Host 同步", () => {
  beforeEach(() => useLsp().__resetForTest());

  it("refreshLspSwitch 按 Host 权威值回种（重启后不再一律显示关）", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "workspace_get_lsp_switch" ? { enabled: true, decided: true } : undefined,
    );
    const { refreshLspSwitch, isLspOn } = useLsp();
    const sw = await refreshLspSwitch("C:\\Users\\me\\po-api");
    expect(sw).toEqual({ enabled: true, decided: true });
    expect(isLspOn("C:\\Users\\me\\po-api")).toBe(true);
    // 分隔符 / 盘符大小写不同的同一个根也认
    expect(isLspOn("c:/Users/me/po-api/")).toBe(true);
    vi.mocked(invoke).mockImplementation(async () => undefined);
  });

  it("lsp-switch-changed 事件同步缓存（会话里的询问卡片 / 其他客户端改了开关）", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const handlers = new Map<string, (ev: { payload: unknown }) => void>();
    vi.mocked(listen).mockImplementation(async (name: string, cb: any) => {
      handlers.set(name, cb);
      return () => {};
    });
    const { refreshLspSwitch, isLspOn } = useLsp();
    await refreshLspSwitch("/ws");
    handlers.get("lsp-switch-changed")!({ payload: { workspaceRoot: "/ws", enabled: true } });
    expect(isLspOn("/ws")).toBe(true);
    handlers.get("lsp-switch-changed")!({ payload: { workspaceRoot: "/ws", enabled: false } });
    expect(isLspOn("/ws")).toBe(false);
  });
});
