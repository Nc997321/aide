import { describe, it, expect, beforeEach } from "vitest";
import { useScrollMemory } from "./useScrollMemory";

describe("useScrollMemory 滚动位置会话级记忆", () => {
  beforeEach(() => {
    useScrollMemory().__resetForTest();
  });

  it("remember 后 recall 拿回同一位置，模块级共享", () => {
    const a = useScrollMemory();
    a.remember("C:/proj/a.ts#cm", 420);
    // 另一处调用点（指令/扩展各自 useScrollMemory()）看到同一份状态
    expect(useScrollMemory().recall("C:/proj/a.ts#cm")).toBe(420);
  });

  it("未记过的 key 返回 undefined", () => {
    expect(useScrollMemory().recall("C:/proj/never.ts#cm")).toBeUndefined();
  });

  it("同一文件不同视图的 key 互不干扰，重复 remember 覆盖旧值", () => {
    const m = useScrollMemory();
    m.remember("a.md#cm", 100);
    m.remember("a.md#md-preview", 300);
    m.remember("a.md#cm", 150);
    expect(m.recall("a.md#cm")).toBe(150);
    expect(m.recall("a.md#md-preview")).toBe(300);
  });
});
