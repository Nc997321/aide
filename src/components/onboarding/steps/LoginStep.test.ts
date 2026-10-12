// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

const credsExist = vi.hoisted(() => ({ fn: vi.fn() }));
const loginStart = vi.hoisted(() => ({ fn: vi.fn() }));
const loginState = vi.hoisted(() => ({ fn: vi.fn() }));
const submitCode = vi.hoisted(() => ({ fn: vi.fn() }));
const loginCancel = vi.hoisted(() => ({ fn: vi.fn() }));
const openExternalMock = vi.hoisted(() => ({ fn: vi.fn() }));
const hostKey = vi.hoisted(() => ({ value: "local" }));
const obMock = vi.hoisted(() => ({ advance: vi.fn(), step: { value: "login" } }));
const providersMock = vi.hoisted(() => ({
  systemDefault: { value: { apiKeyConfigured: false } },
  saveSystemDefaultApiKey: vi.fn(),
  activeProviderId: { value: "__system_default__" },
  SYSTEM_DEFAULT_ID: "__system_default__",
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../../../api", () => ({
  api: {
    claudeCredentialsExist: () => credsExist.fn(),
    claudeLoginStart: (openOnHost: boolean) => loginStart.fn(openOnHost),
    claudeLoginState: () => loginState.fn(),
    claudeLoginSubmitCode: (code: string) => submitCode.fn(code),
    claudeLoginCancel: () => loginCancel.fn(),
  },
  openExternal: (url: string) => openExternalMock.fn(url),
}));
vi.mock("@aide/sdk/api", () => ({
  hostApi: { current: async () => ({ key: hostKey.value, label: "", os: "linux", home: "/" }) },
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
    loginStart.fn.mockReset();
    loginStart.fn.mockResolvedValue({ authorizeUrl: "https://claude.test/authorize" });
    loginState.fn.mockReset();
    loginState.fn.mockResolvedValue({ phase: "waiting" });
    submitCode.fn.mockReset();
    submitCode.fn.mockResolvedValue(undefined);
    loginCancel.fn.mockReset();
    loginCancel.fn.mockResolvedValue(undefined);
    openExternalMock.fn.mockReset();
    openExternalMock.fn.mockResolvedValue(undefined);
    hostKey.value = "local";
    obMock.advance.mockReset();
    providersMock.saveSystemDefaultApiKey.mockReset();
    providersMock.saveSystemDefaultApiKey.mockResolvedValue(undefined);
    providersMock.systemDefault.value.apiKeyConfigured = false;
    providersMock.activeProviderId.value = "__system_default__";
  });

  it("当前激活供应商非 SystemDefault → 自动跳过 Claude 登录步（不强制 Claude）", async () => {
    providersMock.activeProviderId.value = "ollama-xxx";
    credsExist.fn.mockResolvedValue(false); // SystemDefault 没凭证也不挡
    mountStep();
    await flush();
    expect(obMock.advance).toHaveBeenCalled();
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

  it("本机 Host：CLI 自己开浏览器，界面不重复开；登录成功后自动进下一步", async () => {
    credsExist.fn.mockResolvedValue(false);
    const w = mountStep();
    await flush();
    await w.find(".oauth-btn").trigger("click");
    await flush();
    expect(loginStart.fn).toHaveBeenCalledWith(true);
    expect(openExternalMock.fn).not.toHaveBeenCalled();
    expect(w.find(".waiting-text").text()).toContain("自动继续");
    // 粘贴授权码的入口两种 Host 都在（浏览器回调没接上时的退路）
    loginState.fn.mockResolvedValue({ phase: "succeeded" });
    await w.find(".code-input").setValue("abc#xyz");
    await w.find(".code-submit").trigger("click");
    await flush();
    expect(submitCode.fn).toHaveBeenCalledWith("abc#xyz");
    expect(obMock.advance).toHaveBeenCalled();
  });

  it("WSL / SSH Host：界面在本机打开登录链接，提示粘贴授权码", async () => {
    credsExist.fn.mockResolvedValue(false);
    hostKey.value = "wsl:Debian";
    const w = mountStep();
    await flush();
    await w.find(".oauth-btn").trigger("click");
    await flush();
    expect(loginStart.fn).toHaveBeenCalledWith(false);
    expect(openExternalMock.fn).toHaveBeenCalledWith("https://claude.test/authorize");
    expect(w.find(".waiting-text").text()).toContain("授权码");
  });

  it("授权码被拒 → 显示 CLI 给的原因，不进下一步，可重新开始", async () => {
    credsExist.fn.mockResolvedValue(false);
    const w = mountStep();
    await flush();
    await w.find(".oauth-btn").trigger("click");
    await flush();
    loginState.fn.mockResolvedValue({ phase: "failed", error: "Login failed: Request failed with status code 400" });
    await w.find(".code-input").setValue("wrong");
    await w.find(".code-submit").trigger("click");
    await flush();
    expect(w.find(".oauth-msg").text()).toContain("status code 400");
    expect(obMock.advance).not.toHaveBeenCalled();
    expect(w.find(".oauth-btn").exists()).toBe(true);
  });

  it("启动失败（Host 上没有 CLI 等）→ 如实显示原因", async () => {
    credsExist.fn.mockResolvedValue(false);
    loginStart.fn.mockRejectedValue("这台 Host 上没有随包的 claude CLI");
    const w = mountStep();
    await flush();
    await w.find(".oauth-btn").trigger("click");
    await flush();
    expect(w.find(".oauth-msg").text()).toContain("没有随包的 claude CLI");
  });

  it("取消 → 通知 Host 收掉登录，回到登录按钮", async () => {
    credsExist.fn.mockResolvedValue(false);
    const w = mountStep();
    await flush();
    await w.find(".oauth-btn").trigger("click");
    await flush();
    await w.find(".cancel-link").trigger("click");
    await flush();
    expect(loginCancel.fn).toHaveBeenCalled();
    expect(w.find(".oauth-btn").exists()).toBe(true);
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