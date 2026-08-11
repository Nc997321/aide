import { describe, it, expect, beforeEach, vi } from "vitest";

// 与 useChatSession.listener.test.ts 同套：mock tauri 通道，避免真实 invoke/listen
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const credsExist = vi.hoisted(() => ({ fn: vi.fn() }));
const providersState = vi.hoisted(() => ({ apiKeyConfigured: false, activeProviderId: "__system_default__" }));

vi.mock("@/api", () => ({ api: { claudeCredentialsExist: () => credsExist.fn() } }));
vi.mock("./useProviders", () => ({
  useProviders: () => ({
    systemDefault: { value: { apiKeyConfigured: providersState.apiKeyConfigured } },
    activeProviderId: { value: providersState.activeProviderId },
    SYSTEM_DEFAULT_ID: "__system_default__",
  }),
}));

import { canSendOrPrompt } from "./useChatSession";

describe("canSendOrPrompt 无凭证拦截", () => {
  beforeEach(() => {
    credsExist.fn.mockReset();
    providersState.apiKeyConfigured = false;
    providersState.activeProviderId = "__system_default__";
  });

  it("无凭证（apiKey 未配 且 credentials.json 不存在）→ false（拦截）", async () => {
    credsExist.fn.mockResolvedValue(false);
    expect(await canSendOrPrompt()).toBe(false);
  });

  it("credentials.json 存在 → true（放行）", async () => {
    credsExist.fn.mockResolvedValue(true);
    expect(await canSendOrPrompt()).toBe(true);
  });

  it("apiKeyConfigured=true → true（不依赖 credentials.json）", async () => {
    providersState.apiKeyConfigured = true;
    credsExist.fn.mockResolvedValue(false); // 即使没有 credentials.json
    expect(await canSendOrPrompt()).toBe(true);
  });

  it("当前激活供应商非 SystemDefault（用 ollama 等）→ true（不强制 Claude 登录）", async () => {
    providersState.activeProviderId = "ollama-xxx";
    credsExist.fn.mockResolvedValue(false); // SystemDefault 没凭证也不挡
    expect(await canSendOrPrompt()).toBe(true);
  });
});