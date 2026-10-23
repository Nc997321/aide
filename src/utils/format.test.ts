import { describe, it, expect } from "vitest";
import { formatContent, formatClockTime } from "./format";

describe("formatContent", () => {
  it("json 缩进美化", () => {
    expect(formatContent('{"a":1,"b":[1,2]}', "json")).toEqual({
      ok: true,
      text: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n',
    });
  });

  it("json 空文件返回空串", () => {
    expect(formatContent("", "json")).toEqual({ ok: true, text: "" });
    expect(formatContent("  \n  ", "json")).toEqual({ ok: true, text: "" });
  });

  it("json 非法报错", () => {
    const r = formatContent('{"a":', "json");
    expect(r.ok).toBe(false);
  });

  it("jsonl 逐行规范化", () => {
    expect(formatContent('{"a":1}\n{"b": 2}\n', "jsonl")).toEqual({
      ok: true,
      text: '{"a":1}\n{"b":2}\n',
    });
  });

  it("jsonl 空行跳过", () => {
    expect(formatContent('{"a":1}\n\n{"b":2}', "jsonl")).toEqual({
      ok: true,
      text: '{"a":1}\n{"b":2}\n',
    });
  });

  it("jsonl 空文件返回空串", () => {
    expect(formatContent("", "jsonl")).toEqual({ ok: true, text: "" });
  });

  it("jsonl 非法行报行号", () => {
    const r = formatContent('{"a":1}\n{oops}\n', "jsonl");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("第 2 行");
  });

  it("不支持的类型", () => {
    const r = formatContent("x", "ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(".ts");
  });
});

describe("formatClockTime", () => {
  const now = new Date(2026, 9, 22, 18, 0);
  it("今天只给时分，往日带日期，跨年带年份", () => {
    expect(formatClockTime(new Date(2026, 9, 22, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatClockTime(new Date(2026, 9, 21, 14, 32).getTime(), now)).toBe("10-21 14:32");
    expect(formatClockTime(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe("2025-12-31 23:59");
  });
});
