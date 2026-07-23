import { describe, it, expect, vi, beforeEach } from "vitest";

// mock @tauri-apps/api/core 的 invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

beforeEach(() => {
  (invoke as any).mockReset();
});

describe("api provider wrappers — 新增 IPC", () => {
  it("getProviderCatalog 调 invoke('get_provider_catalog')", async () => {
    (invoke as any).mockResolvedValue([]);
    await api.getProviderCatalog();
    expect(invoke).toHaveBeenCalledWith("get_provider_catalog");
  });

  it("testProviderConnection 传 providerId", async () => {
    (invoke as any).mockResolvedValue({ ok: true, detail: "" });
    await api.testProviderConnection("cpa-local");
    expect(invoke).toHaveBeenCalledWith("test_provider_connection", { providerId: "cpa-local" });
  });

  it("cpaProbePort 无参", async () => {
    (invoke as any).mockResolvedValue({ alive: true, detail: "" });
    await api.cpaProbePort();
    expect(invoke).toHaveBeenCalledWith("cpa_probe_port");
  });

  it("cpaOpenManagement 无参返回 URL", async () => {
    (invoke as any).mockResolvedValue("http://127.0.0.1:8317/management.html");
    await api.cpaOpenManagement();
    expect(invoke).toHaveBeenCalledWith("cpa_open_management");
  });

  it("cpaLoginStatus 无参", async () => {
    (invoke as any).mockResolvedValue({ logged_in: true, detail: "" });
    await api.cpaLoginStatus();
    expect(invoke).toHaveBeenCalledWith("cpa_login_status");
  });

  it("viewAnthropicQuota 无参", async () => {
    (invoke as any).mockResolvedValue({});
    await api.viewAnthropicQuota();
    expect(invoke).toHaveBeenCalledWith("view_anthropic_quota");
  });

  it("refreshModels 传 providerId", async () => {
    (invoke as any).mockResolvedValue({ anthropicModel: "x" });
    await api.refreshModels("__system_default__");
    expect(invoke).toHaveBeenCalledWith("refresh_models", { providerId: "__system_default__" });
  });

  it("probeImageInput 透传当前选定模型", async () => {
    (invoke as any).mockResolvedValue({ supported: false });
    await api.probeImageInput("glm-5.2");
    expect(invoke).toHaveBeenCalledWith("probe_image_input", { model: "glm-5.2" });
  });
});
