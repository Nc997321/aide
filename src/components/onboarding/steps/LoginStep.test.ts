// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

const credsExist = vi.hoisted(() => ({ fn: vi.fn() }));
const startLogin = vi.hoisted(() => ({ fn: vi.fn() }));
const obMock = vi.hoisted(() => ({ advance: vi.fn(), step: { value: "login" } }));
const providersMock = vi.hoisted(() => ({
  systemDefault: { value: { apiKeyConfigured: false } },
  saveSystemDefaultApiKey: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../../api", () => ({
  api: {
    claudeCredentialsExist: () => credsExist.fn(),
    claudeStartLogin: () => startLogin.fn(),
  },
}));
vi.mock("../../../composables/useOnboarding", () => ({ useOnboarding: () => obMock }));
vi.mock("../../../composables/useProviders", () => ({ useProviders: () => providersMock }));

import LoginStep from "./LoginStep.vue";

const flush = () => new Promise((r) => setTimeout(r, 0));
function mountStep() {
  return mount(LoginStep, { attachTo: document.body });
}

describe("LoginStep", () => {
  beforeEach(() => {
    credsExist.fn.mockReset();
    startLogin.fn.mockReset();
    obMock.advance.mockReset();
    providersMock.saveSystemDefaultApiKey.mockReset();
    providersMock.saveSystemDefaultApiKey.mockResolvedValue(undefined);
    providersMock.systemDefault.value.apiKeyConfigured = false;
  });

  it("无凭证时渲染 OAuth 主按钮 + API key 链接", async () => {
    credsExist.fn.mockResolvedValue(false);
    const w = mountStep();
    await flush();
    expect(w.find(".oauth-btn").text()).toContain("用 Claude 账号登录");
    expect(w.find(".link").text()).toContain("改用 API key");
    // OAuth 按钮可点（非 oauthBusy 时 enabled）
    expect(w.find(".oauth-btn").attributes("disabled")).toBeUndefined();
  });

  it("OAuth 点击 → degraded → 显示提示 + 展开 API key", async () => {
    credsExist.fn.mockResolvedValue(false);
    startLogin.fn.mockResolvedValue({ authorizeUrl: null, degraded: true });
    const w = mountStep();
    await flush();
    expect(w.find(".api-key-input").exists()).toBe(false);
    await w.find(".oauth-btn").trigger("click");
    await flush();
    expect(startLogin.fn).toHaveBeenCalled();
    expect(w.find(".oauth-msg").text()).toContain("暂不可用");
    expect(w.find(".api-key-input").exists()).toBe(true);
  });

  it("已有 credentials.json 时 mounted 即自动跳过", async () => {
    credsExist.fn.mockResolvedValue(true);
    mountStep();
    await flush();
    expect(obMock.advance).toHaveBeenCalled();
  });

  it("apiKeyConfigured=true 时也自动跳过（即使 credentials.json 不存在）", async () => {
    credsExist.fn.mockResolvedValue(false);
    providersMock.systemDefault.value.apiKeyConfigured = true;
    mountStep();
    await flush();
    expect(obMock.advance).toHaveBeenCalled();
  });

  it("点 API key 链接展开输入框", async () => {
    credsExist.fn.mockResolvedValue(false);
    const w = mountStep();
    await flush();
    expect(w.find(".api-key-input").exists()).toBe(false);
    await w.find(".link").trigger("click");
    expect(w.find(".api-key-input").exists()).toBe(true);
  });

  it("输入 key + 保存 → saveSystemDefaultApiKey(key) + advance", async () => {
    credsExist.fn.mockResolvedValue(false);
    const w = mountStep();
    await flush();
    await w.find(".link").trigger("click");
    await w.find(".api-key-input").setValue("sk-ant-test123");
    await w.find(".save-btn").trigger("click");
    await flush();
    expect(providersMock.saveSystemDefaultApiKey).toHaveBeenCalledWith("sk-ant-test123");
    expect(obMock.advance).toHaveBeenCalled();
  });

  it("保存失败 → 显示错误、不 advance", async () => {
    credsExist.fn.mockResolvedValue(false);
    providersMock.saveSystemDefaultApiKey.mockRejectedValue(new Error("nope"));
    const w = mountStep();
    await flush();
    await w.find(".link").trigger("click");
    await w.find(".api-key-input").setValue("sk-ant-bad");
    await w.find(".save-btn").trigger("click");
    await flush();
    expect(w.find(".err").text()).toContain("nope");
    expect(obMock.advance).not.toHaveBeenCalled();
  });
});