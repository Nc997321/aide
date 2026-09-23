import { describe, it, expect, afterEach } from "vitest";
import type { ChatEvent } from "../engine/types.js";
import { buildBrowserTools } from "./browserTools.js";
import { buildProjectionScript } from "./browser/projection.js";
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

  // 清单与工具表一一对应（`browser_console` 落地后是九条；下面那张表的精确数组是同一份清单，
  // 漏一个这里会当场抛 "tool … not built"）。
  it("九个工具都短路（漏一个就会有一个挂 15s）", async () => {
    const env = { AIDE_HEADLESS: "1" } as NodeJS.ProcessEnv;
    for (const name of [
      "browser_tabs",
      "browser_read",
      "browser_act",
      "browser_wait",
      "browser_eval",
      "browser_screenshot",
      "browser_tab",
      "browser_network",
      "browser_console",
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
    expectEvalRequest(q, buildProjectionScript());
    expect(q.view_id).toBe("browser-2");

    reply(q, evalOk({ ok: true, title: "T" }));
    expect((await p).content[0].text).toContain("title: T");
  });

  it("include_hidden:true → 注入的脚本真的把它打开（默认是关的）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler(
      { view_id: "browser-2", include_hidden: true },
      {},
    );

    const q = events[0] as any;
    expect(q.params.expression).toContain("var INCLUDE_HIDDEN = true;");
    expect(buildProjectionScript()).toContain("var INCLUDE_HIDDEN = false;"); // 缺省那一份仍是关的

    reply(q, evalOk({ ok: true }));
    await p;
  });

  /**
   * 隐藏项默认不列，但**必须报数**：少了这行，"页面结构全空"与"结构全被隐藏筛掉了"在模型
   * 眼里长得一样——正是本项目反复踩的"没读到 ≠ 没有"。
   */
  it("隐藏项计数 → 结果里出一行 NOTE，并给出开关", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler(
      { view_id: "browser-2" },
      {},
    );
    const q = events[0] as any;
    reply(
      q,
      evalOk({
        ok: true,
        title: "T",
        tables: [],
        fields: [],
        clickables: [],
        headings: [],
        frames: [],
        text: "",
        hiddenSkipped: { tables: 2, fields: 12, clickables: 0, headings: 0 },
      }),
    );

    const text = (await p).content[0].text;
    expect(text).toContain("2 tables, 12 fields hidden");
    expect(text).toContain("include_hidden");
  });

  /**
   * Raw text 的过滤在**页面侧**做（`innerText`），sidecar 只从脚本标的 `textFiltered` 知道成没成。
   * 这条把工具路径的两端接起来：注入的脚本确实是那段（不是游离 clone 的退化写法），
   * 而脚本标 `false` 时工具输出里必须有一句承认——不许静默降级。
   */
  it("Raw text 没过滤成 → 输出里明说（与脚本的 filtered:false 是同一个契约）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler(
      { view_id: "browser-2" },
      {},
    );

    const q = events[0] as any;
    expect(q.params.expression).toContain("doc.body.innerText");

    reply(
      q,
      evalOk({
        ok: true,
        title: "T",
        tables: [],
        fields: [],
        clickables: [],
        headings: [],
        frames: [],
        text: "x",
        textFiltered: false,
      }),
    );

    const text = (await p).content[0].text;
    expect(text).toContain("## Raw text");
    expect(text).toContain("only text that is actually rendered");
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
    expect(q.params.expression).toContain(buildProjectionScript());
    expect(q.params.expression).not.toContain("/api/delete");

    reply(q, evalOk({ ok: true }));
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

    const tree = await waitForQuery(events, 1);
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

    reply(await waitForQuery(events, 2), { ok: true, data: { value: { executionContextId: 5 } } });
    reply(await waitForQuery(events, 3), evalOk({ ok: true, title: "设备台账管理" }));

    const text = (await p).content[0].text;
    expect(text).toContain("## Frame content 1 — https://other/proto");
    expect(text).toContain("设备台账管理");
  });

  it("骨架里没有跨域帧 → 不追加多余的 CDP 往返", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_read").handler({}, {});
    reply(await waitForQuery(events, 0), evalOk({ ok: true, title: "T", frames: [] }));
    await p;
    expect(events).toHaveLength(1); // 只有投影那一发（可见性探测已删）
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

    const q2 = await waitForQuery(events, 1);
    expect(q2.op).toBe("call_cdp");
    expect(q2.method).toBe("Input.dispatchMouseEvent");
    expect(q2.params).toMatchObject({ type: "mousePressed", x: 10, y: 20, button: "left" });
    reply(q2, { ok: true, data: { value: {} } });

    const q3 = await waitForQuery(events, 2);
    expect(q3.params).toMatchObject({ type: "mouseReleased", x: 10, y: 20 });
    reply(q3, { ok: true, data: { value: {} } });

    const text = (await p).content[0].text;
    expect(text).toContain("via CDP");
    expect(text).toContain("刷新");
    expect(events).toHaveLength(3); // 解析 + press + release（旧实现还多一发可见性探测）
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
    reply(await waitForQuery(events, 1), { ok: false, error: "Input domain not supported" });

    const q3 = await waitForQuery(events, 2);
    // 兜底走 sidecar 里的合成事件脚本——**不是**再次 CDP
    expect(q3.op).toBe("call_cdp");
    expect((q3.params as any).expression).toContain("pointerdown");
    reply(q3, evalOk({ ok: true, hit: { tag: "button", text: "刷新" } }));

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
    reply(await waitForQuery(events, 1), { ok: true, data: { value: {} } });
    reply(await waitForQuery(events, 2), { ok: false, error: "boom" });
    reply(await waitForQuery(events, 3), { ok: false, error: "fallback also failed" });

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
    reply(await waitForQuery(events, 1), {
      ok: true, // ← 桥层成功
      data: { value: { error: { code: -32601, message: "'Input.dispatchMouseEvent' wasn't found" } } },
    });
    reply(await waitForQuery(events, 2), evalOk({ ok: true, hit: { tag: "button", text: "刷新" } }));

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
    reply(await waitForQuery(events, 1), {
      ok: true,
      data: { value: { error: { code: -32601, message: "mouseMoved rejected" } } },
    });

    const text = (await p).content[0].text;
    expect(text).toContain("Hover failed");
    expect(text).toContain("mouseMoved rejected");
    expect(text).not.toContain("Hovered");
  });

  /**
  /**
   * 反向钉子：parking 之后**不再有可见性探测**（不显示的视图照样合成），所以既不多发那一发，
   * 结果里也不该出现任何「隐藏视图」的告警。
   */
  it("点击成功后**没有**可见性告警，也不多发探测那一发", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "刷新" },
      {},
    );

    reply(await waitForQuery(events, 0), evalOk({ ok: true, hit: { tag: "button", text: "刷新" }, x: 10, y: 20 }));
    reply(await waitForQuery(events, 1), { ok: true, data: { value: {} } });
    reply(await waitForQuery(events, 2), { ok: true, data: { value: {} } });

    const text = (await p).content[0].text;
    expect(text).toContain("via CDP");
    expect(text).not.toContain("hidden");
    expect(events).toHaveLength(3); // 解析 + press + release，没有第四发
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

    const text = (await p).content[0].text;
    expect(text).toContain("Could not find the target");
    expect(text).toContain("刷新"); // 候选清单给模型改口径用
    expect(events).toHaveLength(1); // 只有解析那一发，没瞎点
  });
});

describe("browser_act — 命中歧义报数", () => {
  /** 用户明确要求：命中歧义**只报一个数字**，不列候选（browser_read 已经能列元素）。 */
  it("命中多个 → 结果里带上 (N elements matched; used index i)", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "click", text: "保存", index: 1 },
      {},
    );
    reply(
      await waitForQuery(events, 0),
      evalOk({ ok: true, hit: { tag: "button", text: "保存" }, x: 10, y: 20, matched: 3, usedIndex: 1 }),
    );
    reply(await waitForQuery(events, 1), { ok: true, data: { value: {} } }); // mousePressed
    reply(await waitForQuery(events, 2), { ok: true, data: { value: {} } }); // mouseReleased

    const text = (await p).content[0].text;
    expect(text).toContain("via CDP");
    expect(text).toContain("(3 elements matched; used index 1)");
  });

  it("只命中一个 → 不报数（不制造噪音）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler({ action: "click", text: "刷新" }, {});
    // **必须是真单命中载荷**（`matched: 1, usedIndex: 0` —— 解析脚本对单命中恒回这个形状）。
    // 省掉这两个字段就变成在测 `Number(undefined) === NaN`：`n <= 1` 被改成 `n < 1` 也照样绿，
    // 而每个普通 `browser_act` 都会开始印 `(1 elements matched; used index 0)`。
    reply(
      await waitForQuery(events, 0),
      evalOk({ ok: true, hit: { tag: "button", text: "刷新" }, x: 10, y: 20, matched: 1, usedIndex: 0 }),
    );
    reply(await waitForQuery(events, 1), { ok: true, data: { value: {} } });
    reply(await waitForQuery(events, 2), { ok: true, data: { value: {} } });

    const text = (await p).content[0].text;
    expect(text).not.toContain("elements matched");
  });

  /**
   * 填值走的是**另一个脚本**（`buildFillScript`），解析结果里没有 `matched` 的话注脚在这条路上
   * 永不出现——三种动作说的是同一件事，报数就得三种都报。
   */
  it("fill 命中多个 → 同样带注脚", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_act").handler(
      { action: "fill", text: "设备名称", value: "泵-01", index: 1 },
      {},
    );
    reply(
      await waitForQuery(events, 0),
      evalOk({ ok: true, hit: { tag: "input", text: "设备名称" }, value: "泵-01", matched: 2, usedIndex: 1 }),
    );

    const text = (await p).content[0].text;
    expect(text).toContain("Set <input>");
    expect(text).toContain("(2 elements matched; used index 1)");
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

    // 第一发就是截图本身：parking 之后不显示的视图照样合成，不再先探可见性
    const q = await waitForQuery(events, 0);
    expect(q.op).toBe("call_cdp");
    expect(q.method).toBe("Page.captureScreenshot");
    // 默认 jpeg q80：截图会进会话历史、后续每轮重发，体积是真成本。
    // 默认也不带 captureBeyondViewport——整页会把屏幕外的噪音也带进来。
    expect(q.params).toEqual({ format: "jpeg", quality: 80 });
    reply(q, { ok: true, data: { value: { data: "BASE64JPG" } } });

    const r = await p;
    expect(events).toHaveLength(1); // 只发截图那一发
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
    const q = await waitForQuery(events, 0);
    expect(q.params).toEqual({ format: "jpeg", quality: 80, captureBeyondViewport: true });
    reply(q, { ok: true, data: { value: { data: "X" } } });
    expect((await p).content[0].text).toContain("page (full)");
    // 没给 text/selector 就不解析元素：老路径一发都不多发（解析只属于裁剪）
    expect(events).toHaveLength(1);
  });

  it("format=png → 不带 quality（CDP 对 png 传它会报错），mimeType 跟着变", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler(
      { format: "png" },
      {},
    );
    const q = await waitForQuery(events, 0);
    expect(q.params).toEqual({ format: "png" });
    expect(q.params.quality).toBeUndefined();
    reply(q, { ok: true, data: { value: { data: "BASE64PNG" } } });

    const r = await p;
    expect(r.content[0].text).toContain("PNG");
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  /**
  /**
   * parking 之后截图不再先探可见性：不显示的视图照样合成（探针实测同字节数），
   * 所以第一发就是 `Page.captureScreenshot` 本身——少一次往返，也没有「隐藏就拒绝」的分支。
   */
  it("不先探可见性：第一发就是 Page.captureScreenshot，并回图像块", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});

    const q = await waitForQuery(events, 0);
    expect(q.method).toBe("Page.captureScreenshot");
    reply(q, { ok: true, data: { value: { data: "QUJD" } } });

    const r = await p;
    expect(r.content).toHaveLength(2); // [文本, 图像]
    expect(r.content[1].type).toBe("image");
    expect(r.content[1].data).toBe("QUJD");
  });

  /**
   * CDP 域名可用性是运行期变量 → 被拒时必须**如实说清是运行期能力问题**并指向结构化通道，
   * 而不是假装截到了（模型会以为自己在看页面，实际什么都没看到）。
   */
  it("运行期拒绝 → 回文本说明 + 指向 browser_read/eval，不发图像块", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});
    reply(await waitForQuery(events, 0), {
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
    reply(await waitForQuery(events, 0), { ok: true, data: { value: {} } });
    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain("no image data");
  });
});

/**
 * 元素级截图（P3-1）：反馈原话是整页截图**全程没用**（图像进上下文很贵），而"只截这个按钮"
 * 常常有用。所以 `text` / `selector` 把裁剪框交给 CDP 的 `clip`——**页面坐标 + scale 1**。
 *
 * 找不到就**如实失败**：退化成整页会让模型以为手里是局部（而它拿到的是一整页）。
 */
describe("browser_screenshot — 元素级裁剪（text / selector）", () => {
  it("给了 text → 先解析元素，再按它的矩形裁剪截图（clip 是页面坐标 + scale 1）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ text: "保存" }, {});

    const probe = await waitForQuery(events, 0);
    expectEvalRequest(probe, "TARGET");
    // 截图**不许**挪动用户正在看的滚动位置（裁剪靠 captureBeyondViewport，不靠滚动）
    expect(probe.params.expression).toContain("var SCROLL = false;");
    reply(probe, evalOk({ ok: true, hit: { tag: "button", text: "保存" }, rect: { x: 40, y: 120, w: 88, h: 32 }, matched: 1, usedIndex: 0 }));
    reply(await waitForQuery(events, 1), { ok: true, data: { value: { data: "QUJD" } } });

    const shot = events[1] as any;
    expect(shot.method).toBe("Page.captureScreenshot");
    expect(shot.params.clip).toEqual({ x: 40, y: 120, width: 88, height: 32, scale: 1 });
    expect(shot.params.captureBeyondViewport).toBe(true);

    const r = await p;
    expect(r.content[1].type).toBe("image");
    // 说明文本要说清这是**元素的裁剪**，不是视口也不是整页
    expect(r.content[0].text).toContain("of 保存");
  });

  /**
   * 图标按钮（没有可见文本、也没有 aria-label）恰是"只截这个按钮"最常指向的目标，而它的
   * `labelOf` 返回的正是**空串**——`?? "the element"` 兜不住空串（空串不是 nullish），
   * caption 会变成 "Screenshot of  in the embedded browser as JPEG."。
   */
  it("元素没有可见标签 → caption 不留空洞，改说 the element", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ selector: ".icon-btn" }, {});
    reply(await waitForQuery(events, 0), evalOk({ ok: true, hit: { tag: "button", text: "" }, rect: { x: 5, y: 6, w: 24, h: 24 } }));
    reply(await waitForQuery(events, 1), { ok: true, data: { value: { data: "QUJD" } } });

    const r = await p;
    expect(r.content[0].text).toContain("Screenshot of the element in the embedded browser");
    expect(r.content[0].text).not.toContain("of  in"); // 空标签留下的那个空洞
  });

  /**
   * 命中多个时裁剪**悄悄取第 0 个**：裁决在解析脚本里（`Math.min` 钳制），但"裁剪的是哪一个"
   * 必须说出来——不说，模型会以为整张图就是它要的那个元素。这句话与 `browser_act` 用的是
   * **同一句**（`matchNote`，从 act.ts 导出），两边不许各说各的。
   */
  it("命中多个 → caption 带上命中数（与 browser_act 同一句注脚）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ selector: ".same" }, {});
    reply(
      await waitForQuery(events, 0),
      evalOk({ ok: true, hit: { tag: "button", text: "确定" }, rect: { x: 1, y: 2, w: 30, h: 30 }, matched: 2, usedIndex: 0 }),
    );
    reply(await waitForQuery(events, 1), { ok: true, data: { value: { data: "QUJD" } } });

    const r = await p;
    expect(r.content[0].text).toContain("of 确定 (2 elements matched; used index 0)");
  });

  it("元素找不到 → **如实失败，不退化成整页截图**", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ text: "没有这个" }, {});
    reply(await waitForQuery(events, 0), evalOk({ ok: false, error: 'no element on the page contains that text "没有这个"' }));

    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain("Could not find the target");
    expect(events).toHaveLength(1); // 关键：**没有再发一次整页截图**
  });

  it("解析到了但矩形不可用（零尺寸）→ 同样如实失败，不发截图", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ text: "隐藏的东西" }, {});
    reply(await waitForQuery(events, 0), evalOk({ ok: true, hit: { tag: "div", text: "隐藏的东西" }, rect: { x: 0, y: 0, w: 0, h: 0 } }));

    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain("no usable box to crop");
    expect(events).toHaveLength(1);
  });

  /** 桥侧失败（视图没了 / 脚本抛了）走 runEval 的文本——照旧原样带出，不加工。 */
  it("解析这一发就失败 → 原样回它的文本，也不发截图", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ selector: "#save" }, {});
    reply(await waitForQuery(events, 0), { ok: false, error: "no embedded browser view is open" });

    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain("no embedded browser view is open");
    expect(events).toHaveLength(1);
  });

  /**
   * 脚本回了非对象 ≠ 页面上没有这个元素：前者要改的是脚本，后者要改的是词。混成一句
   * （"Could not find the target: unknown"）会让模型拿着"找不到目标"的结论去换 `text` 重试。
   */
  it("解析脚本回了非对象 → 说脚本形状的问题，**不谎称**找不到目标", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ selector: "#save" }, {});
    reply(await waitForQuery(events, 0), evalOk("boom", "string"));

    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain("no usable object");
    expect(r.content[0].text).not.toContain("Could not find the target");
    expect(events).toHaveLength(1);
  });

});

describe("browser_network", () => {
  it("先注册新文档（call_cdp）再读（求值），并把缓冲渲染出来", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_network").handler({ view_id: "browser-2" }, {});

    const reg = await waitForQuery(events, 0);
    expect(reg.op).toBe("call_cdp");
    expect(reg.method).toBe("Page.addScriptToEvaluateOnNewDocument");
    reply(reg, { ok: true, data: { view_id: "browser-2", value: { identifier: "1" } } });

    // 读在**注册结算之后**才发（handler 串行）——先答注册这一发，读那一发才会出现。
    const read = await waitForQuery(events, 1);
    expect(read.op).toBe("call_cdp");
    expect(read.method).toBe("Runtime.evaluate");
    expect(read.params.expression).toContain("__aideRec");

    reply(read, { ok: true, data: { view_id: "browser-2", value: { result: { type: "object", value: {
      ok: true, armedBefore: true, cap: 100, total: 1, matched: 1, failed: { n: 1, first: 1 },
      items: [{ kind: "fetch", method: "GET", url: "http://x/api/fail", status: 500, done: true, ms: 12,
                body: '{"error":"No enum constant"}', bodyCut: false, bodyLen: 28, err: null }],
    } } } } });

    const r = await p;
    expect(r.content[0].text).toContain("Network requests");
    expect(r.content[0].text).toContain("500");
    expect(r.content[0].text).toContain("No enum constant");
  });

  /** 注册是**每个视图一次**：第二次读不该再发注册（重发 = 每份新文档跑 N 遍 no-op）。 */
  it("同一视图第二次调用不再重发注册", async () => {
    const { events, emit } = emitCollector();
    const tool = toolByName({} as NodeJS.ProcessEnv, emit, "browser_network");
    // 第一次：注册 + 读
    const p1 = tool.handler({ view_id: "browser-9" }, {});
    reply(await waitForQuery(events, 0), { ok: true, data: { view_id: "browser-9", value: { identifier: "1" } } });
    reply(await waitForQuery(events, 1), evalOk({ ok: true, armedBefore: false, total: 0, matched: 0, items: [], failed: { n: 0, first: null } }));
    await p1;

    // 第二次：只有读
    const before = events.length;
    const p2 = tool.handler({ view_id: "browser-9" }, {});
    const q = await waitForQuery(events, before);
    expect(q.method).toBe("Runtime.evaluate");
    reply(q, evalOk({ ok: true, armedBefore: true, total: 0, matched: 0, items: [], failed: { n: 0, first: null } }));
    const r = await p2;
    expect(r.content[0].text).toContain("No requests recorded");
  });

  it("注册被运行时拒绝 → **照样能读**，但如实说未来文档没覆盖", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_network").handler({}, {});
    reply(await waitForQuery(events, 0), { ok: true, data: { view_id: "browser-1", value: { error: { code: -32601, message: "'Page.addScriptToEvaluateOnNewDocument' wasn't found" } } } });
    reply(await waitForQuery(events, 1), evalOk({ ok: true, armedBefore: false, total: 0, matched: 0, items: [], failed: { n: 0, first: null } }));
    const r = await p;
    expect(r.content[0].text).toContain("rejected by the runtime");
  });
});

describe("browser_console", () => {
  /** 级别与条数必须**同时**进读脚本（页面侧筛）与渲染器（表头如实说）——只进一头就是两套口径。 */
  it("先注册新文档再读：level/limit 进读脚本，同一级别进表头", async () => {
    const { events, emit } = emitCollector();
    // id 挑一个别的用例没碰过的：注册记账（`registeredViews`）是**模块级**的，同文件里复用
    // 上一个用例的 id 会命中记账、第一发就不是注册（读的是"注册的节奏"，不是"读的数"）。
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_console").handler(
      { view_id: "browser-console-1", level: "error", limit: 5 },
      {},
    );

    const reg = await waitForQuery(events, 0);
    expect(reg.op).toBe("call_cdp");
    expect(reg.method).toBe("Page.addScriptToEvaluateOnNewDocument");
    reply(reg, { ok: true, data: { view_id: "browser-console-1", value: { identifier: "1" } } });

    const read = await waitForQuery(events, 1);
    expect(read.method).toBe("Runtime.evaluate");
    expect(read.params.expression).toContain('var KIND = "logs"');
    expect(read.params.expression).toContain('var MATCH = "error"');
    expect(read.params.expression).toContain("var LIMIT = 5;");
    reply(read, evalOk({
      ok: true, armedBefore: true, cap: 100, total: 9, matched: 2, failed: { n: 0, first: null },
      items: [{ lvl: "uncaught", t: 3, text: "Uncaught TypeError: x is not a function", cut: false, len: 36 }],
    }));

    const text = (await p).content[0].text;
    expect(text).toContain("Console (error only, last 1 of 2 matches, 9 total):");
    expect(text).toContain("[uncaught] Uncaught TypeError: x is not a function");
  });

  /** 缺省是 `all` + 30 条（spec §8.2）：缺省的读脚本不过滤，表头不提级别。 */
  it("缺省 level=all、limit=30", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_console").handler({ view_id: "browser-console-2" }, {});
    reply(await waitForQuery(events, 0), { ok: true, data: { view_id: "browser-console-2", value: { identifier: "1" } } });

    const read = await waitForQuery(events, 1);
    expect(read.params.expression).toContain('var MATCH = "all"');
    expect(read.params.expression).toContain("var LIMIT = 30;");
    reply(read, evalOk({
      ok: true, armedBefore: true, cap: 100, total: 1, matched: 1, failed: { n: 0, first: null },
      items: [{ lvl: "log", t: 7, text: "hello", cut: false, len: 5 }],
    }));

    const text = (await p).content[0].text;
    expect(text).toContain("Console (last 1 of 1):");
    expect(text).toContain("[log]      hello");
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
      "browser_tab",
      "browser_network",
      "browser_console",
    ]);
  });
});
