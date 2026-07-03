import { describe, it, expect, vi } from "vitest";
import { extractFileMentions, resolveFileMentions } from "./fileMentions";

describe("extractFileMentions", () => {
  it("extracts a single @path", () => {
    expect(extractFileMentions("@C:\\Users\\a\\todo.md 看看这个")).toEqual(["C:\\Users\\a\\todo.md"]);
  });

  it("extracts multiple @path mentions, dedup'd", () => {
    expect(extractFileMentions("对比 @/a.ts 和 @/b.ts，再看看 @/a.ts")).toEqual(["/a.ts", "/b.ts"]);
  });

  it("does not match email-like text (@ not preceded by whitespace/start)", () => {
    expect(extractFileMentions("联系 user@example.com 处理")).toEqual([]);
  });

  it("returns empty array when there are no mentions", () => {
    expect(extractFileMentions("普通消息，没有引用")).toEqual([]);
  });
});

describe("resolveFileMentions", () => {
  it("returns text unchanged and no resolved mentions when there are none", async () => {
    const readFile = vi.fn();
    const result = await resolveFileMentions("普通消息", readFile);
    expect(result).toEqual({ sendText: "普通消息", resolved: [] });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("appends resolved file content to sendText, and returns it separately in resolved", async () => {
    const readFile = vi.fn().mockResolvedValue("- [ ] 待办 1\n- [ ] 待办 2");
    const result = await resolveFileMentions("@C:\\todo.md 看下这个", readFile);
    expect(readFile).toHaveBeenCalledWith("C:\\todo.md");
    expect(result.sendText).toContain("@C:\\todo.md 看下这个");
    expect(result.sendText).toContain("--- 引用文件：C:\\todo.md ---");
    expect(result.sendText).toContain("- [ ] 待办 1\n- [ ] 待办 2");
    expect(result.sendText).toContain("--- 文件结束：C:\\todo.md ---");
    expect(result.resolved).toEqual([{ path: "C:\\todo.md", content: "- [ ] 待办 1\n- [ ] 待办 2" }]);
  });

  it("silently keeps original text when a mention fails to read", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("not found"));
    const result = await resolveFileMentions("@/missing.md 看下", readFile);
    expect(result).toEqual({ sendText: "@/missing.md 看下", resolved: [] });
  });

  it("truncates content beyond the size cap in both sendText and resolved", async () => {
    const big = "x".repeat(60_000);
    const readFile = vi.fn().mockResolvedValue(big);
    const result = await resolveFileMentions("@/big.txt", readFile);
    expect(result.sendText).toContain("已截断，完整文件共 60000 字符");
    expect(result.sendText.length).toBeLessThan(big.length + 500);
    expect(result.resolved[0].content).toContain("已截断，完整文件共 60000 字符");
  });

  it("resolves multiple distinct mentions independently", async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce("content A")
      .mockResolvedValueOnce("content B");
    const result = await resolveFileMentions("对比 @/a.md 和 @/b.md", readFile);
    expect(result.sendText).toContain("content A");
    expect(result.sendText).toContain("content B");
    expect(result.resolved).toEqual([
      { path: "/a.md", content: "content A" },
      { path: "/b.md", content: "content B" },
    ]);
  });
});
