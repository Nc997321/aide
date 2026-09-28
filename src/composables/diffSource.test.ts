// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeRound, DiffPair, TouchedFile } from "../types";

const mocks = vi.hoisted(() => ({
  gitDiffPair: vi.fn(),
  readFileContent: vi.fn(async (_p: string) => ""),
}));
vi.mock("../api", () => ({ api: { gitDiffPair: mocks.gitDiffPair, readFileContent: mocks.readFileContent } }));

import { resolveDiff, sessionBaseRev } from "./diffSource";

function pair(over: Partial<DiffPair> = {}): DiffPair {
  return {
    oldText: "old", newText: "new", oldLabel: "a1b2c3d", newLabel: "工作区",
    status: "modified", isBinary: false, eolOnly: false, tooBig: false, ...over,
  };
}
function row(over: Partial<TouchedFile> = {}): TouchedFile {
  return { path: "src/a.ts", status: "M", additions: 1, deletions: 0, segments: [], ...over };
}
function round(index: number, baseRev?: string): ChangeRound {
  return { index, time: "10:00", files: [], baseRev };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveDiff — 口径由声明决定，不看数据形状", () => {
  it("round + 有片段 → 走片段（不碰 git）", async () => {
    const diff = await resolveDiff({
      row: row({ segments: [{ oldText: "x", newText: "y", addCount: 1, delCount: 1 }] }),
      scope: "round",
      workspaceRoot: "C:/repo",
    });
    expect(mocks.gitDiffPair).not.toHaveBeenCalled();
    expect(diff.parts).toHaveLength(1);
  });

  it("session + **有片段** → 仍走 git：口径优先于数据形状", async () => {
    mocks.gitDiffPair.mockResolvedValue(pair());
    await resolveDiff({
      row: row({ segments: [{ oldText: "x", newText: "y", addCount: 1, delCount: 1 }] }),
      scope: "session",
      workspaceRoot: "C:/repo",
      baseRev: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(mocks.gitDiffPair).toHaveBeenCalledTimes(1);
  });

  it("有基线 → Since(rev)，note 写明口径与短号（取自 pair.oldLabel）", async () => {
    mocks.gitDiffPair.mockResolvedValue(pair({ oldLabel: "0123456" }));
    const rev = "0123456789abcdef0123456789abcdef01234567";

    const asRound = await resolveDiff({ row: row(), scope: "round", workspaceRoot: "C:/repo", baseRev: rev });
    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/a.ts", { mode: { kind: "since", rev }, cwd: "C:/repo" });
    expect(asRound.note).toBe("自开轮时的 0123456 到工作区（本轮视图）");

    const asSession = await resolveDiff({ row: row(), scope: "session", workspaceRoot: "C:/repo", baseRev: rev });
    expect(asSession.note).toBe("自会话起点的 0123456 到工作区（会话视图）");
  });

  it("无基线（老会话）→ Unstaged，note 照抄今天那句，一字不改", async () => {
    mocks.gitDiffPair.mockResolvedValue(pair({ oldLabel: "HEAD", newLabel: "工作区" }));
    const diff = await resolveDiff({ row: row(), scope: "round", workspaceRoot: "C:/repo" });

    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/a.ts", { mode: { kind: "unstaged" }, cwd: "C:/repo" });
    expect(diff.note).toBe("累计视图：显示该文件相对 HEAD 的全部差异（非本轮片段）");
  });

  it("基线失效 → 内容仍是 HEAD 视图（不是空壳），note 如实说降级、短号由适配器截取", async () => {
    mocks.gitDiffPair.mockResolvedValue(pair({ oldLabel: "HEAD", baseMissing: true }));
    const rev = "0123456789abcdef0123456789abcdef01234567";

    const diff = await resolveDiff({ row: row(), scope: "round", workspaceRoot: "C:/repo", baseRev: rev });

    expect(diff.note).toBe("基线 0123456 已不在仓库中，退回 HEAD 累计");
    expect(diff.parts[0].pair.newText).toBe("new"); // 内容照旧是 HEAD 视图，不空、不误判为新增
  });
});

describe("sessionBaseRev — 会话起点 = 本会话第一个带基线的轮", () => {
  it("跳过没有基线的轮（老数据 / 非 git 仓库的轮）", () => {
    expect(sessionBaseRev([round(1), round(2, "aaaaaaa"), round(3, "bbbbbbb")])).toBe("aaaaaaa");
  });
  it("全都没有 → undefined（退化为 HEAD 累计）", () => {
    expect(sessionBaseRev([round(1), round(2)])).toBeUndefined();
    expect(sessionBaseRev([])).toBeUndefined();
  });
  it("只看传进来的这一份 rounds —— 跨会话不串", () => {
    expect(sessionBaseRev([round(1)])).toBeUndefined();
  });
});
