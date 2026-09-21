// browser_tab 的纯函数回归：action → 桥载荷的映射，以及"缺必填参数在本地就失败"。
//
// 本地失败很重要：桥对面是桌面 Rust，发出去才发现参数不对要等 15s 超时，
// 而超时文案会把"你少给了 url"伪装成"浏览器卡了"。
import { describe, it, expect } from "vitest";

import { buildTabCall, renderTabResult, type TabAction } from "./tab.js";

describe("buildTabCall：action → 桥载荷", () => {
  it("open 带 url 与 label；label 省略时字段根本不出现", () => {
    expect(buildTabCall("open", { url: "http://localhost:5173/", label: "dev" })).toEqual({
      op: "open",
      url: "http://localhost:5173/",
      label: "dev",
    });
    expect(buildTabCall("open", { url: "http://localhost:5173/" })).toEqual({
      op: "open",
      url: "http://localhost:5173/",
    });
  });

  it("view_id 缺省**照样透传**：由 Rust 按「全库恰好一个视图」解析，多视图时它会明确报错", () => {
    expect(buildTabCall("back", {})).toEqual({ op: "back" });
    expect(buildTabCall("focus", { viewId: "browser-2" })).toEqual({
      op: "focus",
      view_id: "browser-2",
    });
    expect(buildTabCall("close", { viewId: "browser-3" })).toEqual({
      op: "close",
      view_id: "browser-3",
    });
  });

  it("缺 url 的 open / navigate 在本地就失败，不发桥", () => {
    const actions: TabAction[] = ["open", "navigate"];
    for (const action of actions) {
      expect(() => buildTabCall(action, {})).toThrow(/needs a url/);
    }
  });
});

describe("renderTabResult：如实说清状态与下一步", () => {
  const view = {
    id: "browser-7",
    nav: { state: "ready", url: "http://localhost:5173/", title: "Vite App" },
    displayed: false,
    label: "dev",
  };

  it("open 要说明这是 parked 视图 + 把 view_id 交回模型", () => {
    const text = renderTabResult("open", { view_id: "browser-7", view });
    expect(text).toContain("browser-7");
    expect(text).toMatch(/parked/i); // 文案主色是大写 PARKED——判据是"说了这回事"，不是大小写
    expect(text).toMatch(/view_id/i);
  });

  it("focus 要说清这是**请求**，执行在 UI", () => {
    const text = renderTabResult("focus", { view_id: "browser-7", requested: true });
    expect(text).toContain("browser-7");
    expect(text).toMatch(/request/i);
  });

  it("close 直接确认关掉了哪个", () => {
    expect(renderTabResult("close", { view_id: "browser-7", closed: true })).toContain("browser-7");
  });

  it("前进后退报当前位置与两个能力位（游标没动时也不撒谎）", () => {
    const text = renderTabResult("back", {
      view_id: "browser-7",
      view: { ...view, can_go_back: true, can_go_forward: true },
    });
    expect(text).toContain("browser-7");
    expect(text).toContain("http://localhost:5173/");
    expect(text).toMatch(/can-go-back/i);
  });
});
