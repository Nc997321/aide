import { describe, expect, it } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { cmFlash, flashEffect, flashField } from "./cmFlash";

/** 用纯 EditorState（无 DOM）驱动 flashField：dispatch flashEffect 看 DecorationSet。 */
function makeState(doc: string) {
  return EditorState.create({ doc, extensions: [cmFlash()] });
}

/** 收集 flashField 装饰覆盖的 1-based 行号集合 */
function flashLines(state: EditorState): number[] {
  const decos = state.field(flashField);
  const lines: number[] = [];
  decos.between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

describe("cmFlash flashField", () => {
  it("add effect 给目标行范围挂 cm-flash-line 装饰", () => {
    let s = makeState("aaa\nbbb\nccc\nddd");
    s = s.update({ effects: flashEffect.of({ line: 2, count: 2, add: true }) }).state;
    expect(flashLines(s)).toEqual([2, 3]);
  });

  it("count 默认单行（count=1 只挂起始行）", () => {
    let s = makeState("aaa\nbbb\nccc");
    s = s.update({ effects: flashEffect.of({ line: 3, count: 1, add: true }) }).state;
    expect(flashLines(s)).toEqual([3]);
  });

  it("remove effect 清空全部 flash 装饰", () => {
    let s = makeState("aaa\nbbb\nccc");
    s = s.update({ effects: flashEffect.of({ line: 1, count: 3, add: true }) }).state;
    expect(flashLines(s).length).toBe(3);
    s = s.update({ effects: flashEffect.of({ line: 1, count: 0, add: false }) }).state;
    expect(flashLines(s)).toEqual([]);
  });

  it("起始行越界钳制到文档范围内", () => {
    let s = makeState("aaa\nbbb");
    // line=99 超过 doc.lines(2) → 钳到 2
    s = s.update({ effects: flashEffect.of({ line: 99, count: 1, add: true }) }).state;
    expect(flashLines(s)).toEqual([2]);
  });

  it("count 超过文档末尾时 end 钳到最后一行", () => {
    let s = makeState("aaa\nbbb\nccc");
    s = s.update({ effects: flashEffect.of({ line: 2, count: 99, add: true }) }).state;
    expect(flashLines(s)).toEqual([2, 3]);
  });

  it("装饰随文档改动 map（行号移动仍贴对行）", () => {
    let s = makeState("aaa\nbbb\nccc");
    s = s.update({ effects: flashEffect.of({ line: 3, count: 1, add: true }) }).state;
    expect(flashLines(s)).toEqual([3]);
    // 在第 1 行前插入一行 → 原 line 3 变 line 4，装饰应跟随
    s = s.update({ changes: { from: 0, insert: "zzz\n" } }).state;
    expect(flashLines(s)).toEqual([4]);
  });

  it("无 flash effect 的普通 transaction 不改变装饰（初始为空）", () => {
    let s = makeState("aaa\nbbb");
    s = s.update({ changes: { from: 0, insert: "x" } }).state;
    expect(flashLines(s)).toEqual([]);
  });

  it("非 flashEffect 的 effect 被跳过（不影响 flash 装饰）", () => {
    const other = StateEffect.define<number>();
    let s = makeState("aaa\nbbb\nccc");
    s = s.update({ effects: flashEffect.of({ line: 2, count: 1, add: true }) }).state;
    expect(flashLines(s)).toEqual([2]);
    // dispatch 一个无关 effect：flash 装饰应保持不变（line 35 continue 臂）
    s = s.update({ effects: other.of(42) }).state;
    expect(flashLines(s)).toEqual([2]);
  });
});