import { describe, it, expect } from "vitest";
import { isPlainObject, parseMcpHeaders, applyMcpHeaders, type McpHeaderMap } from "./sessionMetadata.js";

/** 断言取值 helper：applyMcpHeaders 输出条目是动态重建对象，从 unknown 单次收窄（X2 可辩护）。 */
function injectedHeaders(cfg: unknown): Record<string, string> {
  return (cfg as { headers: Record<string, string> }).headers;
}

describe("isPlainObject", () => {
  it("纯对象 true；数组/null/原始值 false", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });
});

describe("parseMcpHeaders", () => {
  it("合法嵌套：校验重建为新对象（非原引用）", () => {
    const raw = { srv: { Authorization: "Bearer t" } };
    const got = parseMcpHeaders(raw);
    expect(got).toEqual({ srv: { Authorization: "Bearer t" } });
    expect(got).not.toBe(raw); // 拷贝重建，不共享引用（M3）
    expect(got?.srv).not.toBe(raw.srv);
  });

  it("缺席/非对象 → undefined", () => {
    expect(parseMcpHeaders(undefined)).toBeUndefined();
    expect(parseMcpHeaders(null)).toBeUndefined();
    expect(parseMcpHeaders("x")).toBeUndefined();
    expect(parseMcpHeaders(42)).toBeUndefined();
    expect(parseMcpHeaders([{ a: "b" }])).toBeUndefined();
  });

  it("server 条目非对象 → 整体拒绝（fail-closed）", () => {
    expect(parseMcpHeaders({ srv: "Bearer t" })).toBeUndefined();
    expect(parseMcpHeaders({ ok: { a: "b" }, bad: null })).toBeUndefined();
  });

  it("header 值非 string → 整体拒绝", () => {
    expect(parseMcpHeaders({ srv: { a: 1 } })).toBeUndefined();
    expect(parseMcpHeaders({ srv: { a: "ok", b: null } })).toBeUndefined();
  });

  it("空对象合法（= 无注入）；\"*\" 键合法", () => {
    expect(parseMcpHeaders({})).toEqual({});
    expect(parseMcpHeaders({ "*": { "X-Tenant": "acme" } })).toEqual({ "*": { "X-Tenant": "acme" } });
  });
});

describe("applyMcpHeaders", () => {
  const httpSrv = { type: "http", url: "http://x/mcp" };
  const sseSrv = { type: "sse", url: "http://y/sse" };
  const stdioSrv = { type: "stdio", command: "npx" };
  const noTypeSrv = { command: "legacy-no-type" };
  const sdkSrv = { type: "sdk", name: "builtin" };

  it("headers 缺席/空表 → 原引用返回（零拷贝）", () => {
    const servers = { a: httpSrv };
    expect(applyMcpHeaders(servers, undefined)).toBe(servers);
    expect(applyMcpHeaders(servers, {})).toBe(servers);
  });

  it("http/sse 注入；stdio/sdk/type 缺失跳过", () => {
    const servers = { h: httpSrv, s: sseSrv, d: stdioSrv, n: noTypeSrv, k: sdkSrv };
    const got = applyMcpHeaders(servers, { "*": { "X-Tenant": "acme" } });
    expect(got.h).toEqual({ ...httpSrv, headers: { "X-Tenant": "acme" } });
    expect(got.s).toEqual({ ...sseSrv, headers: { "X-Tenant": "acme" } });
    expect(got.d).toBe(stdioSrv); // 原引用未动
    expect(got.n).toBe(noTypeSrv); // fail-closed：未知类型不注入
    expect(got.k).toBe(sdkSrv);
  });

  it("精确 server 名注入，未点名的 http server 不受影响", () => {
    const servers = { h: httpSrv, s: sseSrv };
    const got = applyMcpHeaders(servers, { h: { Authorization: "Bearer t" } });
    expect(got.h).toEqual({ ...httpSrv, headers: { Authorization: "Bearer t" } });
    expect(got.s).toBe(sseSrv);
  });

  it("\"*\" 打底、精确名同键覆盖", () => {
    const servers = { h: httpSrv, s: sseSrv };
    const headers: McpHeaderMap = {
      "*": { "X-Tenant": "acme", "X-Trace": "w" },
      h: { "X-Tenant": "precise" },
    };
    const got = applyMcpHeaders(servers, headers);
    expect(injectedHeaders(got.h)).toEqual({
      "X-Tenant": "precise", // 同键精确名压过通配
      "X-Trace": "w",
    });
    expect(injectedHeaders(got.s)).toEqual({ "X-Tenant": "acme", "X-Trace": "w" }); // 通配对全部 http/sse 生效
  });

  it("注入头覆盖配置自带头（会话级授权身份优先）", () => {
    const servers = { h: { type: "http", url: "u", headers: { Authorization: "static", Keep: "me" } } };
    const got = applyMcpHeaders(servers, { h: { Authorization: "session-token" } });
    expect(injectedHeaders(got.h)).toEqual({
      Authorization: "session-token",
      Keep: "me",
    });
  });

  it("配置 headers 非纯对象 → 视为无，只带注入头", () => {
    const servers = { h: { type: "http", url: "u", headers: "broken" } };
    const got = applyMcpHeaders(servers, { h: { A: "1" } });
    expect(injectedHeaders(got.h)).toEqual({ A: "1" });
  });

  it("headers 表点名但 servers 不存在 → 忽略；点名 server 无可用头 → 不动", () => {
    const servers = { h: httpSrv };
    const got = applyMcpHeaders(servers, { ghost: { A: "1" } });
    expect(got).toEqual({ h: httpSrv }); // 无注入发生
    expect(got.h).toBe(httpSrv);
  });

  it("非法条目（非对象）原样透传不炸", () => {
    const servers = { bad: "not-a-config" as unknown as typeof httpSrv, h: httpSrv };
    const got = applyMcpHeaders(servers, { "*": { A: "1" } });
    expect(got.bad).toBe("not-a-config");
    expect(got.h).toEqual({ ...httpSrv, headers: { A: "1" } });
  });

  it("不改原对象：servers 表与条目均未被就地修改", () => {
    const original = { type: "http", url: "u", headers: { A: "old" } };
    const servers = { h: original };
    applyMcpHeaders(servers, { h: { A: "new", B: "2" } });
    expect(original).toEqual({ type: "http", url: "u", headers: { A: "old" } });
    expect(servers.h).toBe(original);
  });
});
