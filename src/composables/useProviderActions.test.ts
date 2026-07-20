import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    testProviderConnection: vi.fn(),
    cpaProbePort: vi.fn(),
    cpaOpenManagement: vi.fn(),
    cpaLoginStatus: vi.fn(),
    viewAnthropicQuota: vi.fn(),
    refreshModels: vi.fn(),
  },
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

import { api } from "../api";
import { open } from "@tauri-apps/plugin-shell";
import { useProviderActions } from "./useProviderActions";

describe("useProviderActions", () => {
  const A = useProviderActions();
  const { testConnection, cpaProbe, cpaOpenManagement, cpaLoginStatus, viewQuota, refreshModels, __resetForTest } = A;

  beforeEach(() => {
    __resetForTest();
    (api.testProviderConnection as any).mockReset();
    (api.cpaProbePort as any).mockReset();
    (api.cpaOpenManagement as any).mockReset();
    (api.cpaLoginStatus as any).mockReset();
    (api.viewAnthropicQuota as any).mockReset();
    (api.refreshModels as any).mockReset();
    (open as any).mockReset();
  });

  it("testConnection(id) 调 api.testProviderConnection 并存结果", async () => {
    (api.testProviderConnection as any).mockResolvedValue({ ok: true, detail: "ok" });
    const r = await testConnection("cpa-local");
    expect(api.testProviderConnection).toHaveBeenCalledWith("cpa-local");
    expect(r?.ok).toBe(true);
  });

  it("cpaProbe 调 api.cpaProbePort 存 PortProbeResult", async () => {
    (api.cpaProbePort as any).mockResolvedValue({ alive: true, detail: "响应" });
    const r = await cpaProbe();
    expect(r?.alive).toBe(true);
  });

  it("cpaOpenManagement 拿 URL 后调 shell.open(url)", async () => {
    (api.cpaOpenManagement as any).mockResolvedValue("http://127.0.0.1:8317/management.html");
    await cpaOpenManagement();
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:8317/management.html");
  });

  it("cpaLoginStatus 存 LoginStatusResult", async () => {
    (api.cpaLoginStatus as any).mockResolvedValue({ logged_in: true, detail: "已登录" });
    const r = await cpaLoginStatus();
    expect(r?.logged_in).toBe(true);
  });

  it("viewQuota 存任意 JSON", async () => {
    (api.viewAnthropicQuota as any).mockResolvedValue({ usage: 50 });
    const r = await viewQuota();
    expect((r as any).usage).toBe(50);
  });

  it("refreshModels(id) 调 api.refreshModels", async () => {
    (api.refreshModels as any).mockResolvedValue({ anthropicModel: "x" });
    await refreshModels("__system_default__");
    expect(api.refreshModels).toHaveBeenCalledWith("__system_default__");
  });

  it("action 失败时 lastError 被记录、不抛（UI 自己决定怎么展示）", async () => {
    (api.cpaProbePort as any).mockRejectedValue(new Error("boom"));
    const r = await cpaProbe();
    expect(r).toBeNull();
    expect(A.lastError.value).toContain("boom");
  });
});
