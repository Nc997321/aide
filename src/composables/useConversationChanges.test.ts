import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, nextTick } from "vue";

vi.mock("../api", () => ({
  api: {
    saveSessionChanges: vi.fn().mockResolvedValue(undefined),
    loadSessionChanges: vi.fn().mockResolvedValue([]),
    sessionJsonlSize: vi.fn().mockResolvedValue(100),
    gitDiffFiles: vi.fn().mockResolvedValue([]),
    gitRevertFile: vi.fn().mockResolvedValue(undefined),
    truncateSessionJsonl: vi.fn().mockResolvedValue(undefined),
    stopChatSession: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("./useChatSession", () => ({
  isPendingSession: () => false,
  getLastDispatchedPrompt: () => "test prompt",
}));
vi.mock("./useModal", () => ({
  useModal: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));

import { useConversationChanges, type ChangeRound } from "./useConversationChanges";
import { api } from "../api";

const SID = "uuid-1";

/** 建立带 currentSid 的 hook：sessionId 从空 → SID 触发内部 watch 设置 currentSid
 *  （watch 无 immediate，getter 恒定时不触发，必须真变化一次）。 */
async function mountWithSid() {
  const sidRef = ref("");
  const hook = useConversationChanges(() => sidRef.value);
  await nextTick();
  sidRef.value = SID;
  await nextTick();
  await Promise.resolve(); // watch 回调内 loadSessionChanges await 落定
  return hook;
}
const apiMock = api as unknown as Record<
  "saveSessionChanges" | "loadSessionChanges" | "sessionJsonlSize" | "gitDiffFiles" | "gitRevertFile" | "truncateSessionJsonl" | "stopChatSession",
  ReturnType<typeof vi.fn>
>;

function round(index: number, paths: string[], rewindTo?: number): ChangeRound {
  return {
    index,
    time: "10:00",
    files: paths.map((p) => ({ path: p, status: "M", additions: 1, deletions: 0 })),
    rewindTo,
    prompt: "q",
  };
}

describe("useConversationChanges 用户操作错误处理（P0）", () => {
  beforeEach(() => {
    for (const k of Object.keys(apiMock)) apiMock[k as keyof typeof apiMock].mockClear();
    for (const k of Object.keys(apiMock)) apiMock[k as keyof typeof apiMock].mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("revertSingleFile 恢复文件失败 → 向上抛（用户主动操作不吞）+ console.error", async () => {
    const { rounds, revertSingleFile } = await mountWithSid();
    rounds.value = [round(1, ["a.ts"])];
    apiMock.gitRevertFile.mockRejectedValue(new Error("git revert boom"));

    await expect(revertSingleFile(rounds.value[0], "a.ts")).rejects.toThrow("git revert boom");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[changelog] revert file failed"),
      "a.ts",
      expect.any(Error),
    );
    // 失败不得继续走 save（rounds 保持原状）
    expect(apiMock.saveSessionChanges).not.toHaveBeenCalled();
    expect(rounds.value).toHaveLength(1);
  });

  it("revertRound 截断 .jsonl 失败 → 中止整个回滚（文件恢复循环不执行、rounds 不清理）", async () => {
    const { rounds, revertRound } = await mountWithSid();
    rounds.value = [round(1, ["a.ts"], 42), round(2, ["b.ts"], 80)];
    apiMock.truncateSessionJsonl.mockRejectedValue(new Error("truncate boom"));

    await expect(revertRound(rounds.value[1])).rejects.toThrow("truncate boom");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[changelog] truncate session jsonl failed, revert aborted"),
      expect.any(Error),
    );
    // 半回滚防护：文件一个都没恢复，rounds 也没被清理
    expect(apiMock.gitRevertFile).not.toHaveBeenCalled();
    expect(rounds.value).toHaveLength(2);
  });

  it("revertRound 文件恢复失败 → 中断剩余恢复并抛错（不静默继续）", async () => {
    const { rounds, revertRound } = await mountWithSid();
    rounds.value = [round(1, ["a.ts"], 42), round(2, ["b.ts"], 80)];
    apiMock.gitRevertFile.mockRejectedValue(new Error("revert boom"));

    await expect(revertRound(rounds.value[1])).rejects.toThrow("revert boom");
    // 第一个文件就失败 → 循环中断，rounds 未清理（避免假装成功）
    expect(rounds.value).toHaveLength(2);
  });

  it("revertRound 成功路径：截断 + 恢复该轮及之后所有轮的文件 + 清理轮次", async () => {
    const { rounds, revertRound } = await mountWithSid();
    rounds.value = [round(1, ["a.ts"], 42), round(2, ["b.ts", "c.ts"], 80)];
    apiMock.gitRevertFile.mockResolvedValue(undefined);
    apiMock.truncateSessionJsonl.mockResolvedValue(undefined);
    apiMock.saveSessionChanges.mockResolvedValue(undefined);

    await expect(revertRound(rounds.value[1])).resolves.not.toThrow();
    expect(apiMock.truncateSessionJsonl).toHaveBeenCalledWith(SID, 80);
    // 只恢复 index>=2 的轮（第 1 轮的文件不碰）
    expect(apiMock.gitRevertFile).toHaveBeenCalledTimes(2);
    expect(apiMock.gitRevertFile).toHaveBeenCalledWith("b.ts");
    expect(apiMock.gitRevertFile).toHaveBeenCalledWith("c.ts");
    expect(rounds.value).toHaveLength(1);
    expect(apiMock.saveSessionChanges).toHaveBeenCalledTimes(1);
  });

  it("save 落盘失败 → console.warn 降级（不抛、不阻断主流程）", async () => {
    const { rounds, revertSingleFile } = await mountWithSid();
    rounds.value = [round(1, ["a.ts"])];
    apiMock.gitRevertFile.mockResolvedValue(undefined);
    apiMock.saveSessionChanges.mockRejectedValue(new Error("disk full"));

    await expect(revertSingleFile(rounds.value[0], "a.ts")).resolves.not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[changelog] save session changes failed"),
      expect.any(Error),
    );
  });
});
