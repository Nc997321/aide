import { computed, reactive, watch, getCurrentScope, onScopeDispose } from "vue";
import { useSessionState, isSessionUntracked } from "./useSessionState";
import { useSessionWorkspaces } from "./useSessionWorkspaces";
import { isPendingSession, getLastDispatchedPrompt, resetPaginationForRevert } from "./useChatSession";
import { useModal } from "./useModal";
import { api, listen } from "../api";
import type { ChangeRound, ChangeFile, TouchedFile } from "../types";
import {
  createChangeAttribution,
  mergeTouches,
  toChangeFiles,
  type ChangeAttribution,
} from "./useChangeAttribution";

export type { ChangeRound, ChangeFile };

/** 文件事件防抖：后端已归集（300ms 静默 + 2s 冷却），前端 250ms trailing 合并即可。 */
const LIVE_REFRESH_DEBOUNCE = 250;

// ── 变更归属归集器（模块级单例）──
// 必须是模块级：若每个 useConversationChanges 实例各建一个归集器，事件只会被
// 其中一个收到——先 drain 的人拿走全部，另一个永远为空。订阅同样只建一次
// （回调读的是模块变量，实例替换后自动指向新的，不需要退订重订）。
let attribution: ChangeAttribution | null = null;
let attributionAttached = false;

/** 会话所属工作区根——会话级事实，撤回/git 调用都从这里取，不随轮次漂移。 */
function sessionWsRoot(sid: string): string | null {
  return useSessionWorkspaces().workspaceOf(sid)?.wsPath || null;
}

// 注：这里曾有一个「非 git 仓库」的模块级负缓存（`noGitRoots`），已移除——
// `Ok(None)` 有"非仓库"与"unborn HEAD"两义，缓存会钉死新项目会话（见 startRound 里的说明）。

function changeAttribution(): ChangeAttribution {
  if (!attribution) {
    attribution = createChangeAttribution({
      rootOf: sessionWsRoot,
      // 自动化运行没有轮次视图：归集进去的数据永远无人消费，只会在内存里堆积。
      isTracked: (sid) => !isSessionUntracked(sid),
    });
  }
  if (!attributionAttached) {
    attributionAttached = true;
    void listen("chat-event", (e) => {
      attribution?.ingest((e.payload ?? {}) as Record<string, unknown>);
    }).catch(() => {
      // 订阅失败 = 归集器收不到事件 → 所有轮都无变更。与 git 拉取失败同级退化，
      // 不静默：控制台留痕。
      console.warn("[changelog] chat-event subscribe failed, change attribution disabled");
    });
  }
  return attribution;
}

/** 测试钩子：丢弃归集器单例（与 useNotifications / useChatSession 的
 *  __resetForTest 同惯例）。订阅句柄不动。 */
export function __resetForTest(): void {
  attribution = null;
}

/** 把一批归集增量并入轮次。
 *  `touches` 是内存数据源（含片段），`files` 是它的落盘投影——两者同源，
 *  同步点只有这一处，不存在第二处赋值让它们漂移。 */
function applyTouches(round: ChangeRound, incoming: TouchedFile[]): void {
  round.touches = mergeTouches(round.touches ?? [], incoming);
  round.files = toChangeFiles(round.touches);
}

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
  /** 本轮开始时的 .jsonl 字节位置（/rewind 锚点）。 */
  pendingRewindPosition: number | null;
  /** 本会话磁盘操作串行队列（快照/固化/落盘互不交错）。 */
  pendingOp: Promise<unknown>;
}

/** 剥掉运行时字段（`pending` / `touches`）：两者只活在内存里。 */
function stripRuntimeFields(r: ChangeRound): ChangeRound {
  const copy = { ...r };
  delete copy.pending;
  delete copy.touches;
  return copy;
}

function newTracker(): RoundTracker {
  return {
    rounds: [],
    roundCounter: 0,
    diskTailIndex: -1,
    loaded: false,
    lastState: "",
    reverting: false,
    pendingRewindPosition: null,
    pendingOp: Promise.resolve(),
  };
}

export function useConversationChanges(sessionId: () => string) {
  // 挂载即建立事件订阅：工具的改动事件可能早于本轮第一次 drain 到达（首轮尤其
  // 明显——固轮要等状态转 waiting），订阅晚了那一轮就整个漏采。
  void changeAttribution();
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
   *  pending 轮不落盘；`touches` 是内存片段，落盘前剥掉——磁盘形状
   *  （Rust `ChangeRoundData`）不因归集换源而改变，老数据照读。 */
  async function save(sid: string) {
    if (!sid || isPendingSession(sid)) return;
    const t = trackers.get(sid);
    if (!t) return;
    const list = t.rounds.filter((r) => !r.pending).map(stripRuntimeFields);
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

  /** 轮开始（状态 → running）：建 pending 轮（标题=本轮提问）+ 记 rewind 锚点 + 记基线。
   *  prompt 同步取——异步链落定前注册表可能已被清。
   *
   *  不拍 git **快照**：本轮改了哪些文件由归集器的游标增量给出（drain 取走即清空）。
   *  只取一个 HEAD **提交号**（`baseRev`）当"改前"引用——cwd 取会话自持的工作区根，
   *  不依赖全局工作区单例的时间窗推断。 */
  function startRound(sid: string) {
    if (isPendingSession(sid)) return;
    const prompt = getLastDispatchedPrompt(sid) || undefined;
    const t = ensureTracker(sid);
    t.pendingOp = t.pendingOp.then(async () => {
      // 上一次固化失败遗留的 pending 轮：标记为已固化（数据尽力而为），避免双 pending
      const stale = t.rounds.find((r) => r.pending);
      if (stale) stale.pending = false;
      // rewind 锚点（唯一的异步取数，失败则本轮不可回退）
      try {
        t.pendingRewindPosition = await api.sessionJsonlSize(sid);
      } catch (_) {
        t.pendingRewindPosition = null;
      }
      // 基线（"改前"）：开轮时刻的 HEAD 提交。与 jsonl 字节锚点同批取，**不依赖 fs 事件时序**
      // （事件订阅失败时首次触碰会晚于提交，基线就取成了提交之后的 sha）。取不到就不记 ——
      // 那条记录将来退回 HEAD 累计，绝不出现错的内容。
      //
      // **不做负缓存**：`Ok(None)` 有两义——"不是仓库"（永久）与"unborn HEAD"（瞬态，首个提交
      // 就消失）。缓存会把一个刚 `git init` 的项目会话整场钉死在没有基线，本笔要修的那个 bug
      // 会在这种会话里原样复发；而"不是仓库"那一路在 Rust 侧 `.git` 早退、连 spawn 都没有，
      // 省下的只是一次 IPC 往返。每轮一次取数的代价照旧（~101ms，后台链上）。
      let baseRev: string | undefined;
      const root = sessionWsRoot(sid);
      if (root) {
        try {
          baseRev = (await api.gitHeadRev(root)) ?? undefined;
        } catch (e) {
          console.warn("[changelog] read HEAD rev failed, this round has no baseline:", e);
        }
      }
      t.roundCounter += 1;
      t.rounds.push({
        index: t.roundCounter,
        time: new Date().toLocaleTimeString(),
        files: [],
        rewindTo: t.pendingRewindPosition ?? undefined,
        prompt,
        pending: true,
        baseRev,
      });
    });
  }

  /** 轮结束（状态 → waiting/stopped）：取走归集增量 → 固化落盘。
   *  增量只可能属于本会话（事件带 session_id），跨会话/跨工作区窜数据在源头
   *  就不可能发生——旧实现在这里读的是全局 git diff，拍的是用户当前所看的
   *  工作区，后台会话因此记进别的项目。 */
  function solidifyRound(sid: string) {
    const t = trackers.get(sid);
    if (!t) return;
    t.pendingOp = t.pendingOp.then(async () => {
      if (t.reverting) return; // 撤回进行中：被杀轮不记录（轮记录已被清理）
      const touches = changeAttribution().drain(sid);
      const round = [...t.rounds].reverse().find((r) => r.pending);
      if (round) {
        applyTouches(round, touches?.files ?? []);
        round.pending = false;
      } else {
        // 没有 pending 轮（app 启动前就开始的轮等边界）：照旧创建固化轮
        t.roundCounter += 1;
        const created: ChangeRound = {
          index: t.roundCounter,
          time: new Date().toLocaleTimeString(),
          files: [],
          rewindTo: t.pendingRewindPosition ?? undefined,
          prompt: getLastDispatchedPrompt(sid) || undefined,
        };
        applyTouches(created, touches?.files ?? []);
        t.rounds.push(created);
      }
      t.pendingRewindPosition = null;
      await save(sid);
    });
  }

  // ── 实时刷新：活动视图存在 pending 轮 → 订阅 file-tree-changed 事件 ──
  // 纯事件驱动（零兜底轮询）：进行中的轮每收到文件事件就把归集增量并入轮次，
  // 只影响「显示多新鲜」——事件链断裂最坏 = 回到轮末固化时才显示，数据不丢
  // （增量一直躺在归集器的桶里，固化时 drain 一并取走）。
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
      if (!round) return; // 防抖期间已固化/撤回：增量留在桶里，由固轮时一并取走
      // 先确认有 pending 轮再 drain：drain 取走即清空，无轮可挂就等于丢增量
      const touches = changeAttribution().drain(sid);
      if (!touches) return;
      applyTouches(round, touches.files);
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
        if (sid !== keep && !(sid in sessionState)) {
          trackers.delete(sid);
          changeAttribution().forget(sid); // 桶随 tracker 一起收口，防无界增长
        }
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

  /** Revert a single file to its staged (pre-Claude) version.
   *  cwd 传会话所属工作区：撤回是唯一的破坏性操作，走全局活动工作区会在用户
   *  当前所看的项目里执行 `checkout -- <path>`，误回滚另一项目的同名文件。 */
  async function revertFile(filePath: string) {
    const cwd = sessionWsRoot(viewSid()) ?? undefined;
    try {
      await api.gitRevertFile(filePath, cwd);
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
      if (typeof round.rewindTo === "number" && sid) {
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
      t.pendingRewindPosition = null;
    }
    t.rounds = t.rounds.filter((r) => r.index < round.index);
    t.roundCounter = t.rounds.length;
    // .jsonl 已按字节截断：旧分页游标失效，清空（后端另有 clamp 兜底，双保险）
    if (sid) resetPaginationForRevert(sid);
    await save(sid);
  }

  /** Revert a single file and remove it from its round.
   *  `touches` 与 `files` 同源，必须一起删：只删 files 的话，该轮若还在刷新
   *  （pending 或后续 drain），applyTouches 会用残留的 touches 把它加回来。 */
  async function revertSingleFile(round: ChangeRound, filePath: string) {
    await revertFile(filePath);
    round.files = round.files.filter((f) => f.path !== filePath);
    if (round.touches) round.touches = round.touches.filter((f) => f.path !== filePath);
    const sid = viewSid();
    if (sid) await save(sid);
  }

  /** 撤回某文件在**所有轮**中的记录：git 只回滚一次，条目从每一轮里移除。
   *  顶部统一树是跨轮视图，「撤回这个文件」的语义天然是它整体回到 HEAD，
   *  不是某一轮里的那一条——按轮逐个撤回会对同一个文件重复 checkout。 */
  async function revertFileGlobally(filePath: string) {
    await revertFile(filePath);
    const t = trackers.get(viewSid());
    if (!t) return;
    for (const r of t.rounds) {
      r.files = r.files.filter((f) => f.path !== filePath);
      if (r.touches) r.touches = r.touches.filter((f) => f.path !== filePath);
    }
    const sid = viewSid();
    if (sid) await save(sid);
  }

  // 作用域销毁（测试/App 卸载）时退订文件事件，防监听器泄漏
  if (getCurrentScope()) onScopeDispose(detachLiveRefresh);

  return { rounds, revertRound, revertSingleFile, revertFileGlobally };
}
