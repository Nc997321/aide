import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearGaugeProvider,
  countDomNodes,
  readGauges,
  readJsHeapMb,
  resetGaugeProvidersForTest,
  setGaugeProvider,
  type PanelGauges,
} from "./frontendState";

/** 假元素：countDomNodes 只读 `getElementsByTagName("*").length`（不碰几何），
 *  node 环境（vitest environment: node）没有 DOM，用它可以精确数出「真读了几次」。 */
function fakeEl(count: () => number): Element {
  return { getElementsByTagName: () => ({ length: count() }) } as unknown as Element;
}

/** 一块面板的自报数据（只写用例关心的字段，其余给中性值）。 */
function panel(over: Partial<PanelGauges> = {}): PanelGauges {
  return {
    sessionId: "s1",
    rows: 10,
    messages: 5,
    domNodes: 100,
    jsHeapMb: 42,
    landing: false,
    liveHidden: 0,
    ...over,
  };
}

describe("frontendState 冻结现场读数", () => {
  beforeEach(() => {
    resetGaugeProvidersForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetGaugeProvidersForTest();
  });

  it("无面板注册 → 全 0 安全默认值（字段一个不少，panels 为 0）", () => {
    expect(readGauges()).toEqual({
      sessionId: "",
      rows: 0,
      messages: 0,
      domNodes: 0,
      jsHeapMb: 0,
      landing: false,
      liveHidden: 0,
      panels: 0,
    });
  });

  it("domNodes 最大者胜：挂得最多的面板才是冻结的肇事者", () => {
    setGaugeProvider("small", () => panel({ sessionId: "small", domNodes: 100, rows: 3 }));
    setGaugeProvider("big", () => panel({ sessionId: "big", domNodes: 90_000, rows: 400 }));
    setGaugeProvider("mid", () => panel({ sessionId: "mid", domNodes: 5_000, rows: 50 }));
    const g = readGauges();
    expect(g.sessionId).toBe("big");
    expect(g.domNodes).toBe(90_000);
    expect(g.rows).toBe(400);
    expect(g.panels).toBe(3);
  });

  it("注册顺序不影响结果：后注册的小面板不覆盖已在场的大面板", () => {
    setGaugeProvider("big", () => panel({ sessionId: "big", domNodes: 2000 }));
    setGaugeProvider("small", () => panel({ sessionId: "small", domNodes: 1 }));
    expect(readGauges().sessionId).toBe("big");
  });

  it("注销即出表：clear 后面板数减一，读数回落到剩下的最大者", () => {
    setGaugeProvider("a", () => panel({ sessionId: "a", domNodes: 10 }));
    setGaugeProvider("b", () => panel({ sessionId: "b", domNodes: 20 }));
    clearGaugeProvider("b");
    const g = readGauges();
    expect(g.panels).toBe(1);
    expect(g.sessionId).toBe("a");
  });

  it("同 sid 重复注册即覆盖（面板实例换了不留旧闭包）", () => {
    setGaugeProvider("s1", () => panel({ sessionId: "s1", domNodes: 1 }));
    setGaugeProvider("s1", () => panel({ sessionId: "s1", domNodes: 2 }));
    expect(readGauges().domNodes).toBe(2);
    expect(readGauges().panels).toBe(1);
  });

  it("一块面板读数抛错不连坐整个现场：跳过坏的，其余照常比较", () => {
    setGaugeProvider("broken", () => {
      throw new Error("DOM 没了");
    });
    setGaugeProvider("ok", () => panel({ sessionId: "ok", domNodes: 7 }));
    const g = readGauges();
    expect(g.sessionId).toBe("ok");
    expect(g.domNodes).toBe(7);
    expect(g.panels).toBe(2); // 坏的那块仍算注册中（面板确实挂着）
  });

  it("全 0 读数也算一块在场面板：panels 与 domNodes 分开读", () => {
    setGaugeProvider("empty", () => panel({ domNodes: 0, rows: 0, messages: 0 }));
    const g = readGauges();
    expect(g.panels).toBe(1);
    expect(g.domNodes).toBe(0);
  });

  it("每次读数返回新对象（心跳把它序列化进 payload，别共享引用）", () => {
    setGaugeProvider("s1", () => panel());
    expect(readGauges()).not.toBe(readGauges());
  });

  it("countDomNodes：元素缺失给 0；取到元素时读的是它的节点数（不读几何）", () => {
    expect(countDomNodes(null)).toBe(0);
    expect(countDomNodes(undefined)).toBe(0);
    const reads = { n: 0 };
    const el = fakeEl(() => {
      reads.n += 1;
      return 7;
    });
    expect(countDomNodes(el)).toBe(7);
    expect(reads.n).toBe(1);
  });

  it("countDomNodes：4 拍才真数一次，中间拍复用上次读数（采样别变成被测对象）", () => {
    // 真机实测这份读数的代价：DOM 变动后首次数一遍 12 万节点要 ~14ms、30 万 ~28ms
    // （Blink 的集合计数缓存被每次 DOM 变更打掉）。心跳就在被测线程上，每拍数一遍
    // 等于把探针变成被测对象的一部分——所以按拍采样。
    let nodes = 1;
    const el = fakeEl(() => nodes);
    expect(countDomNodes(el)).toBe(1); // 第 1 拍：真数
    nodes = 2;
    expect(countDomNodes(el)).toBe(1); // 第 2/3 拍：不真数 → 仍是旧读数
    expect(countDomNodes(el)).toBe(1);
    expect(countDomNodes(el)).toBe(2); // 第 4 拍：真数，跟上 DOM
  });

  it("readJsHeapMb：读不到 performance.memory 时给 0，不抛", () => {
    expect(typeof readJsHeapMb()).toBe("number");
  });
});
