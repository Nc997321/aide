import { describe, it, expect } from "vitest";
import { decideSpace } from "./space.js";

const spaces = [
  { id: "s1", name: "工程" },
  { id: "s2", name: "产品" },
];

describe("decideSpace", () => {
  it("显式传了 spaceId → 直接用（不校验存在性，服务端会 403/404）", () => {
    expect(decideSpace("s9", spaces)).toEqual({ kind: "ok", id: "s9" });
  });

  it("省略 + 恰好一个可见空间 → 用它", () => {
    expect(decideSpace(undefined, [spaces[0]!])).toEqual({ kind: "ok", id: "s1" });
  });

  it("省略 + 零个可见空间 → 让模型去查成员资格（不是「随便挑一个」）", () => {
    const d = decideSpace(undefined, []);
    expect(d.kind).toBe("ask");
    expect(d.kind === "ask" && d.text).toContain("no knowledge base spaces");
  });

  it("省略 + 多个可见空间 → 列出候选并让模型问用户，绝不自动挑", () => {
    const d = decideSpace(undefined, spaces);
    expect(d.kind).toBe("ask");
    const text = d.kind === "ask" ? d.text : "";
    expect(text).toContain("工程");
    expect(text).toContain("s1");
    expect(text).toContain("产品");
    expect(text).toContain("Ask the user");
  });

  it("空串 spaceId 视同省略（模型可能传 \"\"）", () => {
    expect(decideSpace("", spaces).kind).toBe("ask");
  });
});
