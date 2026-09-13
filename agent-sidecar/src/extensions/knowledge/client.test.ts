import { describe, it, expect, vi } from "vitest";
import { createKbClient, docPath, toFailure, withQuery, type KbRuntimeConfig } from "./client.js";

const cfg: KbRuntimeConfig = { baseUrl: "http://kb:8788", token: "tok" };

/** 假 fetch：记录调用，返回给定响应。 */
function fakeFetch(reply: { status: number; body: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status: reply.status, text: async () => reply.body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("withQuery", () => {
  it("拼查询串，undefined 的键跳过", () => {
    expect(withQuery("/api/search", { q: "部署", limit: 20, spaceId: undefined })).toBe(
      "/api/search?q=" + encodeURIComponent("部署") + "&limit=20",
    );
  });

  it("没有有效键时保持原路径（不冒出一个 ?）", () => {
    expect(withQuery("/api/spaces", {})).toBe("/api/spaces");
    expect(withQuery("/api/spaces")).toBe("/api/spaces");
  });

  it("孤立代理项不抛（模型能传进来）→ 替换字符（键、值两条路径）", () => {
    expect(withQuery("/api/search", { q: "\uD800" })).toBe("/api/search?q=%EF%BF%BD");
    expect(withQuery("/api/search", { "\uD800": "x" })).toBe("/api/search?%EF%BF%BD=x");
  });
});

describe("docPath", () => {
  it("uuid 原样进路径", () => {
    expect(docPath("a1b2-c3")).toBe("/api/documents/a1b2-c3");
  });

  it("带斜杠的 id 被编码（裸拼会多出一段路径）", () => {
    expect(docPath("d/1")).toBe("/api/documents/d%2F1");
  });

  it("孤立代理项不抛（模型能传进来）→ 替换字符；合法代理对原样编码", () => {
    expect(docPath("\uD800")).toBe("/api/documents/%EF%BF%BD");
    expect(docPath("😀")).toBe("/api/documents/%F0%9F%98%80");
  });
});

describe("createKbClient", () => {
  it("GET 成功 → data；带 Bearer 头与 Accept", async () => {
    const { fn, calls } = fakeFetch({ status: 200, body: '{"ok":1}' });
    const r = await createKbClient(cfg, fn).getJson<{ ok: number }>("/api/health");
    expect(r).toEqual({ ok: true, data: { ok: 1 } });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers.Accept).toBe("application/json");
  });

  it("POST 带 JSON body 与 Content-Type", async () => {
    const { fn, calls } = fakeFetch({ status: 200, body: "{}" });
    await createKbClient(cfg, fn).sendJson("/api/documents", "POST", { title: "t" });
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe('{"title":"t"}');
  });

  it("401 → unauthorized（401 不当作通用 bad_request）", async () => {
    const { fn } = fakeFetch({ status: 401, body: '{"error":"unauthorized","message":"登录已失效"}' });
    const r = await createKbClient(cfg, fn).getJson("/api/spaces");
    expect(r).toEqual({ ok: false, failure: { kind: "unauthorized" } });
  });

  it("409 → locked，并带上服务端 message", async () => {
    const { fn } = fakeFetch({ status: 409, body: '{"error":"locked","message":"文档正被张三编辑"}' });
    const r = await createKbClient(cfg, fn).sendJson("/api/documents/x", "PUT", {});
    expect(r).toEqual({ ok: false, failure: { kind: "locked", message: "文档正被张三编辑" } });
  });

  it("500 → server，带状态码", async () => {
    const { fn } = fakeFetch({ status: 503, body: "" });
    const r = await createKbClient(cfg, fn).getJson("/api/spaces");
    expect(r).toEqual({ ok: false, failure: { kind: "server", status: 503 } });
  });

  it("2xx 但 body 不是 JSON → bad_response", async () => {
    const { fn } = fakeFetch({ status: 200, body: "<html>proxy</html>" });
    const r = await createKbClient(cfg, fn).getJson("/api/spaces");
    expect(r).toEqual({ ok: false, failure: { kind: "bad_response", detail: "response body is not JSON" } });
  });

  it("fetch 抛错 → network，带 baseUrl 与原始信息（不带 token）", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await createKbClient(cfg, fn).getJson("/api/spaces");
    expect(r).toEqual({
      ok: false,
      failure: { kind: "network", baseUrl: "http://kb:8788", detail: "ECONNREFUSED" },
    });
  });

  it("超时 → timeout（用假定时器把 15s 推快）", async () => {
    vi.useFakeTimers();
    try {
      const fn = ((_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })) as unknown as typeof fetch;
      const p = createKbClient(cfg, fn).getJson("/api/search", { q: "x" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await p).toEqual({ ok: false, failure: { kind: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendFile 走 multipart，字段名 file", async () => {
    const { fn, calls } = fakeFetch({ status: 201, body: '{"documentId":"d1"}' });
    const r = await createKbClient(cfg, fn).sendFile(
      "/api/ingest",
      { spaceId: "s1" },
      { filename: "a.md", data: new Uint8Array([35, 32]) },
    );
    expect(r).toEqual({ ok: true, data: { documentId: "d1" } });
    expect(calls[0]!.url).toBe("http://kb:8788/api/ingest?spaceId=s1");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    const form = calls[0]!.init.body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("a.md");
  });

  it("垃圾 baseUrl（面板自由文本可产生）→ network 文本失败，不抛", async () => {
    const r = await createKbClient({ baseUrl: "  ", token: "tok" }).getJson("/api/spaces");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.failure.kind).toBe("network");
    expect(r.ok === false && r.failure.kind === "network" && r.failure.baseUrl).toBe("  ");
  });
});

describe("toFailure", () => {
  it("403 → forbidden；未知 4xx → bad_request 且带服务端 message", () => {
    expect(toFailure(403, "{}")).toEqual({ kind: "forbidden" });
    expect(toFailure(422, '{"error":"bad","message":"标题不能为空"}')).toEqual({
      kind: "bad_request",
      message: "标题不能为空",
    });
  });

  it("错误体不是 JSON → message 退回截断原文（不抛）", () => {
    const f = toFailure(400, "x".repeat(500));
    expect(f.kind).toBe("bad_request");
    expect(f.kind === "bad_request" && f.message.length).toBe(200);
  });
});
