import { describe, it, expect } from "vitest";
import {
  NO_BROWSER_HOST_TEXT,
  formatBridgeFailure,
  formatEval,
  formatRead,
  formatTabs,
  type EvalView,
} from "./format.js";

describe("formatBridgeFailure", () => {
  it("透出 Rust 给的错误文本（面向模型的说明，不加工）", () => {
    expect(formatBridgeFailure({ error: "browser view `browser-9` not found. open views: browser-1" }))
      .toContain("browser-9");
  });

  it("超时说清是宿主没回话，而不是笼统的 error", () => {
    const s = formatBridgeFailure({ timedOut: true });
    expect(s).toContain("timed out");
    expect(s).toContain("closed while the call was in flight");
  });

  it("取消（中断/停会话）有独立文案", () => {
    expect(formatBridgeFailure({ cancelled: true, error: "interrupted" })).toContain("cancelled");
  });

  it("三者都缺时不抛", () => {
    expect(() => formatBridgeFailure({})).not.toThrow();
  });
});

describe("formatTabs", () => {
  it("没有视图时给可执行的下一步（而不是一句 empty）", () => {
    expect(formatTabs({ views: [] })).toBe(
      "No embedded browser view is open. Open one in Aide's browser panel (Ctrl+Shift+B), navigate it " +
        "to the page you want, then call this tool again.",
    );
  });

  it("逐条列出 id / 状态 / 可见性 / url / 标题", () => {
    const s = formatTabs({
      views: [
        { id: "browser-1", nav: { state: "ready", url: "https://a.example/x", title: "设备台账" }, displayed: true, can_go_back: true },
        { id: "browser-2", nav: { state: "idle" }, displayed: false, can_go_back: false },
      ],
    });
    expect(s).toContain("2 embedded browser view(s)");
    expect(s).toContain("browser-1 [ready, visible, can-go-back] — 设备台账 https://a.example/x");
    expect(s).toContain("browser-2 [idle, hidden]");
    // 提示模型怎么用这些 id —— 否则它只能瞎猜 view_id
    expect(s).toContain("`view_id`");
  });

  it("畸形条目降级成占位而不是抛", () => {
    expect(() => formatTabs({ views: [null, "x", 3] })).not.toThrow();
  });
});

describe("formatRead", () => {
  const VISIBLE = { visibility: "visible" as const, readyState: "complete", pending: false };
  const envelope = (value: unknown, viewId = "browser-1") => ({ value, viewId, probe: VISIBLE });

  /**
   * 投影脚本回了非对象 → 必须报成失败，不能渲染成"空页面"。
   *
   * ⚠️ **抛异常已不在这条路径上**：`runEval` 拿 CDP 的 `exceptionDetails` 把「抛了」与
   * 「返回了非对象」分开了（见 `runEval.test.ts`）。这里只剩后者。
   */
  it("value 非对象 → 明确说没拿到可用值，而不是空页面", () => {
    const s = formatRead(envelope(null));
    expect(s).toContain("returned no usable value");
    expect(s).not.toContain("## Tables");
  });

  it("信封 ok:false → 投影失败原文", () => {
    expect(formatRead(envelope({ ok: false, error: "page projection failed: boom" })))
      .toContain("page projection failed: boom");
  });

  it("完整骨架按段落渲染", () => {
    const s = formatRead(
      envelope({
        ok: true,
        url: "https://design.example/p/1",
        title: "设备台账管理",
        readyState: "complete",
        truncated: false,
        headings: [{ level: 1, text: "设备台账管理" }],
        tables: [{ caption: null, headers: ["序号", "设备名称"], rows: [["1", "育秧机"]] }],
        fields: [
          { tag: "input", type: "text", name: "deviceName", label: "设备名称", value: "", disabled: false, required: true, options: null },
          { tag: "select", type: "select-one", name: "type", label: "设备类型", value: "", options: [{ text: "育秧机", selected: true }, { text: "撒肥机", selected: false }] },
        ],
        clickables: [{ tag: "button", text: "刷新", href: null, disabled: false }],
        frames: [{ src: "https://other.example/f", sameOrigin: false, content: null }],
        text: "设备台账管理 刷新 添加",
      }),
    );
    expect(s).toContain("view browser-1 · https://design.example/p/1");
    expect(s).toContain("title: 设备台账管理");
    expect(s).toContain("## Outline");
    expect(s).toContain("# 设备台账管理");
    expect(s).toContain("## Tables (1)");
    expect(s).toContain("| 序号 | 设备名称 |");
    expect(s).toContain("| 1 | 育秧机 |");
    expect(s).toContain("## Form fields (2)");
    expect(s).toContain('label="设备名称" name="deviceName"');
    expect(s).toContain("required");
    expect(s).toContain("options=育秧机* | 撒肥机");
    expect(s).toContain("## Clickable elements (1)");
    expect(s).toContain('button "刷新"');
    expect(s).toContain("## Frames (1)");
    // 跨域必须说清"读不到"，否则 agent 会以为这页就这些内容
    expect(s).toContain("CROSS-ORIGIN");
    expect(s).toContain("NOT readable");
    expect(s).toContain("## Raw text");
  });

  it("readyState 未完成时提示可能要重读（不假装内容缺失是页面的错）", () => {
    const s = formatRead(envelope({ ok: true, readyState: "loading", headings: [] }));
    expect(s).toContain("readyState: loading");
    expect(s).toContain("read again");
  });

  it("truncated 时如实标注是部分视图", () => {
    expect(formatRead(envelope({ ok: true, truncated: true }))).toContain("truncated");
  });

  /**
   * 跨域帧的三态必须**可区分**——「读到了」「读不到但有原因」「压根没试」混为一谈，
   * 模型就会据此宣布"这页没内容"（实测蓝湖原型正是跨域 iframe）。
   */
  it("跨域帧：CDP 读到 → 明确标注读取途径 + 渲染内容", () => {
    const s = formatRead(
      envelope({
        ok: true,
        url: "https://host/shell",
        frames: [{ src: "https://other/proto", sameOrigin: false, content: null }],
      }),
      {
        frames: [
          {
            url: "https://other/proto",
            value: { ok: true, title: "设备台账管理", tables: [{ caption: null, headers: ["序号"], rows: [["1"]] }] },
          },
        ],
      },
    );
    expect(s).toContain("cross-origin, read via CDP frame-level evaluation");
    expect(s).toContain("## Frame content 1 — https://other/proto");
    expect(s).toContain("title: 设备台账管理");
    expect(s).toContain("| 序号 |"); // 帧内容用同一套渲染
    expect(s).not.toContain("NOT readable");
  });

  /**
   * 2026-09-16 agent 实测报的 bug：Axure 导出的帧结构面全空（没有 table/input/button）、
   * 内容全在文本里，而**帧文本当初没渲染**——于是「读成功但无结构」渲染成一个只有 title 的
   * 空小节，与「空帧」长得一模一样，它差点据此下错结论。
   */
  it("跨域帧：读成功但没有语义结构 → 必须带上文本 + 显式说明（不许长得像空帧）", () => {
    const s = formatRead(
      envelope({ ok: true, frames: [{ src: "https://axure/workspace.html", sameOrigin: false, content: null }] }),
      {
        frames: [
          {
            url: "https://axure/workspace.html",
            value: { ok: true, title: "工作台", tables: [], fields: [], clickables: [], text: "设备故障上报审核消息 序号 消息内容 操作 去处理" },
          },
        ],
      },
    );
    expect(s).toContain("title: 工作台");
    // 正文必须出现——这是当初漏掉的那一段
    expect(s).toContain("#### Text");
    expect(s).toContain("设备故障上报审核消息");
    // 且必须显式说明「读到了但没结构」，而不是让人以为帧是空的
    expect(s).toContain("read successfully, but it carries no semantic structure");
    expect(s).toContain("browser_eval with `frame`");
  });

  it("跨域帧：读成功、既无结构也无文本 → 说清是页面属性，不是读取失败", () => {
    const s = formatRead(
      envelope({ ok: true, frames: [{ src: "https://x/empty", sameOrigin: false, content: null }] }),
      { frames: [{ url: "https://x/empty", value: { ok: true, title: "空页", tables: [], fields: [], clickables: [], text: "" } }] },
    );
    expect(s).toContain("no extractable structure OR text");
    expect(s).toContain("not a read failure");
  });

  it("跨域帧：有结构时不加那句冗余说明", () => {
    const s = formatRead(
      envelope({ ok: true, frames: [{ src: "https://x/has", sameOrigin: false, content: null }] }),
      {
        frames: [
          { url: "https://x/has", value: { ok: true, title: "有结构", tables: [{ caption: null, headers: ["a"], rows: [["1"]] }], text: "x" } },
        ],
      },
    );
    expect(s).not.toContain("carries no semantic structure");
    expect(s).toContain("| a |");
  });

  it("跨域帧：读不到 → 带原因，而不是笼统的 NOT readable", () => {
    const s = formatRead(
      envelope({ ok: true, frames: [{ src: "https://other/proto", sameOrigin: false, content: null }] }),
      { frames: [{ url: "https://other/proto", value: null, error: "createIsolatedWorld failed: frame detached" }] },
    );
    expect(s).toContain("could NOT be read: createIsolatedWorld failed");
  });

  it("帧级读取整体不可用 → NOTE 带出原因（不静默）", () => {
    const s = formatRead(
      envelope({ ok: true, frames: [{ src: "https://other/p", sameOrigin: false, content: null }] }),
      { frames: [], error: "frame-level reading is unavailable (Page.getFrameTree failed: nope)" },
    );
    expect(s).toContain("NOTE: frame-level reading is unavailable");
    // 整体不可用时保留原文的跨域提示，让模型仍有下一步可走
    expect(s).toContain("Open it at its own URL");
  });

  it("帧内容自身投影失败 → 该帧单独报错，不拖垮整页输出", () => {
    const s = formatRead(
      envelope({ ok: true, title: "外壳", frames: [{ src: "https://o/f", sameOrigin: false, content: null }] }),
      { frames: [{ url: "https://o/f", value: { ok: false, error: "page projection failed: boom" } }] },
    );
    expect(s).toContain("title: 外壳"); // 主文档照常渲染
    expect(s).toContain("projection failed: page projection failed: boom");
  });

  it("字段全缺 / 类型错乱都不抛（data 是 unknown，畸形形状下解引用就会炸成 isError）", () => {
    // 刻意喂垃圾：签名是 EvalView，但格式化器不许假设调用方给对了形状。
    for (const bad of [undefined, 42, "x", [], {}, { value: "not-an-object" }]) {
      expect(() => formatRead(bad as unknown as EvalView)).not.toThrow();
    }
    expect(() => formatRead(envelope({ ok: true, tables: "nope", fields: 3, headings: null }))).not.toThrow();
  });
});

describe("formatEval", () => {
  const VISIBLE = { visibility: "visible" as const, readyState: "complete", pending: false };

  it("把值 JSON 化并标明来源视图", () => {
    const s = formatEval({ viewId: "browser-3", value: { ok: true, count: 2 }, probe: VISIBLE });
    expect(s).toContain("view browser-3");
    expect(s).toContain('"count": 2');
  });

  it("undefined 结果如实写 undefined（不是空串）", () => {
    expect(formatEval({ viewId: "browser-1", value: undefined, probe: VISIBLE })).toContain("undefined");
  });
});

/**
 * 可见性旁注：**只在隐藏时出现**。
 *
 * 正常路径上它每个结果都跟着一行，就成了噪音——模型会学会忽略它，那藏在里面的那条真信息
 * 也就白写了。所以要同时钉住"说"和"不说"两边。
 */
describe("可见性旁注", () => {
  const probe = (visibility: "visible" | "hidden" | "unknown") => ({ visibility, pending: false });

  it("隐藏 → 明说视图不可见，且点名「空结果是没渲染，不是没有」", () => {
    const s = formatEval({ viewId: "browser-1", value: { ok: true }, probe: probe("hidden") });
    expect(s).toContain("hidden from the engine");
    expect(s).toContain("not rendered");
  });

  it("可见 / 未知 → 一个字都不加（未知时说「可能不可见」也是编的）", () => {
    for (const v of ["visible", "unknown"] as const) {
      const s = formatEval({ viewId: "browser-1", value: { ok: true }, probe: probe(v) });
      expect(s).not.toContain("hidden from the engine");
    }
  });

  it("read 走同一条判据（两处文案会漂移，判据不会）", () => {
    const s = formatRead({
      viewId: "browser-1",
      value: { ok: true, title: "T" },
      probe: probe("hidden"),
    });
    expect(s).toContain("hidden from the engine");
  });

  it("pending（降级路径上 async 脚本没等到）→ 说清拿到的是 Promise 本身，并给出出路", () => {
    const s = formatEval({
      viewId: "browser-1",
      value: null,
      probe: { visibility: "visible", pending: true },
    });
    expect(s).toContain("cannot await it");
    expect(s).toContain("window");
  });
});

describe("NO_BROWSER_HOST_TEXT", () => {
  it("说清是环境没有该能力，而不是暂时不可用（否则模型会重试或找 workaround）", () => {
    expect(NO_BROWSER_HOST_TEXT).toContain("No embedded browser in this environment");
    expect(NO_BROWSER_HOST_TEXT).toContain("desktop app");
    expect(NO_BROWSER_HOST_TEXT).toContain("nothing to read");
  });
});
