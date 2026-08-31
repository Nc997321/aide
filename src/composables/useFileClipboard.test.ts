import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(async () => undefined),
  moveFile: vi.fn(async () => undefined),
  deleteFile: vi.fn(async () => undefined),
  clipboardWriteFiles: vi.fn(async () => undefined),
  clipboardReadFiles: vi.fn(async () => ({ paths: [] as string[], op: "copy" })),
  prompt: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}));

vi.mock("@aide/sdk/api", () => ({
  api: {
    copyFile: mocks.copyFile,
    moveFile: mocks.moveFile,
    deleteFile: mocks.deleteFile,
    clipboardWriteFiles: mocks.clipboardWriteFiles,
    clipboardReadFiles: mocks.clipboardReadFiles,
  },
}));

// useFileClipboard 模块级单例 modal —— mock 掉才能驱动 prompt/confirm 流转
vi.mock("./useModal", () => ({
  useModal: () => ({ prompt: mocks.prompt, confirm: mocks.confirm }),
}));

import {
  useFileClipboard,
  peekFileClipboard,
  clearFileClipboard,
  getParentPath,
} from "./useFileClipboard";

const { copy, cut, clear, executePaste } = useFileClipboard();

beforeEach(() => {
  vi.clearAllMocks();
  clearFileClipboard();
});

describe("useFileClipboard 多路径剪贴板", () => {
  it("copy/cut 保存多条路径，peek 可读（不写系统剪贴板——拖拽路径）", () => {
    copy(["C:\\proj\\a.ts", "C:\\proj\\b.ts"]);
    expect(peekFileClipboard()).toEqual({ op: "copy", paths: ["C:\\proj\\a.ts", "C:\\proj\\b.ts"] });
    cut(["C:\\proj\\c.rs"]);
    expect(peekFileClipboard()).toEqual({ op: "cut", paths: ["C:\\proj\\c.rs"] });
    expect(mocks.clipboardWriteFiles).not.toHaveBeenCalled();
    clear();
    expect(peekFileClipboard()).toBeNull();
  });

  it("copyWithOs/cutWithOs：应用内条目 + 系统剪贴板双写", async () => {
    const { copyWithOs, cutWithOs } = useFileClipboard();
    copyWithOs(["C:\\proj\\a.ts"]);
    expect(peekFileClipboard()).toEqual({ op: "copy", paths: ["C:\\proj\\a.ts"] });
    await vi.waitFor(() => {
      expect(mocks.clipboardWriteFiles).toHaveBeenCalledWith(["C:\\proj\\a.ts"], "copy");
    });
    cutWithOs(["C:\\proj\\b.ts"]);
    expect(peekFileClipboard()).toEqual({ op: "cut", paths: ["C:\\proj\\b.ts"] });
    await vi.waitFor(() => {
      expect(mocks.clipboardWriteFiles).toHaveBeenLastCalledWith(["C:\\proj\\b.ts"], "cut");
    });
  });

  describe("resolvePasteEntry 粘贴来源解析", () => {
    it("应用内有条目 → 直接用，不读系统剪贴板", async () => {
      copy(["C:\\app\\entry.ts"]);
      const { resolvePasteEntry } = useFileClipboard();
      const entry = await resolvePasteEntry();
      expect(entry).toEqual({ op: "copy", paths: ["C:\\app\\entry.ts"] });
      expect(mocks.clipboardReadFiles).not.toHaveBeenCalled();
     });

    it("应用内为空 → 读系统剪贴板并种为应用内条目（cut op 原样保留）", async () => {
      mocks.clipboardReadFiles.mockResolvedValueOnce({ paths: ["C:\\os\\x.ts"], op: "cut" });
      const { resolvePasteEntry } = useFileClipboard();
      const entry = await resolvePasteEntry();
      expect(entry).toEqual({ op: "cut", paths: ["C:\\os\\x.ts"] });
      // 种进应用内剪贴板：后续 executePaste 直接可用
      expect(peekFileClipboard()).toEqual({ op: "cut", paths: ["C:\\os\\x.ts"] });
    });

    it("两处都为空 → null，不种条目", async () => {
      const { resolvePasteEntry } = useFileClipboard();
      expect(await resolvePasteEntry()).toBeNull();
      expect(peekFileClipboard()).toBeNull();
    });

    it("系统剪贴板读取异常 → null，不向上抛", async () => {
      mocks.clipboardReadFiles.mockRejectedValueOnce("clipboard locked");
      clear();
      const { resolvePasteEntry } = useFileClipboard();
      expect(await resolvePasteEntry()).toBeNull();
    });
  });

  it("多路径复制：逐条 copyFile 到 targetDir，onDestRefresh 收到目标目录", async () => {
    copy(["C:\\src\\a.ts", "C:\\src\\b.ts"]);
    const onDest = vi.fn();
    const onSrc = vi.fn();
    await executePaste("C:\\dst", { onDestRefresh: onDest, onSrcRefresh: onSrc });
    expect(mocks.copyFile).toHaveBeenCalledTimes(2);
    expect(mocks.moveFile).not.toHaveBeenCalled();
    expect(onDest).toHaveBeenCalledWith(["C:\\dst"]);
    expect(onSrc).not.toHaveBeenCalled();
    expect(peekFileClipboard()).toBeNull();
  });

  it("剪切：moveFile + onSrcRefresh 收到去重后的源父目录", async () => {
    cut(["C:\\src\\a.tss", "C:\\src\\b.ts"]);
    const srcCalls: string[][] = [];
    const destCalls: string[][] = [];
    await executePaste("C:\\dst", {
      onSrcRefresh: (dirs) => srcCalls.push(dirs),
      onDestRefresh: (dirs) => destCalls.push(dirs),
    });
    expect(mocks.moveFile).toHaveBeenCalledTimes(2);
    expect(srcCalls).toStrictEqual([["C:\\src"]]); // 两条同父目录去重
    expect(destCalls).toStrictEqual([["C:\\dst"]]);
    expect(getParentPath("C:\\src\\b.ts")).toBe("C:\\src");
  });

  it("EXISTS 冲突 → 确认覆盖 → deleteFile 后重试，回调照常推送", async () => {
    // 后端 invoke 错误以字符串抵达（不带 Error 包装），保持真实形态
    mocks.copyFile.mockRejectedValueOnce("EXISTS:a.ts");
    copy(["C:\\src\\a.ts"]);
    const destCalls: string[][] = [];
    await executePaste("C:\\dst", {
      onDestRefresh: (dirs) => destCalls.push(dirs),
      onSrcRefresh: vi.fn(),
    });
    expect(mocks.confirm).toHaveBeenCalledWith("目标已存在", expect.stringContaining("a.ts"), "覆盖", true);
    expect(mocks.deleteFile).toHaveBeenCalledWith("C:\\dst\\a.ts");
    expect(mocks.copyFile).toHaveBeenCalledTimes(2);
    expect(destCalls).toStrictEqual([["C:\\dst"]]);
  });

  it("EXISTS 冲突 → 取消：该路径跳过，其余路径照常粘贴", async () => {
    mocks.copyFile.mockRejectedValueOnce("EXISTS:a.ts");
    mocks.confirm.mockResolvedValueOnce(false); // 取消覆盖
    copy(["C:\\src\\a.ts", "C:\\src\\b.ts"]);
    const destCalls: string[][] = [];
    await executePaste("C:\\dst", {
      onDestRefresh: (dirs) => destCalls.push(dirs),
      onSrcRefresh: vi.fn(),
    });
    expect(mocks.confirm).toHaveBeenCalledWith("目标已存在", expect.stringContaining("a.ts"), "覆盖", true);
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.copyFile).toHaveBeenCalledTimes(2); // a 失败 + b 成功
    expect(destCalls).toStrictEqual([["C:\\dst"]]);
  });

  it("目标在源子树内 → 拒绝整批，不落任何操作", async () => {
    cut(["C:\\src"]);
    await executePaste("C:\\src\\sub", {
      onDestRefresh: vi.fn(),
      onSrcRefresh: vi.fn(),
    });
    expect(mocks.confirm).toHaveBeenCalledWith("操作无效", expect.stringContaining("子目录"), expect.anything(), expect.anything());
    expect(mocks.moveFile).not.toHaveBeenCalled();
  });

  it("粘贴到相同位置：清剪贴板但不触发任何刷新", async () => {
    copy(["C:\\dst\\a.ts"]);
    const onDest = vi.fn();
    const onSrc = vi.fn();
    await executePaste("C:\\dst", { onDestRefresh: onDest, onSrcRefresh: onSrc });
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(onDest).not.toHaveBeenCalled();
    expect(onSrc).not.toHaveBeenCalled();
    expect(peekFileClipboard()).toBeNull();
  });

  it("非 EXISTS 的异常直接抛出，不清剪贴板", async () => {
    mocks.copyFile.mockRejectedValueOnce("EACCES: denied");
    copy(["C:\\src\\a.ts"]);
    await expect(
      executePaste("C:\\dst", { onDestRefresh: vi.fn(), onSrcRefresh: vi.fn() }),
    ).rejects.toThrow("EACCES");
    expect(peekFileClipboard()).toEqual({ op: "copy", paths: ["C:\\src\\a.ts"] });
  });
});