import { describe, it, expect } from "vitest";
import {
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

  it("逐条列出 id / 状态 / displayed|parked / label / url / 标题", () => {
    const s = formatTabs({
      views: [
        { id: "browser-1", nav: { state: "ready", url: "https://a.example/x", title: "设备台账" }, displayed: true, can_go_back: true },
        { id: "browser-2", nav: { state: "idle" }, displayed: false, can_go_back: false },
        // label 优先于页面标题：三个 tab 挂同一个 dev server 时只有它分得开
        { id: "browser-3", nav: { state: "ready", url: "http://localhost:5173/", title: "Vite App" }, displayed: false, label: "vue-admin dev", can_go_back: false },
      ],
    });
    expect(s).toContain("3 embedded browser view(s)");
    expect(s).toContain("browser-1 [ready, displayed, can-go-back] — 设备台账 https://a.example/x");
    expect(s).toContain("browser-2 [idle, parked]");
    expect(s).toContain('browser-3 [ready, parked] "vue-admin dev" http://localhost:5173/');
    // 提示模型怎么用这些 id —— 否则它只能瞎猜 view_id
    expect(s).toContain("`view_id`");
  });

  it("畸形条目降级成占位而不是抛", () => {
    expect(() => formatTabs({ views: [null, "x", 3] })).not.toThrow();
  });
});

describe("formatRead", () => {
  const VISIBLE = { pending: false };
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

/**
 * Raw text 的过滤是**页面侧**做的（`innerText`），sidecar 只能从 `textFiltered` 这一个位
 * 知道这份文本过滤成没成——旁注就是那个位的发声口。只在**没过滤成**时说话：默认路径本来就没有
 * 隐藏内容，说一句是噪音。
 */
describe("Raw text 的旁注", () => {
  it("textFiltered:false → 明说这一份没过滤（不静默降级）", () => {
    const s = formatRead({ viewId: "browser-1", value: { ok: true, title: "T", text: "x", textFiltered: false }, probe: { pending: false } });
    expect(s).toContain("only text that is actually rendered");
  });

  it("过滤生效时不出现旁注（默认路径无噪音）", () => {
    const s = formatRead({ viewId: "browser-1", value: { ok: true, title: "T", text: "x", textFiltered: true }, probe: { pending: false } });
    expect(s).not.toContain("only text that is actually rendered");
  });

  /** 旁注是**说给下面那段文本听的**：没有正文时它悬空，等于凭空造一个"这里有隐藏内容"的暗示。 */
  it("没有正文时不出现旁注（不悬空）", () => {
    const s = formatRead({ viewId: "browser-1", value: { ok: true, title: "T", text: "", textFiltered: false }, probe: { pending: false } });
    expect(s).not.toContain("only text that is actually rendered");
  });

  /**
   * 帧走**同一份**投影脚本，所以帧的信封也带 `textFiltered`——主文档与帧两处都要调；
   * 漏了帧那半边，跨域原型（内容全在帧里）的 Raw text 就是静默降级的。
   */
  it("帧的文本同样带旁注（两处都调，少一处那半边静默）", () => {
    const s = formatRead(
      { viewId: "browser-1", value: { ok: true, frames: [{ src: "https://x/f", sameOrigin: false, content: null }] }, probe: { pending: false } },
      { frames: [{ url: "https://x/f", value: { ok: true, title: "F", text: "y", textFiltered: false } }] },
    );
    expect(s).toContain("#### Text");
    expect(s).toContain("only text that is actually rendered");
  });
});

describe("formatEval", () => {
  const VISIBLE = { pending: false };

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
 * 可见性旁注**已删除**（parking 让它恒为噪音）。
 *
 * 曾经：隐藏视图里 rAF 停摆、过渡不推进，所以读/动作类结果要带一句"内容可能没渲染"。
 * 现在不显示的视图照常合成，那句话只会让模型把"元素真的不在"误判成"没渲染"——
 * 这条钉住它不会悄悄回来。
 */
describe("可见性旁注（已删）", () => {
  it("任何 probe 都不产出隐藏告警（parking 后恒 visible）", () => {
    const s = formatEval({ viewId: "browser-1", value: { ok: true }, probe: { pending: false } });
    expect(s).not.toContain("hidden");
    expect(s).not.toContain("not rendered");

    const r = formatRead({
      viewId: "browser-1",
      value: { ok: true, title: "T" },
      probe: { pending: false },
    });
    expect(r).toContain("title: T");
    expect(r).not.toContain("hidden");
  });

  it("pending（降级路径上 async 脚本没等到）→ 说清拿到的是 Promise 本身，并给出出路", () => {
    const s = formatEval({
      viewId: "browser-1",
      value: null,
      probe: { pending: true },
    });
    expect(s).toContain("cannot await it");
    expect(s).toContain("window");
  });
});
