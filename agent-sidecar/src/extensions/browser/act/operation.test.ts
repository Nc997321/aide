import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../../engine/types.js";
import { cancelAllBrowserQueries, resolveBrowserResult } from "../../browserClient.js";
import { asRecord } from "../format.js";
import { readBaselines } from "../readDiff.js";
import { OPERATION_OBSERVATION_MARKER } from "./observe.js";
import { performBrowserOperation } from "./operation.js";
import { buildBrowserActTool } from "./tool.js";

type Query = Extract<ChatEvent, { type: "browser_query" }>;
type Reply = { ok: boolean; data?: unknown; error?: string };
type Override = (query: Query) => Reply | "pending" | undefined;

/** 编排测试的确定性桥，不冒充浏览器：真实事件/DOM/导航另由固定页面验收。 */
class Host {
  readonly queries: Query[] = [];
  readonly writes: string[] = [];
  readonly fields = new Map<string, string>();
  origin = 1;
  url = "http://fixture/form";
  text = "fixture";
  override?: Override;

  emit = (event: ChatEvent): void => {
    if (event.type !== "browser_query") return;
    this.queries.push(event);
    const overridden = this.override?.(event);
    if (overridden === "pending") return;
    const reply = overridden ?? this.reply(event);
    resolveBrowserResult({ request_id: event.request_id, ...reply });
  };

  evaluate(value: unknown): Reply {
    return { ok: true, data: { view_id: "fixture-view", value: { result: { type: "object", value } } } };
  }

  script(query: Query): string {
    return String(asRecord(query.params)?.["expression"] ?? "");
  }

  projection(): Record<string, unknown> {
    return {
      ok: true, url: this.url, title: "Fixture", text: this.text, textFiltered: true,
      fields: [...this.fields].map(([name, value]) => ({ tag: "input", label: name, name, value })),
    };
  }

  private reply(query: Query): Reply {
    if (query.op === "list_views") return { ok: true, data: { views: [{ id: "fixture-view", nav: { state: "ready", url: this.url } }] } };
    if (query.method !== "Runtime.evaluate") return { ok: true, data: { value: {} } };
    const script = this.script(query);
    if (script.startsWith(OPERATION_OBSERVATION_MARKER)) return this.evaluate({ projection: this.projection(), origin: this.origin });
    if (script === "performance.timeOrigin") return this.evaluate(this.origin);
    if (script === "0") return this.evaluate(0);
    if (script.includes("var __v =")) return this.evaluate({ met: true, value: true, to: this.origin });
    if (script.includes("var VALUE =")) return this.fill(script);
    return this.evaluate({ ok: true, hit: { tag: "button", text: "Fixture" }, x: 20, y: 20, at: { url: this.url }, url: this.url });
  }

  private fill(script: string): Reply {
    const targetMatch = /var TARGET = (.+);/.exec(script);
    const valueMatch = /var VALUE = (.+);/.exec(script);
    if (!targetMatch?.[1] || !valueMatch?.[1]) throw new Error("fill fixture did not recognize the injected payload");
    const target = asRecord(JSON.parse(targetMatch[1]) as unknown);
    const name = String(target?.["selector"] ?? target?.["text"]);
    const value = String(JSON.parse(valueMatch[1]) as unknown);
    this.writes.push(name);
    this.fields.set(name, value);
    return this.evaluate({ ok: true, hit: { tag: "input", text: name }, value, events: ["input", "change"] });
  }
}

function batch(steps: unknown[]) {
  return { action: "batch", view_id: "fixture-view", steps };
}

function fill(selector: string, value = "changed") {
  return { action: "fill", selector, value };
}

async function run(host: Host, args: unknown): Promise<string> {
  const tool = buildBrowserActTool(host.emit) as unknown as {
    handler: (input: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[] }>;
  };
  const result = await tool.handler(args, {});
  return result.content.map((block) => block.text).join("\n");
}

afterEach(() => {
  cancelAllBrowserQueries("test cleanup");
  vi.useRealTimers();
});

describe("browser_act 有界操作契约", () => {
  it.each([
    { action: "batch", steps: [] },
    batch(Array.from({ length: 9 }, () => fill("#a"))),
    { ...batch([fill("#a")]), text: "outer target" },
    { action: "fill", selector: "#a", value: "x", steps: [fill("#b")] },
    batch([fill("#a"), { action: "press", key: "not-a-key" }]),
    batch([fill("#a"), { action: "fill", selector: "#b" }]),
    batch([fill("#a"), { action: "click", text: "go", wait_for: { condition: "(" } }]),
    batch([{ action: "batch", steps: [fill("#a")] }]),
  ])("整批预校验，非法请求不发任何桥请求：%j", async (input) => {
    const host = new Host();
    const text = await run(host, input);
    expect(text).not.toContain("Executed");
    expect(host.queries).toHaveLength(0);
    expect(host.writes).toHaveLength(0);
  });

  it("一次工具调用完成多字段，返回私有前后差异，不污染 read 基准", async () => {
    const host = new Host();
    readBaselines.set("fixture-view", false, "last real read", "main");
    const text = await run(host, { ...batch([fill("#name", "泵-01"), fill("#note", "正常")]), scope: "main" });
    expect(host.writes).toEqual(["#name", "#note"]);
    expect(text).toContain("Executed 2/2");
    expect(text).toContain("泵-01");
    expect(text).toContain("正常");
    expect(text).toContain("Page feedback (top document)");
    expect(readBaselines.get("fixture-view", false, "main")).toBe("last real read");
    const observations = host.queries.filter((query) => host.script(query).startsWith(OPERATION_OBSERVATION_MARKER));
    expect(observations).toHaveLength(2);
    const initial = observations[0];
    if (!initial) throw new Error("missing initial observation");
    expect(host.script(initial)).toContain('var SCOPE = "main"');
    expect(host.queries.every((query) => query.method !== "Page.getFrameTree")).toBe(true);
  });

  it("异步联动：条件满足以后才派发下一级填写", async () => {
    vi.useFakeTimers();
    const host = new Host();
    let polls = 0;
    host.override = (query) => {
      if (!host.script(query).includes("var __v =")) return undefined;
      polls += 1;
      return host.evaluate({ met: polls >= 2, value: polls >= 2, to: 1 });
    };
    const promise = run(host, batch([
      { ...fill("#category"), wait_for: { condition: "window.optionsReady" } }, fill("#device"),
    ]));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.writes).toEqual(["#category"]);
    await vi.advanceTimersByTimeAsync(200);
    const text = await promise;
    expect(host.writes).toEqual(["#category", "#device"]);
    expect(text).toContain("Expected result CONFIRMED");
  });

  it("等待超时保留已执行动作并停在此步，不派发后续", async () => {
    vi.useFakeTimers();
    const host = new Host();
    host.override = (query) => host.script(query).includes("var __v =") ? host.evaluate({ met: false, value: false }) : undefined;
    const promise = run(host, batch([
      { ...fill("#category"), wait_for: { condition: "false", timeout_ms: 100 } }, fill("#device"),
    ]));
    await vi.advanceTimersByTimeAsync(100);
    const text = await promise;
    expect(host.writes).toEqual(["#category"]);
    expect(text).toContain("Stopped at step 1");
    expect(text).toContain("1 later step(s) not executed");
    expect(text).toContain("NOT CONFIRMED");
  });

  it.each(["selector matched nothing", "selector matched 2 elements", "the element reads back empty after the write"])(
    "目标消失/歧义/框架回退均停步：%s", async (error) => {
      const host = new Host();
      host.override = (query) => host.script(query).includes('"selector":"#bad"') ? host.evaluate({ ok: false, error }) : undefined;
      const text = await run(host, batch([fill("#first"), fill("#bad"), fill("#last")]));
      expect(host.writes).toEqual(["#first"]);
      expect(text).toContain("Stopped at step 2");
      expect(text).toContain(error);
    },
  );

  it("取消发生在条件轮询的 sleep 间隙，也不再发查询/后续动作", async () => {
    vi.useFakeTimers();
    const host = new Host();
    host.override = (query) => host.script(query).includes("var __v =") ? host.evaluate({ met: false }) : undefined;
    const promise = run(host, batch([{ ...fill("#first"), wait_for: { condition: "false" } }, fill("#last")]));
    await vi.advanceTimersByTimeAsync(0);
    const queriesAtCancel = host.queries.length;
    cancelAllBrowserQueries("user interrupted");
    await vi.advanceTimersByTimeAsync(200);
    const text = await promise;
    expect(host.queries).toHaveLength(queriesAtCancel);
    expect(host.writes).toEqual(["#first"]);
    expect(text).toContain("interrupted");
  });

  it("整批 60 秒预算耗尽后不再派发，即使发生在两个动作之间", async () => {
    vi.useFakeTimers();
    const host = new Host();
    host.override = (query) => {
      if (host.script(query).includes("var VALUE =")) vi.setSystemTime(Date.now() + 60_000);
      return undefined;
    };
    const text = await run(host, batch([fill("#first"), fill("#last")]));
    expect(host.writes).toEqual(["#first"]);
    expect(host.queries).toHaveLength(2); // 前置快照 + 第一步；不再发后置快照/下一动作。
    expect(text).toContain("60s budget");
  });

  it("8 步上限可用且不拆成多个工具调用", async () => {
    const host = new Host();
    const text = await run(host, batch(Array.from({ length: 8 }, (_, index) => fill(`#field-${index}`))));
    expect(host.writes).toHaveLength(8);
    expect(text).toContain("Executed 8/8");
  });

  it("输入桥超时标记不确定，不合成重放、不执行后续", async () => {
    vi.useFakeTimers();
    const host = new Host();
    host.override = (query) => query.method === "Input.dispatchMouseEvent" ? "pending" : undefined;
    const promise = run(host, batch([{ action: "click", selector: "#go" }, fill("#last")]));
    await vi.advanceTimersByTimeAsync(15_000);
    const text = await promise;
    expect(text).toContain("[uncertain]");
    expect(host.writes).toHaveLength(0);
    expect(host.queries.filter((query) => query.method === "Input.dispatchMouseEvent")).toHaveLength(1);
    expect(host.queries.some((query) => host.script(query).includes("var base = { bubbles"))).toBe(false);
  });

  it("半按下不降级重放", async () => {
    const host = new Host();
    host.override = (query) => asRecord(query.params)?.["type"] === "mouseReleased" ? { ok: false, error: "release failed" } : undefined;
    const text = await run(host, batch([{ action: "click", selector: "#go" }, fill("#last")]));
    expect(text).toContain("pressed state");
    expect(text).toContain("[uncertain]");
    expect(host.writes).toHaveLength(0);
    expect(host.queries.filter((query) => query.method === "Input.dispatchMouseEvent")).toHaveLength(2);
  });

  it("快导航：loading 未被采到，但新文档身份+宿主 ready 可确认", async () => {
    const host = new Host();
    host.override = (query) => {
      if (asRecord(query.params)?.["type"] === "mouseReleased") { host.origin = 2; host.url = "http://fixture/next"; }
      return undefined;
    };
    const text = await run(host, batch([
      { action: "click", selector: "#next", wait_for: { until: "load" } }, fill("#next-field"),
    ]));
    expect(text).toContain("Expected result CONFIRMED");
    expect(text).toContain("document replaced");
    expect(host.writes).toEqual(["#next-field"]);
  });

  it("旧文档 ready 不冒充新页完成", async () => {
    vi.useFakeTimers();
    const host = new Host();
    const promise = run(host, batch([
      { action: "click", selector: "#no-navigation", wait_for: { until: "load", timeout_ms: 100 } }, fill("#last"),
    ]));
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toContain("NOT CONFIRMED");
    expect(host.writes).toHaveLength(0);
  });

  it("同标签占用时明确拒绝，取消后释放占用", async () => {
    const host = new Host();
    host.override = (query) => host.script(query).includes("var VALUE =") ? "pending" : undefined;
    const first = run(host, batch([fill("#first")]));
    await vi.waitFor(() => expect(host.queries.some((query) => host.script(query).includes("var VALUE ="))).toBe(true));
    expect(await run(host, batch([fill("#second")]))).toContain("busy");
    cancelAllBrowserQueries("stop first operation");
    await first;
    host.override = undefined;
    expect(await run(host, batch([fill("#third")]))).toContain("Executed 1/1");
  });

  it("缺省视图只解析一次，之后查询全部固定实际 view_id", async () => {
    const host = new Host();
    await run(host, { action: "batch", steps: [fill("#one"), fill("#two")] });
    expect(host.queries[0]?.view_id).toBeUndefined();
    expect(host.queries.slice(1).every((query) => query.view_id === "fixture-view")).toBe(true);
  });

  it("单步兼容并带同页变化反馈", async () => {
    const host = new Host();
    const text = await run(host, fill("#name", "single"));
    expect(text).toContain('Set <input>');
    expect(text).toContain('value="single"');
    expect(host.writes).toEqual(["#name"]);
  });

  it.each([
    { url: "http://a/detail", title: "详情", expected: "URL changed: http://a/list → http://a/detail" },
    { url: "http://a/list", title: "列表 (3)", expected: 'title changed: "列表" → "列表 (3)"' },
    { url: "http://a/list", title: "列表", expected: "URL unchanged" },
  ])("URL/标题落点由同一份观测回报：$expected", async (after) => {
    const host = new Host();
    let observations = 0;
    host.override = (query) => {
      if (!host.script(query).startsWith(OPERATION_OBSERVATION_MARKER)) return undefined;
      observations += 1;
      const location = observations === 1 ? { url: "http://a/list", title: "列表" } : after;
      return host.evaluate({ projection: { ...host.projection(), ...location }, origin: 1 });
    };
    const text = await run(host, fill("#one"));
    expect(text).toContain(after.expected);
    expect(text).toContain("Set <input>");
  });

  it("没有可见变化不等于没生效，不把快照差异当业务成功", async () => {
    const host = new Host();
    const text = await run(host, { action: "hover", selector: "#one" });
    expect(text).toContain("No observable changes");
    expect(text).toContain("does not prove the action had no effect");
    expect(text).not.toContain("CONFIRMED");
  });

  it("反馈有硬上限且明确标截断", async () => {
    const host = new Host();
    host.override = (query) => {
      if (host.script(query).includes("var VALUE =")) host.text = "large ".repeat(3000);
      return undefined;
    };
    const text = await run(host, batch([fill("#one")]));
    expect(text).toContain("feedback truncated");
    expect(text.length).toBeLessThan(7000);
  });

  it("前置观测失败不执行，后置观测失败不谎报无变化", async () => {
    const host = new Host();
    let observations = 0;
    host.override = (query) => {
      if (!host.script(query).startsWith(OPERATION_OBSERVATION_MARKER)) return undefined;
      observations += 1;
      return observations === 2 ? host.evaluate({ projection: { ok: false, error: 'scope "main" matched nothing' } }) : undefined;
    };
    const text = await performBrowserOperation(batch([fill("#one")]), host.emit);
    expect(host.writes).toEqual(["#one"]);
    expect(text).toContain("feedback unavailable after the action");
    expect(text).not.toContain("No observable changes");
    host.override = (query) => host.script(query).startsWith(OPERATION_OBSERVATION_MARKER) ? { ok: false, error: "view gone" } : undefined;
    expect(await run(host, batch([fill("#two")]))).toContain("No actions were sent");
    expect(host.writes).toEqual(["#one"]);
  });
});
