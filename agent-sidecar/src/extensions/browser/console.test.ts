// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renderConsole } from "./console.js";

const line = (over: Record<string, unknown> = {}) => ({
  lvl: "log", t: 12, text: 'fast done {"ok":true,"rows":[1,2,3]}', cut: false, len: 33, ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  ok: true, armedBefore: true, cap: 100, total: 1, matched: 1,
  failed: { n: 0, first: null }, items: [line()], ...over,
});

const notes = (over: Record<string, unknown> = {}) => ({ registered: true, ...over });

describe("renderConsole", () => {
  /** uncaught / unhandled 是页面**没接住**的错误——合成 [error] 就把"谁吞了它"抹掉了。 */
  it("uncaught / unhandled 与 console.error 分开显示、按列对齐", () => {
    const s = renderConsole(
      envelope({
        total: 3, matched: 3,
        items: [
          line({ lvl: "uncaught", text: "Uncaught ReferenceError: nope is not defined" }),
          line({ lvl: "error", text: "slow failed NetworkError" }),
          line({ lvl: "warn", text: 'direct warn {"n":7}' }),
        ],
      }),
      notes(),
    );
    expect(s).toContain("Console (last 3 of 3):");
    expect(s).toContain("[uncaught] Uncaught ReferenceError: nope is not defined");
    expect(s).toContain("[error]    slow failed NetworkError");
    expect(s).toContain('[warn]     direct warn {"n":7}');
  });

  /**
   * `[unhandled]` 正好 11 字符 = 定宽列宽本身：pad 不截断也不补空格，正文会**贴着**标签出来
   * （`[unhandled]Unhandled promise rejection…`）。级别标签的用途就是让模型一眼扫列，而
   * unhandled 恰是这批最要紧的两类之一——正文与标签之间**至少要有一个空格**。
   */
  it("unhandled 与正文之间仍有分隔（标签正好占满列宽时不许贴死）", () => {
    const s = renderConsole(
      envelope({ items: [line({ lvl: "unhandled", text: "Unhandled promise rejection: boom" })] }),
      notes(),
    );
    expect(s).toContain("[unhandled] Unhandled promise rejection: boom");
  });

  it("级别过滤生效时表头说清窗口", () => {
    const s = renderConsole(envelope({ total: 9, matched: 4 }), notes({ level: "error" }));
    expect(s).toContain("Console (error only, last 1 of 4 matches, 9 total):");
  });

  it("被 slice 的一行如实标原始长度", () => {
    const s = renderConsole(envelope({ items: [line({ text: "a".repeat(300), cut: true, len: 5120 })] }), notes());
    expect(s).toContain("…(5120 chars)");
  });

  /** 空 ≠ 没有：这次才装上的那次调用，必须明说之前的看不到。 */
  it("armedBefore=false → 明说探针是这次才装上的", () => {
    const s = renderConsole(envelope({ armedBefore: false, total: 0, matched: 0, items: [] }), notes());
    expect(s).toContain("armed in this document by this call");
    expect(s).toContain("not in the buffer");
  });

  it("装了但页面没写过 → 与「没装」区分开", () => {
    const s = renderConsole(envelope({ total: 0, matched: 0, items: [] }), notes());
    expect(s).toContain("Nothing has been written to the console");
    expect(s).not.toContain("by this call");
  });

  it("有记录但全被级别滤掉 → 报出总数，不假装页面是安静的", () => {
    const s = renderConsole(envelope({ total: 9, matched: 0, items: [] }), notes({ level: "warn" }));
    expect(s).toContain('9 entries recorded, none at level "warn"');
  });

  it("注册未来文档失败 → 如实带出原因", () => {
    const s = renderConsole(envelope(), notes({ registered: false, registerError: "…was rejected by the runtime" }));
    expect(s).toContain("rejected by the runtime");
  });

  /** 格式化器铁律：入参是 `unknown`，畸形形状下解引用就会炸成 isError（同 `network.ts`）。 */
  it("字段全缺 / 类型错乱都不抛", () => {
    for (const bad of [null, undefined, 42, "console", { items: "nope", total: "x", matched: null }, { items: [null, 3] }]) {
      expect(() => renderConsole(bad, notes())).not.toThrow();
    }
  });
});
