import { computed, reactive, watch, getCurrentScope, onScopeDispose } from "vue";
import { useSessionState } from "./useSessionState";
import { isPendingSession, getLastDispatchedPrompt, resetPaginationForRevert } from "./useChatSession";
import { useModal } from "./useModal";
import { api, listen } from "../api";
import type { ChangeRound, ChangeFile } from "../types";

export type { ChangeRound, ChangeFile };

/** 文件事件防抖：后端已归集（300ms 静默 + 2s 冷却），前端 250ms trailing 合并即可。 */
const LIVE_REFRESH_DEBOUNCE = 250;

/** per-sid 轮次跟踪器：轮次、快照、回退位、落盘队列全按会话隔离——
 *  切会话只切视图指向，任何会话的状态都不会污染另一会话。 */
interface RoundTracker {
  rounds: ChangeRound[];
  roundCounter: number;
  /** 磁盘上最后一条轮的 index（-1 = 无/未知）。save 的追加锚点。 */
  diskTailIndex: number;
  /** 磁盘加载是否落定（未落定前不建轮，防 index 错位）。 */
  loaded: boolean;
  /** 该会话最近一次观测到的状态（全局 watch 的转移判断基准）。 */
  lastState: string;
  /** 撤回进行中：阻止 stopChatSession 触发的固化把「被杀轮」记录回来。 */
  reverting: boolean;
  /** 本轮开始时的 git diff 快照（delta 基线）。 */
  snapshotDiff: Map<string, { additions: number; deletions: number }> | null;
  /** 本轮开始时的 .jsonl 字节位置（/rewind 锚点）。 */
  pendingRewindPosition: number | null;
  /** 本会话磁盘操作串行队列（快照/固化/落盘互不交错）。 */
  pendingOp: Promise<unknown>;
}

function newTracker(): RoundTracker {
  return {
    rounds: [],
    roundCounter: 0,
    diskTailIndex: -1,
    loaded: false,
    lastState: "",
    reverting: false,
    snapshotDiff: null,
    pendingRewindPosition: null,
    pendingOp: Promise.resolve(),
  };
}

/** 与快照求 delta：本轮真正新增/变化的文件（沿用原 captureChanges 语义）。 */
function deltaFiles(
  current: ChangeFile[],
  snapshot: Map<string, { additions: number; deletions: number }> | null,
): ChangeFile[] {
  if (!snapshot || snapshot.size === 0) return current;
  const files: ChangeFile[] = [];
  for (const f of current) {
    const prev = snapshot.get(f.path);
    if (!prev) {
      files.push(f);
    } else if (prev.additions !== f.additions || prev.deletions !== f.deletions) {
      files.push({ ...f, additions: f.additions - prev.additions, deletions: f.deletions - prev.deletions });
    }
  }
  return files;
}

export function useConversationChanges(sessionId: () => string) {
  /** per-sid tracker 表（reactive Map：computed/视图直接跟踪键与数组内容）。 */
  const trackers = reactive(new Map<string, RoundTracker>());
  const { state: sessionState } = useSessionState();
  const modal = useModal();

  const viewSid = () => sessionId() || "";

  /** 取或建 tracker（建时惰性排队磁盘加载；返回 reactive 代理，所有变更走代理）。 */
  function ensureTracker(sid: string): RoundTracker {
    let t = trackers.get(sid);
    if (t) return t;
    trackers.set(sid, newTracker());
    t = trackers.get(sid)!;
    const tr = t;
    tr.pendingOp = tr.pendingOp.then(async () => {
      try {
        const saved = await api.loadSessionChanges(sid);
        if (!tr.loaded) {
          // 克隆取得所有权：load 结果不与外部共享数组引用（IPC 每次全新
          // JSON 本无风险，这里防御测试 mock 复用同一数组导致的跨会话串写）
          const list = Array.isArray(saved) ? saved.map((r) => ({ ...r })) : [];
          tr.rounds = list;
          if (list.length > 0) {
            tr.roundCounter = list[list.length - 1].index;
            tr.diskTailIndex = list[list.length - 1].index;
          }
        }
      } catch (_) {
        if (!tr.loaded) tr.rounds = [];
      }
      tr.loaded = true;
    });
    return t;
  }

  /** Persist rounds to disk（纯追加走 append 单轮，其余全量覆盖）。
   *  pending 轮不落盘（wire 上不出现运行时字段；固化后才可持久化）。 */
  async function save(sid: string) {
    if (!sid || isPendingSession(sid)) return;
    const t = trackers.get(sid);
    if (!t) return;
    const list = t.rounds.filter((r) => !r.pending);
    const tail = list[list.length - 1];
    try {
      if (tail && tail.index === t.diskTailIndex + 1) {
        await api.appendSessionChange(sid, tail);
      } else {
        await api.saveSessionChanges(sid, list);
      }
      t.diskTailIndex = tail ? tail.index : -1;
    } catch (e) {
      // 变更记录落盘失败：内存里本轮数据还在，但重启/切会话后丢失——
      // 降级提示（面板数据仍可继续累积，下次 save 会再试整份；锚点未更新，
      // 下次 save 自动退化为全量覆盖重试）。
      console.warn("[changelog] save session changes failed, rounds will be lost on session switch/restart:", e);
    }
  }

  /** 轮开始（状态 → running）：立即拍快照 + 建 pending 轮（标题=本轮提问）。
   *  prompt 同步取——异步链落定前注册表可能已被清。 */
  function startRound(sid: string) {
    if (isPendingSession(sid)) return;
    const prompt = getLastDispatchedPrompt(sid) || undefined;
    const t = ensureTracker(sid);
    t.pendingOp = t.pendingOp.then(async () => {
      // 上一次固化失败遗留的 pending 轮：标记为已固化（数据尽力而为），避免双 pending
      const stale = t.rounds.find((r) => r.pending);
      if (stale) stale.pending = false;
      // 快照（无条件锚点 1）
      try {
        t.pendingRewindPosition = await api.sessionJsonlSize(sid);
        const current = await api.gitDiffFiles();
        t.snapshotDiff = new Map(
          current.map((f) => [f.path, { additions: f.additions, deletions: f.deletions }]),
        );
      } catch (_) {
        t.pendingRewindPosition = null;
        t.snapshotDiff = null;
      }
      t.roundCounter += 1;
      t.rounds.push({
        index: t.roundCounter,
        time: new Date().toLocaleTimeString(),
        files: [],
        rewindTo: t.pendingRewindPosition ?? undefined,
        prompt,
        pending: true,
      });
    });
  }

  /** 轮结束（状态 → waiting/stopped）：最终 diff（无条件锚点 2，不依赖事件）→ 固化落盘。 */
  function solidifyRound(sid: string) {
    const t = trackers.get(sid);
    if (!t) return;
    t.pendingOp = t.pendingOp.then(async () => {
      if (t.reverting) return; // 撤回进行中：被杀轮不记录（轮记录已被清理）
      try {
        const current = await api.gitDiffFiles();
        const files = deltaFiles(current, t.snapshotDiff);
        const round = [...t.rounds].reverse().find((r) => r.pending);
        if (round) {
          round.files = files;
          round.pending = false;
        } else {
          // 没有 pending 轮（app 启动前就开始的轮等边界）：照旧创建固化轮
          t.roundCounter += 1;
          t.rounds.push({
            index: t.roundCounter,
            time: new Date().toLocaleTimeString(),
            files,
            rewindTo: t.pendingRewindPosition ?? undefined,
            prompt: getLastDispatchedPrompt(sid) || undefined,
          });
        }
        t.snapshotDiff = null;
        t.pendingRewindPosition = null;
        await save(sid);
      } catch (e) {
        // diff 计算或落盘失败：本轮变更记录丢失（内存里未 push 或未持久化）。
        console.warn("[changelog] captureChanges failed, this round's changes were not recorded:", e);
      }
    });
  }

  // ── 实时刷新：活动视图存在 pending 轮 → 订阅 file-tree-changed 事件 ──
  // 纯事件驱动（零兜底轮询）：数据完整性由轮首快照 + 轮末固化两个无条件锚点
  // 保证，中间刷新只影响「进行中显示多新鲜」——事件链断裂最坏 = 回到轮末才
  // 显示，自动自愈，零数据风险。
  let unlistenFs: (() => void) | null = null;
  let fsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  const hasViewPending = computed(() => {
    const sid = viewSid();
    const t = sid ? trackers.get(sid) : undefined;
    return !!t && t.rounds.some((r) => r.pending);
  });

  watch(hasViewPending, (on) => {
    if (on) void attachLiveRefresh();
    else detachLiveRefresh();
  });

  async function attachLiveRefresh() {
    if (unlistenFs) return;
    try {
      unlistenFs = await listen<string[]>("file-tree-changed", () => scheduleLiveRefresh());
    } catch (_) {
      unlistenFs = null; // 订阅失败：退化为轮末一次性固化（数据无损，仅显示不实时）
    }
  }

  function detachLiveRefresh() {
    unlistenFs?.();
    unlistenFs = null;
    if (fsRefreshTimer) {
      clearTimeout(fsRefreshTimer);
      fsRefreshTimer = null;
    }
  }

  function scheduleLiveRefresh() {
    if (fsRefreshTimer) clearTimeout(fsRefreshTimer);
    fsRefreshTimer = setTimeout(async () => {
      fsRefreshTimer = null;
      const sid = viewSid();
      const t = sid ? trackers.get(sid) : undefined;
      if (!t) return;
      const round = [...t.rounds].reverse().find((r) => r.pending);
      if (!round) return; // 防抖期间已固化/撤回：无事可刷
      try {
        const current = await api.gitDiffFiles();
        round.files = deltaFiles(current, t.snapshotDiff);
      } catch (_) {
        // 拉取失败：保持现状，下个文件事件再来
      }
    }, LIVE_REFRESH_DEBOUNCE);
  }

  // ── 全局状态监听：所有会话（含后台）的轮次起止都走这里 ──
  watch(
    sessionState,
    () => {
      for (const sid of Object.keys(sessionState)) {
        const newState = sessionState[sid];
        if (!newState || isPendingSession(sid)) continue;
        const t = trackers.get(sid);
        const prev = t ? t.lastState : "";
        if (newState === prev) continue;
        if (!t && newState !== "running") continue; // 未跟踪且非轮开始：无需建 tracker
        const tr = ensureTracker(sid);
        tr.lastState = newState;
        // Transition: → running 且非 attention 恢复 = 新轮开始
        // （prev 为 "" 的首次观测也视作开始：app 加载时已在 running 的轮，尽力而为）
        if (newState === "running" && prev !== "attention") {
          startRound(sid);
        }
        // Transition: running/attention → waiting/stopped = 轮结束
        if ((newState === "waiting" || newState === "stopped") && (prev === "running" || prev === "attention")) {
          solidifyRound(sid);
        }
      }
      // 会话删除清理：state 里已不存在且非当前视图的 sid 逐出 tracker（防 Map
      // 无界增长；视图切换创建的 tracker 可能尚未进状态表，视图持有期间不逐出）
      const keep = viewSid();
      for (const sid of [...trackers.keys()]) {
        if (sid !== keep && !(sid in sessionState)) trackers.delete(sid);
      }
    },
    { deep: true },
  );

  /** Load rounds from disk when the view switches sessions. */
  watch(
    () => sessionId(),
    (newSid) => {
      if (!newSid || isPendingSession(newSid)) return;
      ensureTracker(newSid); // 已存在则 no-op；视图 computed 自行投影
    },
  );

  // ── 对外：视图投影（切会话 = 换投影，不动任何会话的状态） ──
  const rounds = computed<ChangeRound[]>(() => trackers.get(viewSid())?.rounds ?? []);

  /** Revert a single file to its staged (pre-Claude) version */
  async function revertFile(filePath: string) {
    try {
      await api.gitRevertFile(filePath);
    } catch (e) {
      // 用户主动操作（撤回文件）失败绝不静默：上报并向上抛，
      // 让 revertRound/revertSingleFile 的调用方能感知回滚未完成。
      console.error("[changelog] revert file failed:", filePath, e);
      throw e;
    }
  }

  /** 回滚到该轮之前：截断 .jsonl 对话历史 + 恢复该轮及之后所有轮的文件更改。
   *  「撤回到此处」语义 = 回滚到此处（该轮开始）之前的状态，不可逆。 */
  async function revertRound(round: ChangeRound) {
    const sid = viewSid();

    // 不可逆操作：任何状态都弹确认；会话活跃时附加终止进程警告。
    // waiting 时 CLI 内存持有截断前的历史，不杀进程则下次发消息 API 请求
    // 仍带旧消息——回滚无效（waiting 同 running 必须杀）。
    const curState = sid ? sessionState[sid] : undefined;
    const active = !!curState && curState !== "stopped";
    const ok = await modal.confirm(
      "撤回到此处",
      active
        ? "Claude 正在运行，回滚将强制终止进程。对话与文件将回滚到该轮开始之前，此操作不可撤销。确定继续？"
        : "对话与文件将回滚到该轮开始之前，此操作不可撤销。确定继续？",
      "撤回",
      true,
    );
    if (!ok) return;

    const t = trackers.get(sid);
    if (!t) return;
    t.reverting = true;
    try {
      if (active) {
        await api.stopChatSession(sid);
      }

      // Truncate .jsonl to the position before this round started。
      // 截断失败必须中止整个回滚：若继续恢复文件，会出现「文件已回滚但对话
      // 历史未截断」的半回滚状态，与用户看到的撤回到处语义相悖。
      if (round.rewindTo !== undefined && sid) {
        try {
          await api.truncateSessionJsonl(sid, round.rewindTo);
        } catch (e) {
          console.error("[changelog] truncate session jsonl failed, revert aborted (no files were restored):", e);
          throw e;
        }
      }

      // 恢复该轮及之后所有轮的文件更改（不只是当前轮）
      for (const r of t.rounds) {
        if (r.index < round.index) continue;
        for (const f of r.files) {
          await revertFile(f.path);
        }
      }
    } finally {
      t.reverting = false;
      // 被杀轮的快照/回退位已无意义，清掉（下轮 running 时重拍）
      t.snapshotDiff = null;
      t.pendingRewindPosition = null;
    }
    t.rounds = t.rounds.filter((r) => r.index < round.index);
    t.roundCounter = t.rounds.length;
    // .jsonl 已按字节截断：旧分页游标失效，清空（后端另有 clamp 兜底，双保险）
    if (sid) resetPaginationForRevert(sid);
    await save(sid);
  }

  /** Revert a single file and remove it from its round */
  async function revertSingleFile(round: ChangeRound, filePath: string) {
    await revertFile(filePath);
    round.files = round.files.filter((f) => f.path !== filePath);
    const sid = viewSid();
    if (sid) await save(sid);
  }

  // 作用域销毁（测试/App 卸载）时退订文件事件，防监听器泄漏
  if (getCurrentScope()) onScopeDispose(detachLiveRefresh);

  return { rounds, revertRound, revertSingleFile };
}
