import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, nextTick, effectScope } from "vue";
import { useSessionState } from "./useSessionState";

const fsMocks = vi.hoisted(() => ({
  fsHandler: null as ((e: { payload: string[] }) => void) | null,
  unlistens: 0,
}));

/** chat-event 的订阅回调（归集器的事件入口，模块级只建一次 → 累积多个）。 */
const chatMocks = vi.hoisted(() => ({
  handlers: [] as Array<(e: { payload: unknown }) => void>,
}));

vi.mock("../api", () => ({
  api: {
    saveSessionChanges: vi.fn().mockResolvedValue(undefined),
    appendSessionChange: vi.fn().mockResolvedValue(undefined),
    loadSessionChanges: vi.fn().mockResolvedValue([]),
    sessionJsonlSize: vi.fn().mockResolvedValue(100),
    /** 开轮基线（HEAD 提交）。默认给一个 sha；用例可覆写成 null（非 git）或 reject。 */
    gitHeadRev: vi.fn().mockResolvedValue("0123456789abcdef0123456789abcdef01234567"),
    // gitDiffFiles 保留在 mock 里是为了断言「不再被调用」——归集换了数据源后，
    // 它若被调用就说明又退回了全局工作区 diff。
    gitDiffFiles: vi.fn().mockResolvedValue([]),
    gitRevertFile: vi.fn().mockResolvedValue(undefined),
    truncateSessionJsonl: vi.fn().mockResolvedValue(undefined),
    stopChatSession: vi.fn().mockResolvedValue(undefined),
  },
  listen: vi.fn().mockImplementation(async (ev: string, cb: (e: { payload: unknown }) => void) => {
    if (ev === "chat-event") chatMocks.handlers.push(cb);
    else fsMocks.fsHandler = cb as (e: { payload: string[] }) => void;
    return () => {
      fsMocks.unlistens++;
    };
  }),
}));
vi.mock("./useChatSession", () => ({
  isPendingSession: () => false,
  getLastDispatchedPrompt: () => "test prompt",
  resetPaginationForRevert: () => {},
}));
vi.mock("./useModal", () => ({
  useModal: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));

import {
  useConversationChanges,
  __resetForTest,
  type ChangeRound,
} from "./useConversationChanges";
import { useSessionWorkspaces } from "./useSessionWorkspaces";
import { api, listen } from "../api";

const SID = "uuid-1";
/** 会话所属工作区根：归集器据此把绝对路径收成相对路径，撤回据此传 cwd。 */
const WS_ROOT = "C:/proj";

/** 推一条 chat-event 到归集器（走真实订阅回调）。 */
function emitChat(payload: Record<string, unknown>) {
  for (const h of chatMocks.handlers) h({ payload });
}

/** 变更类工具调用事件——变更归属的唯一入口。 */
function toolUse(sid: string, path: string, oldString = "a", newString = "b") {
  return {
    type: "tool_use_start",
    session_id: sid,
    name: "Edit",
    input: { file_path: path, old_string: oldString, new_string: newString },
  };
}

/** 绑定会话 → 工作区（未绑定的会话不归集）。 */
function bindWs(sid: string, wsPath: string = WS_ROOT) {
  useSessionWorkspaces().setWorkspace(sid, { wsKey: `k-${sid}`, wsPath });
}

/** 挂载 hook：effectScope 隔离（全局 sessionState watch 跨实例共享，
 *  不隔离会让前置实例响应本测试的状态写入、污染调用计数）。 */
const disposers: Array<() => void> = [];

async function mountWithSid(sid = SID) {
  const sidRef = ref("");
  const scope = effectScope();
  const hook = scope.run(() => useConversationChanges(() => sidRef.value))!;
  disposers.push(() => scope.stop());
  await nextTick();
  sidRef.value = sid;
  await nextTick();
  bindWs(sid);
  await flushAsync(); // watch 回调内 loadSessionChanges 链落定
  return { hook, sidRef };
}

/** 冲刷 pendingOp 链上的多层 await（microtask 级，无定时器依赖）。 */
async function flushAsync(n = 12) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const apiMock = api as unknown as Record<
  "saveSessionChanges" | "appendSessionChange" | "loadSessionChanges" | "sessionJsonlSize" | "gitHeadRev" | "gitDiffFiles" | "gitRevertFile" | "truncateSessionJsonl" | "stopChatSession",
  ReturnType<typeof vi.fn>
>;
const listenMock = vi.mocked(listen);

function round(index: number, paths: string[], rewindTo?: number): ChangeRound {
  return {
    index,
    time: "10:00",
    files: paths.map((p) => ({ path: p, status: "M", additions: 1, deletions: 0 })),
    rewindTo,
    prompt: "q",
  };
}

// ── 用例卫生：**文件级**（所有 describe 共用）──
// 归集器、"非 git 仓库"负缓存都是模块级单例：不复位会把上个用例的结论带过来。
beforeEach(async () => {
  // 冲刷上个用例可能残留的异步链（revertRound 的文件恢复循环是 await 串行，
  // 上一用例断言完不等于链已跑完——残留的 gitRevertFile 会落进本用例的计数）。
  await flushAsync(30);
  __resetForTest();
  for (const k of Object.keys(apiMock)) apiMock[k as keyof typeof apiMock].mockClear();
  for (const k of Object.keys(apiMock)) apiMock[k as keyof typeof apiMock].mockResolvedValue(undefined);
  apiMock.loadSessionChanges.mockResolvedValue([]);
  apiMock.gitDiffFiles.mockResolvedValue([]);
  listenMock.mockClear();
  fsMocks.fsHandler = null;
  fsMocks.unlistens = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  // 先停作用域（watch 不再响应），再清全局 sessionState（下个测试从零开始）
  for (const d of disposers) d();
  disposers.length = 0;
  const { state, removeSessionState } = useSessionState();
  for (const sid of Object.keys(state)) removeSessionState(sid);
  useSessionWorkspaces().clearAll();
  vi.restoreAllMocks();
});

describe("useConversationChanges 用户操作错误处理（P0）", () => {

  it("revertSingleFile 恢复文件失败 → 向上抛（用户主动操作不吞）+ console.error", async () => {
    apiMock.loadSessionChanges.mockResolvedValue([round(1, ["a.ts"])]);
    const { hook } = await mountWithSid();
    await vi.waitFor(() => expect(hook.rounds.value).toHaveLength(1));
    apiMock.gitRevertFile.mockRejectedValue(new Error("git revert boom"));

    await expect(hook.revertSingleFile(hook.rounds.value[0], "a.ts")).rejects.toThrow("git revert boom");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[changelog] revert file failed"),
      "a.ts",
      expect.any(Error),
    );
    // 失败不得继续走 save（rounds 保持原状）
    expect(apiMock.saveSessionChanges).not.toHaveBeenCalled();
    expect(hook.rounds.value).toHaveLength(1);
  });

  it("revertRound 截断 .jsonl 失败 → 中止整个回滚（文件恢复循环不执行、rounds 不清理）", async () => {
    apiMock.loadSessionChanges.mockResolvedValue([round(1, ["a.ts"], 42), round(2, ["b.ts"], 80)]);
    const { hook } = await mountWithSid();
    await vi.waitFor(() => expect(hook.rounds.value).toHaveLength(2));
    apiMock.truncateSessionJsonl.mockRejectedValue(new Error("truncate boom"));

    await expect(hook.revertRound(hook.rounds.value[1])).rejects.toThrow("truncate boom");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[changelog] truncate session jsonl failed, revert aborted"),
      expect.any(Error),
    );
    // 半回滚防护：文件一个都没恢复，rounds 也没被清理
    expect(apiMock.gitRevertFile).not.toHaveBeenCalled();
    expect(hook.rounds.value).toHaveLength(2);
  });

  it("revertRound 文件恢复失败 → 中断剩余恢复并抛错（不静默继续）", async () => {
    apiMock.loadSessionChanges.mockResolvedValue([round(1, ["a.ts"], 42), round(2, ["b.ts"], 80)]);
    const { hook } = await mountWithSid();
    await vi.waitFor(() => expect(hook.rounds.value).toHaveLength(2));
    apiMock.gitRevertFile.mockRejectedValue(new Error("revert boom"));

    await expect(hook.revertRound(hook.rounds.value[1])).rejects.toThrow("revert boom");
    // 第一个文件就失败 → 循环中断，rounds 未清理（避免假装成功）
    expect(hook.rounds.value).toHaveLength(2);
  });

  it("revertRound 成功路径：截断 + 恢复该轮及之后所有轮的文件 + 清理轮次", async () => {
    apiMock.loadSessionChanges.mockResolvedValue([round(1, ["a.ts"], 42), round(2, ["b.ts", "c.ts"], 80)]);
    const { hook } = await mountWithSid();
    await vi.waitFor(() => expect(hook.rounds.value).toHaveLength(2));

    await expect(hook.revertRound(hook.rounds.value[1])).resolves.not.toThrow();
    expect(apiMock.truncateSessionJsonl).toHaveBeenCalledWith(SID, 80);
    // 只恢复 index>=2 的轮（第 1 轮的文件不碰）；cwd 必须带会话所属工作区——
    // 走全局活动工作区会在用户当前所看的项目里 checkout，误回滚同名文件
    expect(apiMock.gitRevertFile).toHaveBeenCalledTimes(2);
    expect(apiMock.gitRevertFile).toHaveBeenCalledWith("b.ts", WS_ROOT);
    expect(apiMock.gitRevertFile).toHaveBeenCalledWith("c.ts", WS_ROOT);
    expect(hook.rounds.value).toHaveLength(1);
    expect(apiMock.saveSessionChanges).toHaveBeenCalledTimes(1);
  });

  it("save 落盘失败 → console.warn 降级（不抛、不阻断主流程）", async () => {
    apiMock.loadSessionChanges.mockResolvedValue([round(1, ["a.ts"])]);
    const { hook } = await mountWithSid();
    await vi.waitFor(() => expect(hook.rounds.value).toHaveLength(1));
    apiMock.gitRevertFile.mockResolvedValue(undefined);
    apiMock.saveSessionChanges.mockRejectedValue(new Error("disk full"));

    await expect(hook.revertSingleFile(hook.rounds.value[0], "a.ts")).resolves.not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[changelog] save session changes failed"),
      expect.any(Error),
    );
  });

  it("captureChanges 纯追加路径 → 首轮全量兜底、次轮起 append 单轮（P2-4）", async () => {
    const P24_SID = "uuid-p24";
    const { setSessionState } = useSessionState();
    const { hook } = await mountWithSid(P24_SID);

    // 第一轮：running 即建 pending 轮（实时性：不等回复完成）
    setSessionState(P24_SID, "running");
    await nextTick();
    await flushAsync();
    expect(hook.rounds.value).toHaveLength(1);
    expect(hook.rounds.value[0].pending).toBe(true);
    expect(hook.rounds.value[0].prompt).toBe("test prompt");

    // 磁盘空（diskTailIndex=-1）→ 尾轮 index 1 !== 0，全量兜底
    setSessionState(P24_SID, "waiting");
    await nextTick();
    await vi.waitFor(() => {
      expect(hook.rounds.value[0].pending).toBe(false);
      expect(apiMock.saveSessionChanges).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.appendSessionChange).not.toHaveBeenCalled();

    // 第二轮：内存尾轮 index 2 === diskTailIndex(1)+1 → append 单轮
    setSessionState(P24_SID, "running");
    await nextTick();
    await flushAsync();
    expect(hook.rounds.value).toHaveLength(2);
    setSessionState(P24_SID, "waiting");
    await nextTick();
    await vi.waitFor(() => {
      expect(apiMock.appendSessionChange).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.appendSessionChange).toHaveBeenCalledWith(P24_SID, expect.objectContaining({ index: 2 }));
    expect(apiMock.saveSessionChanges).toHaveBeenCalledTimes(1); // 仍是首轮那次全量
  });

  it("后台会话轮次：不经视图也能固化落盘（全局状态监听）", async () => {
    const VIEW = "uuid-bg-view";
    const BG = "uuid-bg";
    const { setSessionState } = useSessionState();
    const { hook } = await mountWithSid(VIEW);

    setSessionState(BG, "running");
    await nextTick();
    await flushAsync();
    setSessionState(BG, "waiting");
    await nextTick();
    await vi.waitFor(() => {
      expect(apiMock.saveSessionChanges).toHaveBeenCalledWith(BG, [
        expect.objectContaining({ index: 1, prompt: "test prompt" }),
      ]);
    });
    // 视图会话不受影响（后台轮不进当前视图）
    expect(hook.rounds.value).toHaveLength(0);
  });

  it("切会话瞬间不串号：A 的轮固化到 A，B 的视图只显示 B 自己的磁盘轮", async () => {
    const A = "uuid-x-a";
    const B = "uuid-x-b";
    const { setSessionState } = useSessionState();
    const { hook, sidRef } = await mountWithSid(A);

    setSessionState(A, "running");
    await nextTick();
    await flushAsync();
    expect(hook.rounds.value).toHaveLength(1); // A 的 pending 轮

    // A 轮进行中切到 B（B 磁盘已有历史轮）——旧实现在此刻串号覆盖
    apiMock.loadSessionChanges.mockResolvedValue([round(9, ["old.ts"])]);
    sidRef.value = B;
    await nextTick();
    await flushAsync();
    await vi.waitFor(() => {
      expect(hook.rounds.value).toHaveLength(1);
      expect(hook.rounds.value[0].index).toBe(9);
    });

    // A 轮结束：固化到 A 自己的变更文件（A 磁盘为空 → 首轮全量 save）
    setSessionState(A, "waiting");
    await nextTick();
    await vi.waitFor(() => {
      expect(apiMock.saveSessionChanges).toHaveBeenCalledWith(A, [expect.objectContaining({ index: 1 })]);
    });
    // 从未用 B 落盘任何东西（旧 bug：saveSessionChanges(新sid, 污染列表) 全量覆盖）
    expect(apiMock.saveSessionChanges).not.toHaveBeenCalledWith(B, expect.anything());
    expect(apiMock.appendSessionChange).not.toHaveBeenCalledWith(B, expect.anything());
    // 视图仍是 B 的轮，未被 A 污染
    expect(hook.rounds.value).toHaveLength(1);
    expect(hook.rounds.value[0].index).toBe(9);
  });

  it("归属隔离：改动只记进发起它的那个会话的轮（事件按 sid 分桶）", async () => {
    const A = "uuid-attr-a";
    const B = "uuid-attr-b";
    const { setSessionState } = useSessionState();
    const { hook, sidRef } = await mountWithSid(A);
    bindWs(B);

    // A 跑一轮，期间 B 的改动事件同时到达——旧实现此刻读的是全局 git diff，
    // 会把 B 改的文件一并算进 A 这一轮。
    setSessionState(A, "running");
    await nextTick();
    await flushAsync();
    emitChat(toolUse(A, `${WS_ROOT}/a.ts`));
    emitChat(toolUse(B, `${WS_ROOT}/x.ts`));
    setSessionState(A, "waiting");
    await nextTick();
    await flushAsync();

    await vi.waitFor(() => {
      expect(hook.rounds.value[0].files).toEqual([
        expect.objectContaining({ path: "a.ts" }),
      ]);
    });

    // B 那一份只会出现在 B 自己的轮里
    setSessionState(B, "running");
    await nextTick();
    await flushAsync();
    setSessionState(B, "waiting");
    await nextTick();
    await flushAsync();
    sidRef.value = B;
    await nextTick();
    await flushAsync();
    await vi.waitFor(() => {
      expect(hook.rounds.value[0].files).toEqual([
        expect.objectContaining({ path: "x.ts" }),
      ]);
    });
  });

  it("归集不再读全局 git diff：整条链路一次 gitDiffFiles 都不调", async () => {
    const A = "uuid-nogit";
    const { setSessionState } = useSessionState();
    const { hook } = await mountWithSid(A);

    setSessionState(A, "running");
    await nextTick();
    await flushAsync();
    emitChat(toolUse(A, `${WS_ROOT}/a.ts`));
    setSessionState(A, "waiting");
    await nextTick();
    await flushAsync();

    await vi.waitFor(() => expect(hook.rounds.value[0].files).toHaveLength(1));
    expect(apiMock.gitDiffFiles).not.toHaveBeenCalled();
  });

  it("落盘剥掉运行时字段：touches / pending 不上盘（磁盘形状不变）", async () => {
    const A = "uuid-strip";
    const { setSessionState } = useSessionState();
    const { hook } = await mountWithSid(A);

    setSessionState(A, "running");
    await nextTick();
    await flushAsync();
    emitChat(toolUse(A, `${WS_ROOT}/a.ts`));
    setSessionState(A, "waiting");
    await nextTick();
    await flushAsync();

    await vi.waitFor(() => {
      expect(apiMock.saveSessionChanges).toHaveBeenCalledWith(A, [
        expect.objectContaining({ index: 1 }),
      ]);
    });
    // 内存里保留片段（本轮精确 diff），磁盘上只有落盘形状
    expect(hook.rounds.value[0].touches?.[0].segments).toHaveLength(1);
    const saved = apiMock.saveSessionChanges.mock.calls.at(-1)?.[1] as ChangeRound[];
    expect(saved[0]).not.toHaveProperty("touches");
    expect(saved[0]).not.toHaveProperty("pending");
  });

  it("进行中轮实时刷新：running 即显示 → 文件事件更新 files → 固化落盘并退订", async () => {
    vi.useFakeTimers();
    try {
      const LIVE = "uuid-live";
      const { setSessionState } = useSessionState();
      const { hook } = await mountWithSid(LIVE);

      setSessionState(LIVE, "running");
      await nextTick();
      await flushAsync();

      // running 即建轮：pending + files 空（等归集增量进来才填）
      expect(hook.rounds.value).toHaveLength(1);
      expect(hook.rounds.value[0].pending).toBe(true);
      expect(hook.rounds.value[0].files).toEqual([]);

      // 视图存在 pending 轮 → 订阅文件事件
      await flushAsync();
      expect(listenMock).toHaveBeenCalledWith("file-tree-changed", expect.any(Function));

      // 工具改了文件 → 文件事件触发 → 250ms 防抖 → 增量并入 pending 轮
      emitChat(toolUse(LIVE, `${WS_ROOT}/a.ts`, "old", "new\nnew2"));
      fsMocks.fsHandler!({ payload: [] });
      await vi.advanceTimersByTimeAsync(260);
      await flushAsync();
      expect(hook.rounds.value[0].files).toEqual([
        expect.objectContaining({ path: "a.ts", additions: 2, deletions: 1 }),
      ]);

      // 固化：防抖间隙里新来的增量一并取走（不会丢） + 清 pending + 落盘 + 退订
      emitChat(toolUse(LIVE, `${WS_ROOT}/b.ts`));
      setSessionState(LIVE, "waiting");
      await nextTick();
      await flushAsync();
      expect(hook.rounds.value[0].pending).toBe(false);
      expect(hook.rounds.value[0].files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
      expect(apiMock.saveSessionChanges).toHaveBeenCalledWith(LIVE, [expect.objectContaining({ index: 1 })]);
      expect(fsMocks.unlistens).toBe(1); // 固化即退订
    } finally {
      vi.useRealTimers();
    }
  });

  it("会话切换退订：视图切走（新会话无进行中轮）→ 立即退订文件事件", async () => {
    vi.useFakeTimers();
    try {
      const A = "uuid-sw-a";
      const B = "uuid-sw-b";
      const { setSessionState } = useSessionState();
      const { hook, sidRef } = await mountWithSid(A);

      setSessionState(A, "running");
      await nextTick();
      await flushAsync();
      await flushAsync(); // attach 落定
      expect(fsMocks.unlistens).toBe(0);

      sidRef.value = B;
      await nextTick();
      await flushAsync();
      expect(fsMocks.unlistens).toBe(1); // 切走即退订（B 无进行中轮）

      // 收尾：A 的 pending 轮固化（顺带验证切走后后台固化仍工作）
      setSessionState(A, "waiting");
      await nextTick();
      await flushAsync();
      expect(hook.rounds.value).toHaveLength(0); // 视图是 B，A 的轮不在视图
      expect(apiMock.saveSessionChanges).toHaveBeenCalledWith(A, [expect.objectContaining({ index: 1 })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("撤回进行中会话：stop 触发的 stopped 固化被 reverting 拦下（被杀轮不回来）", async () => {
    const A = "uuid-revert-live";
    const { setSessionState } = useSessionState();
    apiMock.loadSessionChanges.mockResolvedValue([round(1, ["a.ts"], 42), round(2, ["b.ts"], 80)]);
    const { hook } = await mountWithSid(A);
    await vi.waitFor(() => expect(hook.rounds.value).toHaveLength(2));

    // 会话活跃中起了第 3 轮（pending）
    setSessionState(A, "running");
    await nextTick();
    await flushAsync();
    expect(hook.rounds.value).toHaveLength(3);

    // 撤回到轮 2：stopChatSession 内部触发 stopped（reverting 已置 true）
    apiMock.stopChatSession.mockImplementation(async () => {
      setSessionState(A, "stopped");
      await nextTick();
      await flushAsync();
    });
    await expect(hook.revertRound(hook.rounds.value[1])).resolves.not.toThrow();

    // 被杀的 pending 轮没有被固化回来；rounds 只剩轮 1
    expect(hook.rounds.value).toHaveLength(1);
    expect(hook.rounds.value[0].index).toBe(1);
    expect(apiMock.truncateSessionJsonl).toHaveBeenCalledWith(A, 80);
    expect(apiMock.gitRevertFile).toHaveBeenCalledWith("b.ts", WS_ROOT);
  });
});


describe("revertFileGlobally — 统一树的撤回（跨轮语义）", () => {
  it("git 只回滚一次，条目从所有轮移除", async () => {
    const G = "uuid-global-revert";
    apiMock.loadSessionChanges.mockResolvedValue([round(1, ["a.ts"]), round(2, ["a.ts", "b.ts"])]);
    const { hook } = await mountWithSid(G);

    expect(hook.rounds.value).toHaveLength(2);
    // 增量断言：上一用例的回滚链可能跨用例落地（挂在 fake timer 上，beforeEach
    // 的 microtask 冲刷冲不掉），全局计数不可靠——只认本用例产生的这次调用。
    const before = apiMock.gitRevertFile.mock.calls.length;
    await hook.revertFileGlobally("a.ts");
    const calls = apiMock.gitRevertFile.mock.calls.slice(before);

    // 同一个文件不重复 checkout（按轮逐个撤回会调两次）
    expect(calls).toEqual([["a.ts", WS_ROOT]]);
    expect(hook.rounds.value.every((r) => !r.files.some((x) => x.path === "a.ts"))).toBe(true);
    // 未被撤回的文件留在原轮
    expect(hook.rounds.value[1].files.map((x) => x.path)).toEqual(["b.ts"]);
  });

  it("撤回失败 → 向上抛，且不移条目（不出现「条目已消失但文件还在」）", async () => {
    const G = "uuid-global-revert-fail";
    apiMock.loadSessionChanges.mockResolvedValue([round(1, ["a.ts"])]);
    const { hook } = await mountWithSid(G);
    apiMock.gitRevertFile.mockRejectedValueOnce(new Error("locked"));

    await expect(hook.revertFileGlobally("a.ts")).rejects.toThrow("locked");
    expect(hook.rounds.value[0].files).toHaveLength(1);
  });
});

describe("开轮基线（baseRev）——「改前」引用", () => {
  it("开轮取一次基线（cwd = 会话工作区根），写进轮记录", async () => {
    const { setSessionState } = useSessionState();
    const rev = "0123456789abcdef0123456789abcdef01234567";
    apiMock.gitHeadRev.mockResolvedValue(rev);
    const { hook } = await mountWithSid();

    setSessionState(SID, "running");
    await nextTick();
    await flushAsync();

    expect(apiMock.gitHeadRev).toHaveBeenCalledTimes(1);
    expect(apiMock.gitHeadRev).toHaveBeenCalledWith(WS_ROOT);
    expect(hook.rounds.value[0]?.baseRev).toBe(rev);
  });

  it("非 git 仓库（Ok(None)）→ 不写字段，且负缓存生效（两轮只 spawn 一次）", async () => {
    const { setSessionState } = useSessionState();
    apiMock.gitHeadRev.mockResolvedValue(null);
    const { hook } = await mountWithSid();

    setSessionState(SID, "running");
    await nextTick();
    await flushAsync();
    setSessionState(SID, "waiting");
    await nextTick();
    await flushAsync();
    setSessionState(SID, "running");
    await nextTick();
    await flushAsync();

    expect(apiMock.gitHeadRev).toHaveBeenCalledTimes(1); // 缓存了"不是 git 仓库"
    expect(hook.rounds.value.every((r) => r.baseRev === undefined)).toBe(true);
  });

  it("取基线抛错 → 不写字段，但**不缓存**（下一轮还要试）", async () => {
    const { setSessionState } = useSessionState();
    apiMock.gitHeadRev.mockRejectedValue(new Error("boom"));
    const { hook } = await mountWithSid();

    setSessionState(SID, "running");
    await nextTick();
    await flushAsync();
    setSessionState(SID, "waiting");
    await nextTick();
    await flushAsync();
    setSessionState(SID, "running");
    await nextTick();
    await flushAsync();

    expect(apiMock.gitHeadRev).toHaveBeenCalledTimes(2); // 暂态失败不进负缓存
    expect(hook.rounds.value.every((r) => r.baseRev === undefined)).toBe(true);
  });
});
