import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildChangeInfo, locateEditStartLine, parseEditInput } from "./changeCard";

// locateEditStartLine 调 api.readFileContent 读文件——mock 掉，单测不触磁盘
vi.mock("../api", () => ({ api: { readFileContent: vi.fn() } }));
import { api } from "../api";

beforeEach(() => {
  vi.mocked(api.readFileContent).mockReset();
});

describe("parseEditInput", () => {
  it("字段齐全返回对象", () => {
    expect(parseEditInput({ file_path: "a.ts", old_string: "x", new_string: "y" })).toEqual({
      file_path: "a.ts",
      old_string: "x",
      new_string: "y",
    });
  });
  it("缺字段或非法输入返回 null", () => {
    expect(parseEditInput({ file_path: "a.ts" })).toBeNull();
    expect(parseEditInput(null)).toBeNull();
    expect(parseEditInput("x")).toBeNull();
  });
});

describe("buildChangeInfo", () => {
  it("Edit → modified 片段对 + 按行统计", () => {
    const info = buildChangeInfo("Edit", {
      file_path: "/a/b.rs",
      old_string: "x = 1\ny = 2",
      new_string: "x = 3",
    });
    expect(info).toMatchObject({
      filePath: "/a/b.rs",
      addCount: 1,
      delCount: 2,
      anchor: "x = 3",
    });
    expect(info?.pair).toMatchObject({ oldText: "x = 1\ny = 2", newText: "x = 3", status: "modified" });
  });

  it("Write → added，oldText 为空、delCount 为 0", () => {
    const info = buildChangeInfo("Write", { file_path: "/n.py", content: "a\nb\nc" });
    expect(info).toMatchObject({ filePath: "/n.py", addCount: 3, delCount: 0 });
    expect(info?.pair).toMatchObject({ oldText: "", newText: "a\nb\nc", status: "added" });
  });

  it("NotebookEdit：old_source 缺省按纯新增处理", () => {
    const info = buildChangeInfo("NotebookEdit", {
      notebook_path: "/nb.ipynb",
      new_source: "print(1)",
    });
    expect(info).toMatchObject({ filePath: "/nb.ipynb", addCount: 1, delCount: 0 });
    expect(info?.pair.status).toBe("modified");
  });

  it("字段缺失 / 非变更工具 → null（回退普通结果展示）", () => {
    expect(buildChangeInfo("Edit", { file_path: "/a" })).toBeNull();
    expect(buildChangeInfo("Write", { file_path: "/a" })).toBeNull();
    expect(buildChangeInfo("NotebookEdit", { notebook_path: "/a" })).toBeNull();
    expect(buildChangeInfo("Read", { file_path: "/a" })).toBeNull();
    expect(buildChangeInfo("Edit", null)).toBeNull();
  });
});

describe("locateEditStartLine", () => {
  it("added → undefined（Write 新文件行号从 1）", async () => {
    expect(await locateEditStartLine("/a", "x", "added")).toBeUndefined();
  });

  it("空 newText → undefined（纯插入）", async () => {
    expect(await locateEditStartLine("/a", "", "modified")).toBeUndefined();
  });

  it("纯 \\n 文件命中 new_string → 返回片段首行 1-based 行号", async () => {
    // Edit 执行后文件里是 new_string（old 已被替换），故搜 new_string 定位
    vi.mocked(api.readFileContent).mockResolvedValue("aaa\nbbb\nccc");
    // new_string 从第 2 行起，idx 之前跨过 "aaa\n"（含一个 \n）→ 行号 2
    expect(await locateEditStartLine("/a", "bbb\nccc", "modified")).toBe(2);
  });

  it("\\r\\n 文件与片段归一化后命中 → 仍按行号 2", async () => {
    vi.mocked(api.readFileContent).mockResolvedValue("aaa\r\nbbb\r\nccc");
    expect(await locateEditStartLine("/a", "bbb\r\nccc", "modified")).toBe(2);
  });

  it("new_string 首行在第 1 行（idx=0）→ 返回 1", async () => {
    vi.mocked(api.readFileContent).mockResolvedValue("xxx\nyyy");
    expect(await locateEditStartLine("/a", "xxx\nyyy", "modified")).toBe(1);
  });

  it("new_string 不在当前文件（已被后续改动覆盖）→ undefined", async () => {
    vi.mocked(api.readFileContent).mockResolvedValue("xxx\nyyy");
    expect(await locateEditStartLine("/a", "zzz", "modified")).toBeUndefined();
  });

  it("readFileContent 失败 → catch 退化 undefined", async () => {
    vi.mocked(api.readFileContent).mockRejectedValue(new Error("ENOENT"));
    expect(await locateEditStartLine("/a", "bbb\nccc", "modified")).toBeUndefined();
  });
});
