import { describe, it, expect, afterEach } from "vitest";
import type { ChatEvent } from "../engine/types.js";
import { buildBrowserTools } from "./browserTools.js";
import { PAGE_PROJECTION_SCRIPT } from "./browser/projection.js";
import { NO_BROWSER_HOST_TEXT } from "./browser/format.js";
import { cancelAllBrowserQueries, resolveBrowserResult } from "./browserClient.js";

/** 取工具定义（按名字）并直接调 handler —— 与真实模型调用同一条代码路径。 */
/** 内容块是联合：多数工具回文本，截图回 `[文本, 图像]`。 */
type AnyBlock = { type: string; text?: string; data?: string; mimeType?: string };
type AnyTool = {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: AnyBlock[] }>;
};

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

function toolByName(env: NodeJS.ProcessEnv, emit: (e: ChatEvent) => void, name: string): AnyTool {
  const tools = buildBrowserTools(env, emit) as unknown as AnyTool[];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not built`);
  return found;
}

afterEach(() => cancelAllBrowserQueries("test cleanup"));

describe("headless 短路（结构性没有内嵌浏览器）", () => {
  it("工具照挂，但调用**不发桥**、立即回引导文本", async () => {
    const { events, emit } = emitCollector();
    const t = toolByName({ AIDE_HEADLESS: "1" } as NodeJS.ProcessEnv, emit, "browser_read");

    const r = await t.handler({}, {});

    // 核心断言：一条事件都没发出去。发出去 = 白等 15s 超时，
    // 而超时文案会把「本环境没这能力」伪装成「浏览器卡了」。
    expect(events).toHaveLength(0);
    expect(r.content[0].text).toBe(NO_BROWSER_HOST_TEXT);
  });

  it("六个工具都短路（漏一个就会有一个挂 15s）", async () => {
    const env = { AIDE_HEADLESS: "1" } as NodeJS.ProcessEnv;
    for (const name of [
      "browser_tabs",
      "browser_read",
      "browser_act",
      "browser_wait",
      "browser_eval",
      "browser_screenshot",
    ]) {
      const { events, emit } = emitCollector();
      const r = await toolByName(env, emit, name).handler({ script: "1", action: "click", text: "x" }, {});
      expect(events, name).toHaveLength(0);
      expect(r.content[0].text, name).toBe(NO_BROWSER_HOST_TEXT);
    }
  });
});

describe("browser_tabs", () => {
  it("发 list_views 并渲染视图清单", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_tabs").handler({}, {});

    const q = events[0] as any;
    expect(q.type).toBe("browser_query");
    expect(q.op).toBe("list_views");

    resolveBrowserResult({
      request_id: q.request_id,
      ok: true,
      data: { views: [{ id: "browser-1", nav: { state: "ready", url: "https://a/x" }, visible: true }] },
    });
    const r = await p;
    expect(r.content[0].text).toContain("browser-1");
    expect(r.content[0].text).toContain("https://a/x");
  });
});

describe("browser_read", () => {
  it("发 eval，script 恒为通用投影脚本（不是调用方给的东西）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler(
      { view_id: "browser-2" },
      {},
    );

    const q = events[0] as any;
    expectEvalRequest(q, PAGE_PROJECTION_SCRIPT);
    expect(q.view_id).toBe("browser-2");

    reply(q, evalOk({ ok: true, title: "T" }));
    await probeOk(events, 1);
    expect((await p).content[0].text).toContain("title: T");
  });

  /**
   * **权限旁路守卫**：browser_read 是自动放行的读工具，若它接受并透传调用方的 `script`，
   * 就等于绕过了"读工具"的语义，变成任意脚本执行。这条用"塞一个恶意 script 参数"来钉死。
   */
  it("调用方塞进来的 script 参数被无视（否则读工具 = 权限旁路）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler(
      { script: "fetch('/api/delete', {method:'POST'})" },
      {},
    );

    const q = events[0] as any;
    expect(q.params.expression).toContain(PAGE_PROJECTION_SCRIPT);
    expect(q.params.expression).not.toContain("/api/delete");

    reply(q, evalOk({ ok: true }));
    await probeOk(events, 1);
    await p;
  });

  /**
   * 蓝湖那类设计交付工具把原型放在**跨域 iframe** 里——只读骨架会在真正要看的内容前止步。
   * 这条钉住"自动追加帧级读取"，且全程走已有的 call_cdp op（Rust 一行不动）。
   */
  it("骨架里有跨域 iframe → 自动追加 CDP 帧级读取并合进结果", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler({}, {});

    reply(
      await waitForQuery(events, 0),
      evalOk({
        ok: true,
        url: "https://host/shell",
        frames: [{ src: "https://other/proto", sameOrigin: false, content: null }],
      }),
    );
    await probeOk(events, 1);

    const tree = await waitForQuery(events, 2);
    expect(tree.op).toBe("call_cdp");
    expect(tree.method).toBe("Page.getFrameTree");
    reply(tree, {
      ok: true,
      data: {
        value: {
          frameTree: {
            frame: { id: "M", url: "https://host/shell" },
            childFrames: [{ frame: { id: "F", url: "https://other/proto" } }],
          },
        },
      },
    });

    reply(await waitForQuery(events, 3), { ok: true, data: { value: { executionContextId: 5 } } });
    reply(await waitForQuery(events, 4), evalOk({ ok: true, title: "设备台账管理" }));
    await probeOk(events, 5);

    const text = (await p).content[0].text;
    expect(text).toContain("## Frame content 1 — https://other/proto");
    expect(text).toContain("设备台账管理");
  });

  it("骨架里没有跨域帧 → 不追加多余的 CDP 往返", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler({}, {});
    reply(await waitForQuery(events, 0), evalOk({ ok: true, title: "T", frames: [] }));
    await probeOk(events, 1);
    await p;
    expect(events).toHaveLength(2);
  });

  it("桥失败 → Rust 的错误文本原样回到模型", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler({}, {});
    const q = events[0] as any;
    resolveBrowserResult({
      request_id: q.request_id,
      ok: false,
      error: "no embedded browser view is open — open one in the browser panel first.",
    });
    expect((await p).content[0].text).toContain("open one in the browser panel first");
  });
});

describe("browser_eval", () => {
  it("透传调用方的 script（这才是任意脚本的正门）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_eval").handler(
      { script: "document.title" },
      {},
    );
    const q = events[0] as any;
    expectEvalRequest(q, "document.title");

    reply(q, evalOk("设备台账", "string"));
    await probeOk(events, 1);
    expect((await p).content[0].text).toContain("设备台账");
  });
});

/** 等到第 n 条桥请求出现——handler 是**串行**的：结算完上一条才会发下一条。 */
async function waitForQuery(events: ChatEvent[], n: number): Promise<any> {
  for (let i = 0; i < 200 && events.length <= n; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  const q = events[n];
  if (!q) throw new Error(`bridge query #${n} never arrived (got ${events.length})`);
  return q as any;
}

function reply(q: any, body: { ok: boolean; data?: unknown; error?: string }): void {
  resolveBrowserResult({ request_id: q.request_id, ...body });
}

/**
 * 求值走的是 `runEval` → CDP `Runtime.evaluate`，成功回包要带上**包装器**那一层
 * （`{value, visibility, readyState}`）。参数是脚本的返回值，这层由 helper 替它补。
 */
function evalOk(value: unknown, type = "object"): { ok: boolean; data: unknown } {
  return { ok: true, data: { view_id: "browser-1", value: { result: { type, value } } } };
}

/**
 * `runEval` 成功后会**再取一次可见性**（`probeVisibility`）——所以每个成功的求值都是两发。
 * 答掉第二发，省得每条用例自己数下标。
 */
async function probeOk(events: ChatEvent[], i: number): Promise<void> {
  const q = await waitForQuery(events, i);
  expect((q.params as any).expression).toBe("document.visibilityState");
  reply(q, evalOk("visible", "string"));
}

/** 求值请求的断言门面：`op` 与包装形态变了，用例关心的是"跑的是不是那段脚本"。 */
function expectEvalRequest(q: any, scriptFragment: string): void {
  expect(q.op).toBe("call_cdp");
  expect(q.method).toBe("Runtime.evaluate");
  expect(q.params.expression).toContain(scriptFragment);
}

describe("browser_act — 点击的两条路", () => {
  /** 目标解析成功：`{ok:true, hit, x, y}` 是 `buildResolveScript` 的返回值。 */
  const RESOLVED = evalOk({ ok: true, hit: { tag: "button", text: "刷新" }, x: 10, y: 20 });

  it("CDP 可用时走真实输入：mousePressed + mouseReleased 都要发", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "刷新" },
      {},
    );

    const q0 = await waitForQuery(events, 0);
    expectEvalRequest(q0, "TARGET");
    reply(q0, RESOLVED);
    await probeOk(events, 1);

    const q2 = await waitForQuery(events, 2);
    expect(q2.op).toBe("call_cdp");
    expect(q2.method).toBe("Input.dispatchMouseEvent");
    expect(q2.params).toMatchObject({ type: "mousePressed", x: 10, y: 20, button: "left" });
    reply(q2, { ok: true, data: { value: {} } });

    const q3 = await waitForQuery(events, 3);
    expect(q3.params).toMatchObject({ type: "mouseReleased", x: 10, y: 20 });
    reply(q3, { ok: true, data: { value: {} } });

    const text = (await p).content[0].text;
    expect(text).toContain("via CDP");
    expect(text).toContain("刷新");
    expect(events).toHaveLength(4);
  });

  /**
   * 兜底路径**必须自报家门**：合成事件不是可信事件，依赖真实输入的控件（部分下拉、文件选择、
   * 拖拽目标）不会响应。静默降级 = 用户看到"点了但没反应"且无从排查。
   */
  it("CDP 不可用时降级为合成事件，并在结果里说清不是可信事件", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "刷新" },
      {},
    );

    reply(await waitForQuery(events, 0), RESOLVED);
    await probeOk(events, 1);
    reply(await waitForQuery(events, 2), { ok: false, error: "Input domain not supported" });

    const q3 = await waitForQuery(events, 3);
    // 兜底走 sidecar 里的合成事件脚本——**不是**再次 CDP
    expect(q3.op).toBe("call_cdp");
    expect((q3.params as any).expression).toContain("pointerdown");
    reply(q3, evalOk({ ok: true, hit: { tag: "button", text: "刷新" } }));
    await probeOk(events, 4);

    const text = (await p).content[0].text;
    expect(text).toContain("SYNTHETIC");
    expect(text).toContain("not a trusted event");
    expect(text).toContain("Input domain not supported");
    expect(text).toContain("Verify the page actually changed");
  });

  it("按下成功但抬起失败 → 说清可能停在半按下态，而不是当成点成功", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "刷新" },
      {},
    );
    reply(await waitForQuery(events, 0), RESOLVED);
    await probeOk(events, 1);
    reply(await waitForQuery(events, 2), { ok: true, data: { value: {} } });
    reply(await waitForQuery(events, 3), { ok: false, error: "boom" });
    reply(await waitForQuery(events, 4), { ok: false, error: "fallback also failed" });

    const text = (await p).content[0].text;
    expect(text).toContain("pressed state");
  });

  /**
   * **假成功回归**（2026-09-20 走查发现）。
   *
   * CDP 的**方法级拒绝**是一个合法 JSON 响应体（`{error:{code,message}}`），`drill` 只做 JSON
   * 解析，于是它带着 `ok:true` 回到 sidecar。修复前这里会回 "Clicked … via CDP"——**而它根本
   * 没点**。它比"降级了不说"更坏：不是漏报，是报假。
   */
  it("CDP 方法级拒绝（回 ok:true + {error}）→ 绝不报「用真实输入点过了」", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "刷新" },
      {},
    );

    reply(await waitForQuery(events, 0), RESOLVED);
    await probeOk(events, 1);
    reply(await waitForQuery(events, 2), {
      ok: true, // ← 桥层成功
      data: { value: { error: { code: -32601, message: "'Input.dispatchMouseEvent' wasn't found" } } },
    });
    reply(await waitForQuery(events, 3), evalOk({ ok: true, hit: { tag: "button", text: "刷新" } }));
    await probeOk(events, 4);

    const text = (await p).content[0].text;
    expect(text).toContain("SYNTHETIC"); // 走了兜底，而不是报成功
    expect(text).toContain("wasn't found"); // 运行时拒绝的原文要带出来
    expect(text).not.toContain("via CDP at"); // ← 核心：不许出现假的成功句
  });

  it("hover 同样不许把方法级拒绝当成功", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "hover", text: "刷新" },
      {},
    );

    reply(await waitForQuery(events, 0), RESOLVED);
    await probeOk(events, 1);
    reply(await waitForQuery(events, 2), {
      ok: true,
      data: { value: { error: { code: -32601, message: "mouseMoved rejected" } } },
    });

    const text = (await p).content[0].text;
    expect(text).toContain("Hover failed");
    expect(text).toContain("mouseMoved rejected");
    expect(text).not.toContain("Hovered");
  });

  /**
   * 隐藏视图：点击可能落下，但点击后的过渡不会推进——不说这句，模型会把"点完没反应"
   * 判断成"控件坏了"或"没点到"。
   */
  it("视图隐藏时，结果里明说过渡不会推进", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "刷新" },
      {},
    );

    reply(await waitForQuery(events, 0), evalOk({ ok: true, hit: { tag: "button", text: "刷新" }, x: 10, y: 20 }));
    // 可见性来自随后那次独立探测
    reply(await waitForQuery(events, 1), evalOk("hidden", "string"));
    reply(await waitForQuery(events, 2), { ok: true, data: { value: {} } });
    reply(await waitForQuery(events, 3), { ok: true, data: { value: {} } });

    const text = (await p).content[0].text;
    expect(text).toContain("via CDP");
    expect(text).toContain("hidden from the engine");
    expect(text).toContain("will not progress");
  });

  it("目标解析失败 → 带候选清单，且**不发** CDP", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "不存在的按钮" },
      {},
    );
    reply(
      await waitForQuery(events, 0),
      evalOk({
        ok: false,
        error: 'no visible element with text "不存在的按钮"',
        candidates: [{ tag: "button", text: "刷新" }],
      }),
    );
    await probeOk(events, 1);

    const text = (await p).content[0].text;
    expect(text).toContain("Could not find the target");
    expect(text).toContain("刷新"); // 候选清单给模型改口径用
    expect(events).toHaveLength(2); // 解析 + 可见性，没瞎点
  });
});

describe("browser_act — 入参守门（不浪费一次往返）", () => {
  it("既没 text 也没 selector → 直接回文本，不发桥", async () => {
    const { events, emit } = emitCollector();
    const r = await toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click" },
      {},
    );
    expect(events).toHaveLength(0);
    expect(r.content[0].text).toContain("Give a target");
  });

  it("action=fill 缺 value → 直接回文本，不发桥", async () => {
    const { events, emit } = emitCollector();
    const r = await toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "fill", text: "设备名称" },
      {},
    );
    expect(events).toHaveLength(0);
    expect(r.content[0].text).toContain("needs `value`");
  });
});

describe("browser_screenshot — 视觉兜底", () => {
  it("默认截**视口**（用户实际看到的那块），回 [文本, 图像] 两块", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});

    // ① 先判可见：隐藏视图的截图**注定**超时（隐藏的 WebView2 不合成帧），不如立刻如实失败
    await probeOk(events, 0);
    const q = await waitForQuery(events, 1);
    expect(q.op).toBe("call_cdp");
    expect(q.method).toBe("Page.captureScreenshot");
    // 默认 jpeg q80：截图会进会话历史、后续每轮重发，体积是真成本。
    // 默认也不带 captureBeyondViewport——整页会把屏幕外的噪音也带进来。
    expect(q.params).toEqual({ format: "jpeg", quality: 80 });
    reply(q, { ok: true, data: { value: { data: "BASE64JPG" } } });

    const r = await p;
    // caption 复用①那次探测：同一轮里再探一次没有新信息，白多一发往返
    expect(events).toHaveLength(2);
    expect(r.content).toHaveLength(2);
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain("visible viewport");
    // 文本里要复申"这是兜底"——图像很贵，别让模型养成先截图的习惯
    expect(r.content[0].text).toContain("visual fallback");
    // mimeType 必须跟着格式走——猜错会让图像被当成坏数据丢掉
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: "BASE64JPG" });
  });

  it("full_page=true → captureBeyondViewport", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler(
      { full_page: true },
      {},
    );
    await probeOk(events, 0);
    const q = await waitForQuery(events, 1);
    expect(q.params).toEqual({ format: "jpeg", quality: 80, captureBeyondViewport: true });
    reply(q, { ok: true, data: { value: { data: "X" } } });
    expect((await p).content[0].text).toContain("full");
  });

  it("format=png → 不带 quality（CDP 对 png 传它会报错），mimeType 跟着变", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler(
      { format: "png" },
      {},
    );
    await probeOk(events, 0);
    const q = await waitForQuery(events, 1);
    expect(q.params).toEqual({ format: "png" });
    expect(q.params.quality).toBeUndefined();
    reply(q, { ok: true, data: { value: { data: "BASE64PNG" } } });

    const r = await p;
    expect(r.content[0].text).toContain("PNG");
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  /**
   * 视图隐藏 → **压根不试**。隐藏的 WebView2 不合成帧（2026-09-20 真机实测：rAF 一帧不跑），
   * `Page.captureScreenshot` 等不到帧就是 10s 超时，而旧文案还把原因说成 "view closed"。
   * 这条钉住：不发截图请求、不烧那 10 秒、文案点名隐藏与出路。
   */
  it("视图隐藏 → 不发截图请求，文案点名隐藏与出路", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});
    reply(await waitForQuery(events, 0), evalOk("hidden", "string"));

    const r = await p;
    expect(events).toHaveLength(1); // 只有那一次探测
    expect(r.content).toHaveLength(1); // 不发图像块
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain("hidden");
    expect(r.content[0].text).toContain("browser_read");
  });

  /**
   * CDP 域名可用性是运行期变量 → 被拒时必须**如实说清是运行期能力问题**并指向结构化通道，
   * 而不是假装截到了（模型会以为自己在看页面，实际什么都没看到）。
   */
  it("运行期拒绝 → 回文本说明 + 指向 browser_read/eval，不发图像块", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});
    await probeOk(events, 0);
    reply(await waitForQuery(events, 1), {
      ok: true,
      data: { value: { error: { code: -32601, message: "'Page.captureScreenshot' wasn't found" } } },
    });

    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain("rejected by the runtime");
    expect(r.content[0].text).toContain("wasn't found");
    expect(r.content[0].text).toContain("WebView2 runtime capability");
    expect(r.content[0].text).toContain("browser_read");
  });

  it("回了 ok 但没有图像数据 → 如实报错，不塞空图", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});
    await probeOk(events, 0);
    reply(await waitForQuery(events, 1), { ok: true, data: { value: {} } });
    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain("no image data");
  });
});

describe("工具面里不许出现站点名词（换站点 MCP server 一行不动）", () => {
  it("工具名 + 描述 + 投影脚本全无站点痕迹", () => {
    const { emit } = emitCollector();
    const tools = buildBrowserTools({} as NodeJS.ProcessEnv, emit) as unknown as AnyTool[];
    expect(tools.map((t) => t.name)).toEqual([
      "browser_tabs",
      "browser_read",
      "browser_act",
      "browser_wait",
      "browser_eval",
      "browser_screenshot",
    ]);
  });
});
