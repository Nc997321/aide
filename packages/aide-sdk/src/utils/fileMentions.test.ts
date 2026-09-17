import { describe, it, expect, vi } from "vitest";
import {
  attachedDirsFrom,
  extractFileMentions,
  formatMentionPath,
  normalizeMentionPath,
  parseMentionPath,
  resolveFileMentions,
  splitMentionSections,
} from "./fileMentions";

describe("parseMentionPath", () => {
  it("parses a trailing line range", () => {
    expect(parseMentionPath("C:\\proj\\a.rs:12-48")).toEqual({
      path: "C:\\proj\\a.rs",
      range: { start: 12, end: 48 },
    });
  });

  it("treats a single line number as a 1-line closed range", () => {
    expect(parseMentionPath("/a.ts:7")).toEqual({ path: "/a.ts", range: { start: 7, end: 7 } });
  });

  it("takes the LAST colon, so a Windows drive letter is not a range", () => {
    expect(parseMentionPath("C:\\proj\\a.rs")).toEqual({ path: "C:\\proj\\a.rs" });
  });

  it("falls back to a plain path on an invalid range (end < start / start < 1)", () => {
    expect(parseMentionPath("/a.ts:0-5")).toEqual({ path: "/a.ts:0-5" });
    expect(parseMentionPath("/a.ts:9-3")).toEqual({ path: "/a.ts:9-3" });
  });

  it("formatMentionPath round-trips parseMentionPath", () => {
    const raw = "C:\\proj\\a.rs:12-48";
    const { path, range } = parseMentionPath(raw);
    expect(formatMentionPath(path, range)).toBe(raw);
    expect(formatMentionPath("/a.ts")).toBe("/a.ts");
  });
});

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
    const result = await resolveFileMentions("普通消息", { readFile });
    expect(result).toEqual({ sendText: "普通消息", resolved: [] });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("appends resolved file content to sendText, and returns it separately in resolved", async () => {
    const readFile = vi.fn().mockResolvedValue("- [ ] 待办 1\n- [ ] 待办 2");
    const result = await resolveFileMentions("@C:\\todo.md 看下这个", { readFile });
    expect(readFile).toHaveBeenCalledWith("C:\\todo.md");
    expect(result.sendText).toContain("@C:\\todo.md 看下这个");
    expect(result.sendText).toContain("--- 引用文件：C:\\todo.md ---");
    expect(result.sendText).toContain("- [ ] 待办 1\n- [ ] 待办 2");
    expect(result.sendText).toContain("--- 文件结束：C:\\todo.md ---");
    expect(result.resolved).toEqual([{ path: "C:\\todo.md", content: "- [ ] 待办 1\n- [ ] 待办 2" }]);
  });

  it("silently keeps original text when a mention fails to read", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("not found"));
    const result = await resolveFileMentions("@/missing.md 看下", { readFile });
    expect(result).toEqual({ sendText: "@/missing.md 看下", resolved: [] });
  });

  it("truncates content beyond the size cap in both sendText and resolved", async () => {
    const big = "x".repeat(60_000);
    const readFile = vi.fn().mockResolvedValue(big);
    const result = await resolveFileMentions("@/big.txt", { readFile });
    expect(result.sendText).toContain("已截断，完整内容共 60000 字符");
    expect(result.sendText.length).toBeLessThan(big.length + 500);
    expect(result.resolved[0].content).toContain("已截断，完整内容共 60000 字符");
  });

  it("resolves multiple distinct mentions independently", async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce("content A")
      .mockResolvedValueOnce("content B");
    const result = await resolveFileMentions("对比 @/a.md 和 @/b.md", { readFile });
    expect(result.sendText).toContain("content A");
    expect(result.sendText).toContain("content B");
    expect(result.resolved).toEqual([
      { path: "/a.md", content: "content A" },
      { path: "/b.md", content: "content B" },
    ]);
  });

  it("slices only the requested line range and keeps the range in the marker", async () => {
    const readFile = vi.fn().mockResolvedValue("L1\nL2\nL3\nL4\nL5");
    const result = await resolveFileMentions("@/a.rs:2-4 看下这段", { readFile });
    expect(readFile).toHaveBeenCalledWith("/a.rs");
    expect(result.resolved).toEqual([{ path: "/a.rs", content: "L2\nL3\nL4", range: { start: 2, end: 4 } }]);
    expect(result.sendText).toContain("--- 引用文件：/a.rs:2-4 ---");
    expect(result.sendText).not.toContain("L5");
  });

  it("clamps a range that runs past EOF instead of throwing", async () => {
    const readFile = vi.fn().mockResolvedValue("L1\nL2");
    const result = await resolveFileMentions("@/a.rs:2-99", { readFile });
    expect(result.resolved[0].content).toBe("L2");
  });

  it("reports an out-of-file range instead of silently dropping the mention", async () => {
    const readFile = vi.fn().mockResolvedValue("L1\nL2");
    const result = await resolveFileMentions("@/a.rs:50-60", { readFile });
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].content).toContain("超出文件长度");
  });

  it("keeps the mention out when the file cannot be read", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("not found"));
    const result = await resolveFileMentions("@/a.rs:2-4 看下", { readFile });
    expect(result).toEqual({ sendText: "@/a.rs:2-4 看下", resolved: [] });
  });
});

describe("resolveFileMentions: 目录引用（@目录 = 授权 + 一级清单）", () => {
  /** readFile 对目录必然失败；只有 `<dir>/CLAUDE.md` 读得到——这一档就是"首次 @"。 */
  function dirIo(dir: string, attachedDirs: string[] = []) {
    return {
      readFile: vi.fn(async (p: string) => {
        if (p === `${dir}/CLAUDE.md`) return "本仓规则：先跑 pnpm test";
        throw new Error("EISDIR");
      }),
      listDir: vi.fn(async () => [
        { name: "src", is_dir: true },
        { name: "readme.md", is_dir: false },
      ]),
      attachedDirs,
    };
  }

  it("readFile 失败但 listDir 成功 → 认成目录，清单与指令进 sendText", async () => {
    const result = await resolveFileMentions("@/repo 看下", dirIo("/repo"));
    expect(result.sendText).toContain("--- 引用目录：/repo ---");
    expect(result.sendText).toContain("--- 目录结束：/repo ---");
    expect(result.sendText).toContain("src/");
    expect(result.sendText).toContain("readme.md");
    // F6：query 全会话只 spawn 一次，systemPrompt 那条当轮不生效——指令文件必须
    // 随目录段当轮送达，否则"对方仓的记忆进上下文"在授权那一轮是空的。
    expect(result.sendText).toContain("本仓规则：先跑 pnpm test");
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].isDir).toBe(true);
    expect(result.resolved[0].path).toBe("/repo");
  });

  it("已在账本内（attachedDirs 命中）→ 只发一行宣告，不重发清单与指令", async () => {
    const io = dirIo("/repo", ["/repo"]);
    const result = await resolveFileMentions("@/repo 再看下", io);
    expect(result.resolved[0].content).toContain("已授权目录：/repo");
    expect(result.resolved[0].content).not.toContain("readme.md");
    expect(result.sendText).not.toContain("本仓规则");
    expect(io.listDir).not.toHaveBeenCalled();
  });

  it("listDir 缺省（老调用点/远端）→ 维持旧行为：目录引用静默忽略", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("EISDIR"));
    const result = await resolveFileMentions("@/repo 看下", { readFile });
    expect(result).toEqual({ sendText: "@/repo 看下", resolved: [] });
  });

  it("listDir 也失败 → 当路径不存在，静默忽略（不抛）", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const listDir = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const result = await resolveFileMentions("@/nope 看下", { readFile, listDir });
    expect(result).toEqual({ sendText: "@/nope 看下", resolved: [] });
  });

  it("尾分隔符归一：@/repo/ 解析成 /repo", async () => {
    const result = await resolveFileMentions("@/repo/ 看下", dirIo("/repo"));
    expect(result.resolved[0].path).toBe("/repo");
    expect(result.sendText).toContain("--- 引用目录：/repo ---");
  });

  it("行号后缀对目录无意义：忽略 range", async () => {
    const result = await resolveFileMentions("@/repo:3-9 看下", dirIo("/repo"));
    expect(result.resolved[0].isDir).toBe(true);
    expect(result.resolved[0].range).toBeUndefined();
  });

  it("一级条目封顶 200 条（先截条目，再走字符截断）", async () => {
    const entries = Array.from({ length: 260 }, (_, i) => ({ name: `f${i}.ts`, is_dir: false }));
    const result = await resolveFileMentions("@/big", {
      readFile: vi.fn().mockRejectedValue(new Error("EISDIR")),
      listDir: vi.fn().mockResolvedValue(entries),
    });
    expect(result.resolved[0].content).toContain("共 260 个条目，已截断");
    expect(result.resolved[0].content).not.toContain("f250.ts");
  });

  it("目录段往返：isDir 从标记回读（重开历史时不能渲染成文件卡）", async () => {
    const { sendText } = await resolveFileMentions("@/repo 看下", dirIo("/repo"));
    expect(splitMentionSections(sendText)).toMatchObject({
      displayText: "@/repo 看下",
      sections: [{ path: "/repo", isDir: true }],
    });
  });
});

describe("attachedDirsFrom / normalizeMentionPath", () => {
  it("筛目录 → 去重（大小写不敏感）→ 剔除会话主根子树", () => {
    const resolution = {
      sendText: "",
      resolved: [
        { path: "C:\\repo", content: "", isDir: true },
        { path: "C:\\repo\\", content: "", isDir: true },
        { path: "c:\\other", content: "", isDir: true },
        { path: "C:\\repo\\a.ts", content: "" },
      ],
    };
    // 主根自己与它的子树都剔掉（本来就能访问，不必授权）
    expect(attachedDirsFrom(resolution, "C:\\repo")).toEqual(["c:\\other"]);
    // 会话主根在别处时，两条目录都进（`C:\repo\` 与 `C:\repo` 是同一个）
    expect(attachedDirsFrom(resolution, "C:\\main")).toEqual(["C:\\repo", "c:\\other"]);
  });

  it("没有会话主根时只做去重", () => {
    const resolution = {
      sendText: "",
      resolved: [
        { path: "/a/", content: "", isDir: true },
        { path: "/a", content: "", isDir: true },
      ],
    };
    expect(attachedDirsFrom(resolution, null)).toEqual(["/a"]);
  });

  it("normalizeMentionPath 只剥尾部分隔符；根路径与空串原样返回", () => {
    expect(normalizeMentionPath("C:\\a\\")).toBe("C:\\a");
    expect(normalizeMentionPath("/a///")).toBe("/a");
    expect(normalizeMentionPath("/")).toBe("/");
    expect(normalizeMentionPath("")).toBe("");
  });
});

describe("splitMentionSections", () => {
  it("returns text unchanged when there are no marker sections", () => {
    expect(splitMentionSections("普通消息，没有引用")).toEqual({
      displayText: "普通消息，没有引用",
      sections: [],
    });
  });

  it("strips a single section out of displayText and returns it structured", () => {
    const text = "@C:\\todo.md 看下这个\n\n--- 引用文件：C:\\todo.md ---\n- [ ] 待办 1\n--- 文件结束：C:\\todo.md ---";
    expect(splitMentionSections(text)).toEqual({
      displayText: "@C:\\todo.md 看下这个",
      sections: [{ path: "C:\\todo.md", content: "- [ ] 待办 1" }],
    });
  });

  it("round-trips what resolveFileMentions generates, including multiple sections", async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce("content A\n多行")
      .mockResolvedValueOnce("content B");
    const { sendText } = await resolveFileMentions("对比 @/a.md 和 @/b.md", { readFile });
    expect(splitMentionSections(sendText)).toEqual({
      displayText: "对比 @/a.md 和 @/b.md",
      sections: [
        { path: "/a.md", content: "content A\n多行" },
        { path: "/b.md", content: "content B" },
      ],
    });
  });

  it("round-trips a ranged mention: range survives the round trip", async () => {
    const readFile = vi.fn().mockResolvedValue("L1\nL2\nL3\nL4");
    const { sendText } = await resolveFileMentions("看下 @/a.rs:2-3", { readFile });
    expect(splitMentionSections(sendText)).toEqual({
      displayText: "看下 @/a.rs:2-3",
      sections: [{ path: "/a.rs", content: "L2\nL3", range: { start: 2, end: 3 } }],
    });
  });

  it("ignores a section whose head/tail paths don't match (not our marker)", () => {
    const text = "正文\n\n--- 引用文件：/a.md ---\n内容\n--- 文件结束：/b.md ---";
    expect(splitMentionSections(text)).toEqual({ displayText: text, sections: [] });
  });

  it("keeps marker-embedded content intact when file content itself contains a fence line", () => {
    // 引用的文件内容里恰好有一行长得像结束标记但路径不同——非贪婪匹配会在
    // 第一个"路径一致"的结束标记处停下，这里验证不会把后续真实段落吞掉。
    const text = [
      "看看",
      "",
      "--- 引用文件：/a.md ---",
      "第一段",
      "--- 文件结束：/a.md ---",
      "",
      "--- 引用文件：/b.md ---",
      "第二段",
      "--- 文件结束：/b.md ---",
    ].join("\n");
    expect(splitMentionSections(text)).toEqual({
      displayText: "看看",
      sections: [
        { path: "/a.md", content: "第一段" },
        { path: "/b.md", content: "第二段" },
      ],
    });
  });
});
