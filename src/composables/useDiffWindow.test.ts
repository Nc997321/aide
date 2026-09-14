// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowDiff } from "./useFileViewer";
import type { TouchedFile } from "../types";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async (_path: string, _opts?: { diff?: WindowDiff }) => {}),
  gitDiffPair: vi.fn(async () => ({
    oldText: "head",
    newText: "disk",
    oldLabel: "修改前",
    newLabel: "修改后",
    status: "modified" as const,
    isBinary: false,
    eolOnly: false,
    tooBig: false,
  })),
  readFileContent: vi.fn(async (_path: string) => ""),
}));

vi.mock("../api", () => ({
  api: { gitDiffPair: mocks.gitDiffPair, readFileContent: mocks.readFileContent },
}));

vi.mock("./useFileViewer", () => ({
  useFileViewer: () => ({ open: mocks.open }),
}));

import { useDiffWindow } from "./useDiffWindow";

function touched(over: Partial<TouchedFile> = {}): TouchedFile {
  return { path: "src/a.ts", status: "M", additions: 1, deletions: 0, segments: [], ...over };
}

/** open 收到的窗口载荷（调用点断言用；类型收窄集中在这里）。 */
function openedDiff(): WindowDiff | undefined {
  return mocks.open.mock.calls[0]?.[1]?.diff;
}

describe("useDiffWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFileContent.mockResolvedValue("");
  });

  it("有片段：逐段转 pair，每段带该片段在文件中的真实起始行", async () => {
    // 两段 newText 分别在第 2、4 行——行号必须各自算，不能共用一个偏移
    mocks.readFileContent.mockResolvedValue("l1\nAAA\nl2\nBBB\n");
    const row = touched({
      segments: [
        { oldText: "x", newText: "AAA", addCount: 1, delCount: 1 },
        { oldText: "y", newText: "BBB", addCount: 1, delCount: 1 },
      ],
    });

    await useDiffWindow().openDiff(row, "C:/repo");

    // 有片段就不查 git：本轮的精确 diff 与 HEAD 无关
    expect(mocks.gitDiffPair).not.toHaveBeenCalled();
    const diff = openedDiff();
    expect(diff?.parts).toHaveLength(2);
    expect(diff?.parts[0]).toMatchObject({ firstLine: 2 });
    expect(diff?.parts[1]).toMatchObject({ firstLine: 4 });
    expect(diff?.parts[0]?.pair.newText).toBe("AAA");
    // 片段视图的来源是明确的，不需要标注
    expect(diff?.note).toBeUndefined();
  });

  it("窗口拿绝对路径，git 拿仓库相对路径 + 会话工作区根当 cwd", async () => {
    await useDiffWindow().openDiff(touched(), "C:/repo");

    expect(mocks.open.mock.calls[0]?.[0]).toBe("C:/repo/src/a.ts");
    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/a.ts", { cwd: "C:/repo" });
  });

  it("无片段：回退 git 累计视图（单段）并标注来源", async () => {
    await useDiffWindow().openDiff(touched(), "C:/repo");

    const diff = openedDiff();
    expect(diff?.parts).toHaveLength(1);
    expect(diff?.parts[0]?.pair.newText).toBe("disk");
    expect(diff?.note).toContain("累计视图");
  });

  it("无工作区根：cwd 透传 undefined（后端回落仓库根），窗口仍用原路径", async () => {
    await useDiffWindow().openDiff(touched(), undefined);

    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/a.ts", { cwd: undefined });
    expect(mocks.open.mock.calls[0]?.[0]).toBe("src/a.ts");
  });

  it("新增（A）状态 → pair 标为 added（走新增配色，不当成修改）", async () => {
    mocks.readFileContent.mockResolvedValue("AAA\n");
    const row = touched({
      status: "A",
      segments: [{ oldText: "", newText: "AAA", addCount: 1, delCount: 0 }],
    });

    await useDiffWindow().openDiff(row, "C:/repo");

    const part = openedDiff()?.parts[0];
    expect(part?.pair.status).toBe("added");
    // 新文件没有「文件中的起始行」可言，行号从 1（undefined = 不偏移）
    expect(part?.firstLine).toBeUndefined();
  });

  it("git 取 pair 失败：向上抛（调用方给用户反馈），窗口不打开", async () => {
    mocks.gitDiffPair.mockRejectedValueOnce(new Error("not a git repository"));

    await expect(useDiffWindow().openDiff(touched(), "C:/repo")).rejects.toThrow(
      "not a git repository",
    );
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
