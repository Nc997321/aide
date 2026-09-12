import { describe, it, expect } from "vitest";
import { ref, nextTick } from "vue";
import { useStreamChunks, SETTLED_MAX_CHARS } from "./useStreamChunks";

/** 建一个源 ref + 累积器，返回推进函数。 */
function make(initial: string, maxChunks = 4) {
  const source = ref(initial);
  const acc = useStreamChunks(source, { maxChunks });
  return {
    ...acc,
    /** 把源推进到 next 并等一拍。 */
    async set(next: string) {
      source.value = next;
      await nextTick();
    },
  };
}

const texts = (a: { chunks: { value: { text: string }[] } }) => a.chunks.value.map((c) => c.text);

describe("useStreamChunks · 首帧", () => {
  it("文本短于尾巴上界 → 全进块表，前缀为空", () => {
    const a = make("abcdef", 4); // 上界 = 4 块 × 2 字 = 8 字
    expect(a.settled.value).toBe("");
    expect(texts(a)).toEqual(["ab", "cd", "ef"]);
  });

  it("文本超过尾巴上界 → 多余的落定成前缀，只有末段成块", () => {
    const a = make("abcdefghij", 4); // 末 8 字成块，前 2 字落定
    expect(a.settled.value).toBe("ab");
    expect(texts(a)).toEqual(["cd", "ef", "gh", "ij"]);
  });

  it("上界为 Infinity → 整段都是尾巴，前缀恒空", () => {
    const a = make("abcdefghij", Infinity);
    expect(a.settled.value).toBe("");
    expect(texts(a)).toEqual(["ab", "cd", "ef", "gh", "ij"]);
  });

  it("空文本 → 两边都空", () => {
    const a = make("", 4);
    expect(a.settled.value).toBe("");
    expect(texts(a)).toEqual([]);
  });
});

describe("useStreamChunks · 追加", () => {
  it("只在尾部追加，已有块不动", async () => {
    const a = make("abcdefghij", 4);
    const before = texts(a);
    await a.set("abcdefghijkl");
    // 触发退役后最老的块并进了前缀，剩下的尾部块文本不变
    expect(a.settled.value).toBe("abcdef");
    expect(texts(a)).toEqual(["gh", "ij", "kl"]);
    expect(before.slice(-2)).toEqual(["gh", "ij"]);
  });

  it("源被整体替换（历史重放/切会话）→ 整表重建", async () => {
    const a = make("abcdefghij", 4);
    await a.set("XY");
    expect(a.settled.value).toBe("");
    expect(texts(a)).toEqual(["XY"]);
  });
});

describe("useStreamChunks · 触顶退役", () => {
  it("块数超过上界 → 最老的一批并进前缀（批量，不是逐块）", async () => {
    const a = make("abcdefghij", 4); // settled=ab, chunks=[cd,ef,gh,ij]
    await a.set("abcdefghijkl"); // 追加 kl → 5 块触顶 → 退役 2 块降到 3
    expect(a.settled.value).toBe("abcdef");
    expect(texts(a)).toEqual(["gh", "ij", "kl"]);
  });

  it("退役后余量内不再改写前缀（前缀重写摊成一批一批）", async () => {
    const a = make("abcdefghij", 4);
    await a.set("abcdefghijkl"); // 退役到 3 块，余量 1
    const settledAfterDrain = a.settled.value;
    await a.set("abcdefghijklmn"); // 回到 4 块，仍在界内 → 不退役
    expect(a.settled.value).toBe(settledAfterDrain);
    expect(texts(a)).toEqual(["gh", "ij", "kl", "mn"]);
  });

  it("再次触顶 → 再退役一批", async () => {
    const a = make("abcdefghij", 4);
    await a.set("abcdefghijkl");
    await a.set("abcdefghijklmnop"); // 追加 op → 5 块 → 再退役 2 块
    expect(a.settled.value).toBe("abcdefghij");
    expect(texts(a)).toEqual(["kl", "mn", "op"]);
  });

  it("上界 Infinity → 永不退役，前缀恒空", async () => {
    const a = make("abcdefghij", Infinity);
    await a.set("abcdefghijklmnopqrst");
    expect(a.settled.value).toBe("");
    expect(a.clipped.value).toBe(false);
    expect(a.chunks.value.length).toBe(10);
  });
});

describe("useStreamChunks · 前缀截断", () => {
  it("前缀在保留上限内 → 不截断", () => {
    const a = make("x".repeat(SETTLED_MAX_CHARS + 8), 4); // 前缀恰好 6000
    expect(a.settled.value.length).toBe(SETTLED_MAX_CHARS);
    expect(a.clipped.value).toBe(false);
  });

  it("前缀超出保留上限 → 截尾保留 + 置 clipped", () => {
    const a = make("x".repeat(SETTLED_MAX_CHARS + 100) + "TAILABCD", 4);
    expect(a.settled.value.length).toBe(SETTLED_MAX_CHARS);
    expect(a.clipped.value).toBe(true);
    // 保留的是靠近尾巴的一侧，块表仍是最后 8 字
    expect(texts(a)).toEqual(["TA", "IL", "AB", "CD"]);
  });

  it("截断后继续追加 → 仍保持上限，clipped 不复位", async () => {
    const a = make("x".repeat(SETTLED_MAX_CHARS + 100) + "TAILABCD", 4);
    await a.set("x".repeat(SETTLED_MAX_CHARS + 100) + "TAILABCDEFGH");
    expect(a.settled.value.length).toBe(SETTLED_MAX_CHARS);
    expect(a.clipped.value).toBe(true);
  });
});
