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

/** JSON 响应替身：request() 内核只用到 status / ok / text()。 */
function jsonResponse(body: unknown, status = 200) {
  return { status, ok: status < 400, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe("kb.deleteDocument", () => {
  beforeEach(() => {
    localStorage.clear();
    setBaseUrl("http://kb.test");
    setToken("test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("DELETE /api/documents/{id}，带 Bearer 且**不带正文**", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ documentId: "d1", deletedCount: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    const got = await kb.deleteDocument("d1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://kb.test/api/documents/d1");
    expect((init as RequestInit).method).toBe("DELETE");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-token" });
    // 无正文请求不该挂 Content-Type（有些反代会把「有类型的空体」当畸形请求）
    expect((init as RequestInit).body).toBeUndefined();
    expect(got).toEqual({ documentId: "d1", deletedCount: 3 });
  });

  it("404 → 抛 KbError，绝不静默成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: "not_found", message: "文档不存在或已被删除" }, 404),
      ),
    );

    await expect(kb.deleteDocument("gone")).rejects.toThrow(/文档不存在或已被删除/);
  });
});
