// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderNetwork } from "./network.js";

/** 一条请求的最小形状（与页面侧信封一致）。 */
const req = (over: Record<string, unknown> = {}) => ({
  kind: "fetch", method: "GET", url: "http://127.0.0.1:8780/api/ok", status: 200, done: true,
  ms: 95, body: '{"ok":true}', bodyCut: false, bodyLen: 11, err: null, ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  ok: true, armedBefore: true, cap: 100, total: 3, matched: 3,
  failed: { n: 0, first: null }, items: [req()], ...over,
});

const notes = (over: Record<string, unknown> = {}) => ({ registered: true, ...over });

describe("renderNetwork", () => {
  it("一行一条：序号 / 方法 / URL / 状态 / 耗时 / 响应片段", () => {
    const s = renderNetwork(envelope(), notes());
    expect(s).toContain("Network requests (last 1 of 3, newest last):");
    // 序号是**匹配序列里的全局位次**（这份窗口取的是最近 1 条，故是 #3）——与失败摘要里的
    // `first failure #N` 同一套编号，模型才能把摘要指的那条在下面认出来。
    expect(s).toContain("#3 GET  http://127.0.0.1:8780/api/ok");
    expect(s).toContain("→ 200  95ms");
    expect(s).toContain('{"ok":true}');
  });

  /** "审批没推进"经常就是卡在一条永不返回的请求上——而这恰恰是最难自己发现的一条。 */
  it("未结束的请求如实报 pending + 已等待时长", () => {
    const s = renderNetwork(
      envelope({ items: [req({ done: false, status: null, ms: 2400, body: null })] }),
      notes(),
    );
    expect(s).toContain("(pending, 2400ms so far)");
    // 不要第二个耗时列：状态列已经说了 `2400ms so far`，再印一遍是同一份事实两个来源。
    expect(s.match(/2400ms/g)).toHaveLength(1);
  });

  it("失败前置一行摘要（first 在窗口内）", () => {
    // first 必须**真在窗口里**——取 #10 会走成"窗口之前"那一支，而那一支的文案包含这一支的前缀，
    // 断言照样绿（两支各自钉死才算覆盖）。取窗口的**第一行** #11 顺带钉住边界：判定是
    // `first < from`，写成 `<=` 就会把"正好是窗口第一行的失败"误报成"不在下面这段里"。
    const s = renderNetwork(
      envelope({
        total: 12, matched: 12, failed: { n: 2, first: 11 },
        items: [req({ status: 500, body: '{"error":"No enum constant"}' }), req({ url: "http://x/api/approve" })],
      }),
      notes(),
    );
    expect(s).toContain("⚠ 2 of 12 failed — first failure #11");
    expect(s).not.toContain("not in the window below");
  });

  it("first failure 在窗口之前 → 摘要里说明它不在下面这段里", () => {
    const s = renderNetwork(
      envelope({ total: 40, matched: 40, failed: { n: 3, first: 2 }, items: [req(), req()] }),
      notes(),
    );
    expect(s).toContain("first failure #2 (not in the window below)");
  });

  it("status 为 0 / null 且无 err → 如实说「没有状态码」，不当成 200", () => {
    const s = renderNetwork(
      envelope({ items: [req({ status: 0, done: true, ms: 3, body: null })] }),
      notes(),
    );
    expect(s).toContain("(no status code)");
  });

  it("body 被 slice → 标出原始长度，不假装就是全部", () => {
    const s = renderNetwork(
      envelope({ items: [req({ body: "a".repeat(300), bodyCut: true, bodyLen: 5120 })] }),
      notes(),
    );
    expect(s).toContain("…(5120 chars)");
  });

  it("filter 生效时表头说清「匹配了多少 / 总共多少」", () => {
    const s = renderNetwork(envelope({ total: 40, matched: 7 }), notes({ filter: "/api/" }));
    expect(s).toContain('matching "/api/"');
    expect(s).toContain("last 1 of 7 matches, 40 total");
  });

  /**
   * filter 与失败同时出现：分子（`failed.n`）是在**匹配序列**上数的，分母必须同口径。
   * 写成 `of 40` 等于替 33 条从没看过的请求下结论——比不报更坏。
   */
  it("filter 生效且有失败 → 比例说的是「匹配里几条失败」", () => {
    const s = renderNetwork(
      envelope({
        total: 40, matched: 7, failed: { n: 2, first: 6 },
        items: [req({ url: "http://x/api/a" }), req({ url: "http://x/api/b" })],
      }),
      notes({ filter: "/api/" }),
    );
    expect(s).toContain("⚠ 2 of 7 matches failed — first failure #6");
    expect(s).not.toContain("of 40 failed");
  });

  /** 空 ≠ 没有：这次才装上的那次调用，必须明说之前的看不到。 */
  it("armedBefore=false → 明说探针是这次才装上的", () => {
    const s = renderNetwork(envelope({ armedBefore: false, total: 0, matched: 0, items: [] }), notes());
    expect(s).toContain("armed in this document by this call");
    expect(s).toContain("not in the buffer");
  });

  it("装了但一条没有 → 与「没装」区分开", () => {
    const s = renderNetwork(envelope({ total: 0, matched: 0, items: [] }), notes());
    expect(s).toContain("No requests recorded");
    expect(s).not.toContain("by this call");
  });

  /** 第三种空：**有请求，但全被 filter 滤掉**——报出总数，不能让模型读成"页面没发请求"。 */
  it("有请求但全被 filter 滤掉 → 报出总数，且不说成「没有请求」", () => {
    const s = renderNetwork(envelope({ total: 12, matched: 0, items: [] }), notes({ filter: "/api/" }));
    expect(s).toContain('No requests matched "/api/" — 12 were recorded in total.');
  });

  it("注册未来文档失败 → 如实带出原因（不静默）", () => {
    const s = renderNetwork(envelope(), notes({ registered: false, registerError: "…was rejected by the runtime" }));
    expect(s).toContain("rejected by the runtime");
  });

  it("没有状态码但有 err（fetch 被拒）→ 报失败并带原因", () => {
    const s = renderNetwork(
      envelope({ items: [req({ status: null, done: true, err: "Failed to fetch", body: null })], failed: { n: 1, first: 1 } }),
      notes(),
    );
    expect(s).toContain("1 of 3 failed — first failure #1");
    expect(s).toContain("Failed to fetch");
  });
});
