import { describe, it, expect, beforeEach } from "vitest";
import { pushInputHistory, resetInputHistory, useInputHistory } from "./useInputHistory";

describe("useInputHistory", () => {
  beforeEach(() => resetInputHistory());

  it("↑ 逐条往回、到头不再动；↓ 往前、翻过最新一条还回原内容", () => {
    pushInputHistory("one");
    pushInputHistory("two");
    const h = useInputHistory();
    expect(h.prev("draft")).toBe("two");
    expect(h.prev("two")).toBe("one");
    expect(h.prev("one")).toBeNull();
    expect(h.next()).toBe("two");
    expect(h.next()).toBe("draft");
    expect(h.browsing()).toBe(false);
    expect(h.next()).toBeNull();
  });

  it("空历史 ↑ 无效果；空白与紧邻重复不记", () => {
    const h = useInputHistory();
    expect(h.prev("")).toBeNull();
    pushInputHistory("  ");
    pushInputHistory("a");
    pushInputHistory("a ");
    expect(h.prev("")).toBe("a");
    expect(h.prev("a")).toBeNull();
  });

  it("reset 结束回溯：下一次 ↑ 从最新一条重新开始", () => {
    pushInputHistory("one");
    pushInputHistory("two");
    const h = useInputHistory();
    h.prev("");
    h.prev("two");
    h.reset();
    expect(h.prev("edited")).toBe("two");
  });
});
