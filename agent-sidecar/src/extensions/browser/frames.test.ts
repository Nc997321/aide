import { describe, it, expect, afterEach } from "vitest";
import type { ChatEvent } from "../../engine/types.js";
import { evalInFrame, readCrossOriginFrames, readFramesFromResult } from "./frames.js";
import { cancelAllBrowserQueries, resolveBrowserResult } from "../browserClient.js";

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

/** 等到第 n 条桥请求出现（调用是串行的：结算完上一条才会发下一条）。 */
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

/** CDP 回包形状：{view_id, method, value}，value 即 CDP 的返回值本身。 */
const cdpOk = (value: unknown) => ({ ok: true, data: { view_id: "browser-1", method: "x", value } });

afterEach(() => cancelAllBrowserQueries("test cleanup"));

describe("readFramesFromResult — 只在真有读不到的帧时才走 CDP", () => {
  const envelope = (value: unknown) => ({ value });

  it("页面没有 iframe → undefined（不做多余往返）", async () => {
    const { events, emit } = emitCollector();
    const out = await readFramesFromResult("browser-1", envelope({ ok: true, frames: [] }), emit);
    expect(out).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("iframe 全部同源且已读到 → undefined", async () => {
    const { events, emit } = emitCollector();
    const out = await readFramesFromResult(
      "browser-1",
      envelope({ ok: true, frames: [{ src: "https://a/x", sameOrigin: true, content: { title: "t" } }] }),
      emit,
    );
    expect(out).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("骨架本身失败（ok:false / null）→ undefined，不去补帧", async () => {
    const { events, emit } = emitCollector();
    expect(await readFramesFromResult("browser-1", envelope({ ok: false }), emit)).toBeUndefined();
    expect(await readFramesFromResult("browser-1", envelope(null), emit)).toBeUndefined();
    expect(await readFramesFromResult("browser-1", {}, emit)).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("有跨域未读帧 → 走 CDP 帧级求值", async () => {
    const { events, emit } = emitCollector();
    const p = readFramesFromResult(
      "browser-1",
      envelope({
        ok: true,
        url: "https://host/page",
        frames: [{ src: "https://other/frame", sameOrigin: false, content: null }],
      }),
      emit,
    );

    const tree = await waitForQuery(events, 0);
    expect(tree.op).toBe("call_cdp");
    expect(tree.method).toBe("Page.getFrameTree");
    reply(tree, cdpOk({
      frameTree: {
        frame: { id: "MAIN", url: "https://host/page" },
        childFrames: [{ frame: { id: "F1", url: "https://other/frame" } }],
      },
    }));

    const world = await waitForQuery(events, 1);
    expect(world.method).toBe("Page.createIsolatedWorld");
    expect(world.params.frameId).toBe("F1");
    reply(world, cdpOk({ executionContextId: 42 }));

    const evaluated = await waitForQuery(events, 2);
    expect(evaluated.method).toBe("Runtime.evaluate");
    expect(evaluated.params.contextId).toBe(42);
    expect(evaluated.params.returnByValue).toBe(true);
    reply(evaluated, cdpOk({ result: { type: "object", value: { ok: true, title: "原型", tables: [] } } }));

    const out = await p;
    expect(out?.frames).toHaveLength(1);
    expect(out?.frames[0].url).toBe("https://other/frame");
    expect(out?.frames[0].value).toMatchObject({ title: "原型" });
    expect(out?.error).toBeUndefined();
  });

  it("主帧与已读的同源帧被跳过（不重复读）", async () => {
    const { events, emit } = emitCollector();
    const p = readFramesFromResult(
      "browser-1",
      envelope({
        ok: true,
        url: "https://host/page",
        frames: [
          { src: "https://host/same", sameOrigin: true, content: { title: "s" } },
          { src: "https://other/frame", sameOrigin: false, content: null },
        ],
      }),
      emit,
    );

    reply(await waitForQuery(events, 0), cdpOk({
      frameTree: {
        frame: { id: "MAIN", url: "https://host/page" },
        childFrames: [
          { frame: { id: "SAME", url: "https://host/same" } },
          { frame: { id: "OTHER", url: "https://other/frame" } },
        ],
      },
    }));
    const world = await waitForQuery(events, 1);
    expect(world.params.frameId).toBe("OTHER"); // 只读了真正需要的那一帧
    reply(world, cdpOk({ executionContextId: 1 }));
    reply(await waitForQuery(events, 2), cdpOk({ result: { type: "object", value: { ok: true } } }));

    await p;
  });
});

/**
 * 2026-09-16 实测缺口：Axure 导出页全是绝对定位 `<div>`，通用骨架只读得到一个标题。
 * agent 写了自己的抽取脚本，但 `browser_eval` 跑在父页面上下文、够不到跨域帧——**没有入口**。
 * 这组用例钉住那个入口。
 */
describe("evalInFrame — 在跨域帧里跑自定义脚本", () => {
  const TREE = {
    frameTree: {
      frame: { id: "MAIN", url: "https://host/shell" },
      childFrames: [
        { frame: { id: "PROTO", url: "https://axure-file.example/proto.html" } },
        { frame: { id: "SW", url: "https://axure-file.example/sw.html" } },
      ],
    },
  };

  it("按 URL 子串命中帧，脚本在那个帧的上下文里跑", async () => {
    const { events, emit } = emitCollector();
    const p = evalInFrame("browser-1", "proto.html", "({ok:true, tables:1})", emit);

    reply(await waitForQuery(events, 0), cdpOk(TREE));
    const world = await waitForQuery(events, 1);
    expect(world.method).toBe("Page.createIsolatedWorld");
    expect(world.params.frameId).toBe("PROTO"); // 命中的是原型帧，不是 sw 也不是主帧
    reply(world, cdpOk({ executionContextId: 9 }));

    const evaluated = await waitForQuery(events, 2);
    expect(evaluated.params.expression).toBe("({ok:true, tables:1})"); // 跑的是 agent 的脚本
    expect(evaluated.params.contextId).toBe(9);
    reply(evaluated, cdpOk({ result: { type: "object", value: { ok: true, tables: 1 } } }));

    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://axure-file.example/proto.html");
      expect(r.value).toMatchObject({ tables: 1 });
    }
  });

  it("帧找不到 → 列出可用帧让 agent 改口径（不给清单它只能瞎试）", async () => {
    const { events, emit } = emitCollector();
    const p = evalInFrame("browser-1", "nope.example", "1", emit);
    reply(await waitForQuery(events, 0), cdpOk(TREE));

    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("no frame whose URL contains");
      expect(r.available).toEqual([
        "https://host/shell",
        "https://axure-file.example/proto.html",
        "https://axure-file.example/sw.html",
      ]);
    }
  });

  it("帧表取不到 → 如实报错（不抛）", async () => {
    const { events, emit } = emitCollector();
    const p = evalInFrame("browser-1", "x", "1", emit);
    reply(await waitForQuery(events, 0), { ok: false, error: "Page domain unavailable" });
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Page domain unavailable");
  });

  it("帧里脚本抛异常 → 报该帧的异常，不当成成功", async () => {
    const { events, emit } = emitCollector();
    const p = evalInFrame("browser-1", "proto.html", "throw new Error('x')", emit);
    reply(await waitForQuery(events, 0), cdpOk(TREE));
    reply(await waitForQuery(events, 1), cdpOk({ executionContextId: 2 }));
    reply(await waitForQuery(events, 2), cdpOk({ result: { type: "object" }, exceptionDetails: { text: "Uncaught x" } }));

    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("frame script threw");
  });

  it("脚本返回非对象也照收（browser_eval 要能跑任意脚本，不受投影的对象约束）", async () => {
    const { events, emit } = emitCollector();
    const p = evalInFrame("browser-1", "proto.html", "document.title", emit);
    reply(await waitForQuery(events, 0), cdpOk(TREE));
    reply(await waitForQuery(events, 1), cdpOk({ executionContextId: 2 }));
    reply(await waitForQuery(events, 2), cdpOk({ result: { type: "string", value: "工作台" } }));

    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("工作台");
  });
});

describe("降级纪律：CDP 不可用时不许让整个 read 挂掉", () => {
  it("Page.getFrameTree 失败 → 回带原因的空结果（而不是抛）", async () => {
    const { events, emit } = emitCollector();
    const p = readCrossOriginFrames("browser-1", [], emit);
    reply(await waitForQuery(events, 0), { ok: false, error: "Page domain not supported" });

    const out = await p;
    expect(out.frames).toHaveLength(0);
    // 原因必须带出且说清是**运行期能力**问题，不是页面的问题——否则会被读成"这页没内容"
    expect(out.error).toContain("frame-level reading is unavailable");
    expect(out.error).toContain("Page domain not supported");
    expect(out.error).toContain("WebView2 runtime capability");
  });

  it("单帧失败只影响该帧，后续帧继续读", async () => {
    const { events, emit } = emitCollector();
    const p = readCrossOriginFrames("browser-1", [], emit);

    reply(await waitForQuery(events, 0), cdpOk({
      frameTree: {
        frame: { id: "MAIN", url: "https://host/" },
        childFrames: [
          { frame: { id: "F1", url: "https://bad/f1" } },
          { frame: { id: "F2", url: "https://good/f2" } },
        ],
      },
    }));

    // F1：建世界就失败
    reply(await waitForQuery(events, 1), { ok: false, error: "frame detached" });
    // F2：正常
    reply(await waitForQuery(events, 2), cdpOk({ executionContextId: 7 }));
    reply(await waitForQuery(events, 3), cdpOk({ result: { type: "object", value: { ok: true, title: "F2" } } }));

    const out = await p;
    expect(out.frames).toHaveLength(2);
    expect(out.frames[0].value).toBeNull();
    expect(out.frames[0].error).toContain("createIsolatedWorld failed");
    expect(out.frames[1].value).toMatchObject({ title: "F2" });
  });

  it("帧脚本抛异常（CDP 回 ok + exceptionDetails，不算调用失败）→ 该帧记错误", async () => {
    const { events, emit } = emitCollector();
    const p = readCrossOriginFrames("browser-1", [], emit);

    reply(await waitForQuery(events, 0), cdpOk({
      frameTree: { frame: { id: "MAIN", url: "https://host/" }, childFrames: [{ frame: { id: "F1", url: "https://x/f" } }] },
    }));
    reply(await waitForQuery(events, 1), cdpOk({ executionContextId: 3 }));
    // 关键：这是 CDP 的**成功**回包，异常信息在 exceptionDetails 里
    reply(await waitForQuery(events, 2), cdpOk({ result: { type: "object" }, exceptionDetails: { text: "Uncaught" } }));

    const out = await p;
    expect(out.frames[0].value).toBeNull();
    expect(out.frames[0].error).toContain("frame script threw");
  });

  it("missing executionContextId → 如实报错，不拿 NaN 去求值", async () => {
    const { events, emit } = emitCollector();
    const p = readCrossOriginFrames("browser-1", [], emit);
    reply(await waitForQuery(events, 0), cdpOk({
      frameTree: { frame: { id: "MAIN", url: "https://host/" }, childFrames: [{ frame: { id: "F1", url: "https://x/f" } }] },
    }));
    reply(await waitForQuery(events, 1), cdpOk({}));

    const out = await p;
    expect(out.frames[0].error).toContain("no executionContextId");
    expect(events).toHaveLength(2); // 没发出 Runtime.evaluate
  });
});
