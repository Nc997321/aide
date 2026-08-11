import { describe, it, expect, vi, beforeEach } from "vitest";

// 直接把 mockRequest 作为 session.request（去掉 wrapper 间接层）
const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({ request: mockRequest })),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { startOAuthLogin } from "./oauthLogin";

describe("startOAuthLogin", () => {
  beforeEach(() => mockRequest.mockReset());

  it("A2 成功返回 authorizeUrl（automaticUrl 优先）", async () => {
    mockRequest.mockResolvedValue({ manualUrl: "https://x/m", automaticUrl: "https://x/a" });
    const r = await startOAuthLogin();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.method).toBe("oauth");
      expect(r.authorizeUrl).toBe("https://x/a");
    }
  });

  it("A2 失败 → ok:false, method:none（触发 A1/API key 降级）", async () => {
    // 让 query 返回的 session.request 不是函数 → startOAuthLogin 调用时自然抛 TypeError →
    // 被 try/catch 捕获。用"自然错误"而非 mock 抛 Error，规避 vitest 对 mock 抛错的严格标记。
    vi.mocked(query).mockReturnValueOnce({ request: undefined as any });
    const r = await startOAuthLogin();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.method).toBe("none");
      expect(r.error).toBeTruthy();
    }
  });

  it("无 authorize url → ok:false", async () => {
    mockRequest.mockResolvedValue({});
    const r = await startOAuthLogin();
    expect(r.ok).toBe(false);
  });
});