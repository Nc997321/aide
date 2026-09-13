// @vitest-environment jsdom
// ↑ 必须：getBaseUrl / getToken 走 localStorage，node 环境没有。这是仓库既有的
//   per-file 覆盖约定（另有 10 个测试在用），不是特例。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kb, setBaseUrl, setToken } from "./kbClient";

/**
 * 最小响应替身：getAsset 只用到 status / ok / blob()。
 * 构造真的 `Response` 反而依赖运行环境提供了它，替身更稳。
 */
function fakeResponse(init: { status?: number; blob?: Blob } = {}) {
  const status = init.status ?? 200;
  return {
    status,
    ok: status < 400,
    blob: async () => init.blob ?? new Blob([]),
  };
}

describe("kb.getAsset", () => {
  beforeEach(() => {
    localStorage.clear();
    setBaseUrl("http://kb.test");
    setToken("test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("带上 Bearer 头取字节", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse({ blob: new Blob(["abc"]) }));
    vi.stubGlobal("fetch", fetchMock);

    const got = await kb.getAsset("abc-123");

    expect(got.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://kb.test/api/assets/abc-123");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
  });

  it("id 做 URL 编码，不参与拼路径", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse());
    vi.stubGlobal("fetch", fetchMock);

    await kb.getAsset("a b/c");

    expect(fetchMock.mock.calls[0][0]).toBe("http://kb.test/api/assets/a%20b%2Fc");
  });

  it("403 必须抛错，不能返回空 blob", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeResponse({ status: 403 })),
    );

    await expect(kb.getAsset("nope")).rejects.toThrow(/图片加载失败/);
  });

  it("401 时清掉本地 token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeResponse({ status: 401 })),
    );

    await expect(kb.getAsset("x")).rejects.toBeTruthy();
    expect(localStorage.getItem("aide.kb.token")).toBeNull();
  });

  it("网络层失败给的是「连不上服务」，不是通用错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(kb.getAsset("x")).rejects.toThrow(/连不上知识库服务/);
  });
});
