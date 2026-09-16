import { describe, it, expect } from "vitest";
import { normalizeBrowserUrl, tabLabelOf, urlOfNav, navOfEvent } from "./browser";
import type { NavEventDto } from "../composables/useEmbeddedBrowser";

describe("normalizeBrowserUrl", () => {
  it("裸域名补 https", () => {
    expect(normalizeBrowserUrl("bing.com")).toBe("https://bing.com");
    expect(normalizeBrowserUrl("  example.com/a?b=1  ")).toBe("https://example.com/a?b=1");
  });

  it("带 scheme 的原样（scheme 白名单在 Rust url_guard，前端不复制规则）", () => {
    expect(normalizeBrowserUrl("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeBrowserUrl("file:///C:/x.html")).toBe("file:///C:/x.html");
  });
});

describe("urlOfNav", () => {
  it("idle 没有 URL", () => {
    expect(urlOfNav({ state: "idle" })).toBe("");
    expect(urlOfNav(null)).toBe("");
  });

  it("loading/ready 取 url 字段", () => {
    expect(urlOfNav({ state: "loading", url: "https://a.com/" })).toBe("https://a.com/");
    expect(urlOfNav({ state: "ready", url: "https://a.com/", title: "A" })).toBe("https://a.com/");
  });
});

describe("tabLabelOf", () => {
  it("空标签显示「新标签页」", () => {
    expect(tabLabelOf("")).toBe("新标签页");
  });

  it("v1 用主机名（真标题要 webview2-com 的 DocumentTitleChanged）", () => {
    expect(tabLabelOf("https://www.bing.com/search?q=x")).toBe("www.bing.com");
    expect(tabLabelOf("http://localhost:5173/")).toBe("localhost:5173");
  });

  it("畸形输入原样显示，不猜也不编", () => {
    expect(tabLabelOf("not a url")).toBe("not a url");
  });
});

describe("navOfEvent", () => {
  // 事件是 Rust `#[serde(flatten)]` 的拍平形态：state 与 id/can_go_* 同级。
  // 形状契约由 Rust 侧 dto_test 钉住，这里验前端按判别式还原。
  it("loading 事件还原为 loading 状态", () => {
    const e = {
      id: "browser-1",
      state: "loading",
      url: "https://a.com/",
      can_go_back: false,
      can_go_forward: false,
    } as NavEventDto;
    expect(navOfEvent(e)).toEqual({ state: "loading", url: "https://a.com/" });
  });

  it("ready 事件带标题字段", () => {
    const e = {
      id: "browser-1",
      state: "ready",
      url: "https://a.com/",
      title: "",
      can_go_back: true,
      can_go_forward: false,
    } as NavEventDto;
    expect(navOfEvent(e)).toEqual({ state: "ready", url: "https://a.com/", title: "" });
  });

  it("failed 事件带原因", () => {
    const e = {
      id: "browser-1",
      state: "failed",
      url: "https://a.com/",
      reason: "net::ERR",
      can_go_back: false,
      can_go_forward: false,
    } as NavEventDto;
    expect(navOfEvent(e)).toEqual({ state: "failed", url: "https://a.com/", reason: "net::ERR" });
  });

  it("idle 事件无负载", () => {
    const e = {
      id: "browser-1",
      state: "idle",
      can_go_back: false,
      can_go_forward: false,
    } as NavEventDto;
    expect(navOfEvent(e)).toEqual({ state: "idle" });
  });
});
