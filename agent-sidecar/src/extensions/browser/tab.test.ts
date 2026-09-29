// browser_tab 的回归：action → 桥载荷的映射、"缺必填参数在本地就失败"、以及
// navigate **回报观测到的落点**（后一组要走桥，故自带一份最小应答器）。
//
// 本地失败很重要：桥对面是桌面 Rust，发出去才发现参数不对要等 15s 超时，
// 而超时文案会把"你少给了 url"伪装成"浏览器卡了"。
import { describe, it, expect, afterEach } from "vitest";

import { buildTabCall, performTabAction, renderTabResult, type TabAction } from "./tab.js";
import { cancelAllBrowserQueries, resolveBrowserResult } from "../browserClient.js";
import type { ChatEvent } from "../../engine/types.js";

describe("buildTabCall：action → 桥载荷", () => {
  /**
   * open 必带 recorder 的启动脚本：Rust 侧会把它注册在**首次导航之前**（见 `CreateCfg::init_script`），
   * 于是 agent 自己开的 tab 第一份文档从它的第一个请求起就被覆盖。只钉"带上了、是那一份"——
   * 脚本原文由 `recorder.ts` 单一来源供给，逐字快照在这里是维护负担。
   */
  it("open 带 url 与 label，且带上 recorder 启动脚本；label 省略时它不出现", () => {
    // 载荷是判别联合，取字段前先摊平成可索引的形状（断言的是**载荷里有什么**）。
    const withLabel = buildTabCall("open", { url: "http://localhost:5173/", label: "dev" }) as Record<
      string,
      unknown
    >;
    expect(withLabel).toMatchObject({
      op: "open",
      url: "http://localhost:5173/",
      label: "dev",
    });
    expect(String(withLabel["init_script"])).toContain("__aideRec");

    const plain = buildTabCall("open", { url: "http://localhost:5173/" }) as Record<string, unknown>;
    expect(plain["label"]).toBeUndefined();
    expect(String(plain["init_script"])).toContain("__aideRec");
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

// ---- navigate 的落点回读（走桥，故自带应答器） ----
//
// 与 `wait.test.ts` 同形，但**不引那个文件的私有助手**：跨文件引测试助手会让一处改动
// 连带弄红另一个文件，两处的答复语义也会慢慢漂开。

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

/** 等第 n 条桥请求出现——navigate 的落点回读在 `NAV_SETTLE_MS` 之后才发，不能假设已到齐。 */
async function waitForQuery(events: ChatEvent[], n: number, budgetMs = 3000): Promise<any> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && events.length <= n) await new Promise((r) => setTimeout(r, 5));
  const q = events[n];
  if (!q) throw new Error(`bridge query #${n} never arrived (got ${events.length})`);
  return q as any;
}

const evalOk = (value: unknown) => ({
  ok: true,
  data: { view_id: "browser-7", value: { result: { type: "string", value } } },
});

afterEach(() => cancelAllBrowserQueries("test cleanup"));

describe("navigate：回报**观测到的**落点，不是请求值", () => {
  // navigate 的命令回包里 nav.url 由 `begin_nav` 写成**请求值**——那正是反馈第 1 条里
  // "工具说到了新地址、页面还在旧地址"的来源。
  const navOk = {
    ok: true,
    data: {
      view_id: "browser-7",
      view: { id: "browser-7", nav: { state: "loading", url: "http://a/#/two", title: "" } },
    },
  };

  it("落点与请求一致 → 说「文档确认」", async () => {
    const { events, emit } = emitCollector();
    const p = performTabAction("navigate", { viewId: "browser-7", url: "http://a/#/two" }, emit);
    const nav = await waitForQuery(events, 0);
    resolveBrowserResult({ request_id: nav.request_id, ...navOk });

    const read = await waitForQuery(events, 1);
    expect(read.method).toBe("Runtime.evaluate");
    expect(read.params.expression).toBe("location.href");
    resolveBrowserResult({ request_id: read.request_id, ...evalOk("http://a/#/two") });

    const text = await p;
    expect(text).toContain("document confirms");
    expect(text).toContain("http://a/#/two");
  });

  it("落点与请求不一致（守卫把 hash 弹回）→ 两边都给出来 + 说明两种成因", async () => {
    const { events, emit } = emitCollector();
    const p = performTabAction("navigate", { viewId: "browser-7", url: "http://a/#/two" }, emit);
    const nav = await waitForQuery(events, 0);
    resolveBrowserResult({ request_id: nav.request_id, ...navOk });
    const read = await waitForQuery(events, 1);
    resolveBrowserResult({ request_id: read.request_id, ...evalOk("http://a/#/one") });

    const text = await p;
    expect(text).toContain("http://a/#/one");
    expect(text).toContain("http://a/#/two");
    expect(text).toContain("redirected");
    expect(text).not.toContain("document confirms");
    // 反馈里那条原始形态是"工具说已到新地址"——**观测到不符**这一支尤其不许再出现它。
    expect(text).not.toMatch(/Navigated/);
  });

  it("读不到落点 → 退回请求值 + 明说未能确认，不假装成功", async () => {
    const { events, emit } = emitCollector();
    const p = performTabAction("navigate", { viewId: "browser-7", url: "http://a/#/two" }, emit);
    const nav = await waitForQuery(events, 0);
    resolveBrowserResult({ request_id: nav.request_id, ...navOk });
    const read = await waitForQuery(events, 1);
    resolveBrowserResult({ request_id: read.request_id, ok: false, error: "the view browser-7 is gone" });

    const text = await p;
    expect(text).toContain("could not be read");
    expect(text).toContain("the view browser-7 is gone");
    expect(text).not.toContain("document confirms");
    // 用例名里那句"不假装成功"要真的钉住：**未观测**的分支不许用完成时断言导航已发生，
    // 否则模型读到的第一句仍是"已导航"——正是这条反馈要消灭的形态。
    expect(text).not.toMatch(/Navigated/);
  });

  it("非 navigate 的动作不读落点（back / forward 一条直路，不多一次往返）", async () => {
    const { events, emit } = emitCollector();
    const p = performTabAction("focus", { viewId: "browser-7" }, emit);
    const q = await waitForQuery(events, 0);
    expect(q.op).toBe("focus");
    resolveBrowserResult({ request_id: q.request_id, ok: true, data: { view_id: "browser-7", requested: true } });
    await p;
    expect(events).toHaveLength(1);
  });
});
