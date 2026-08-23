import { ref, watch } from "vue";
import { useSessionState } from "./useSessionState";
import { isPendingSession, getLastDispatchedPrompt } from "./useChatSession";
import { useModal } from "./useModal";
import { api } from "../api";
import type { ChangeRound, ChangeFile } from "../types";

export type { ChangeRound, ChangeFile };

export function useConversationChanges(sessionId: () => string) {
  const rounds = ref<ChangeRound[]>([]);
  const { state: sessionState } = useSessionState();
  const modal = useModal();

  let roundCounter = 0;
  let lastState = "";
  let pendingOp = Promise.resolve();
  let currentSid = "";
  let pendingRewindPosition: number | null = null;
  let snapshotDiff: Map<string, { additions: number; deletions: number }> | null = null;
  /** 撤回进行中：阻止 stopChatSession 触发的 captureChanges 把「被杀轮」记录回来 */
  let reverting = false;

  /** Persist rounds to disk */
  async function save() {
    const sid = currentSid;
    if (!sid || isPendingSession(sid)) return;
    try {
      await api.saveSessionChanges(sid, rounds.value);
    } catch (e) {
      // 变更记录落盘失败：内存里本轮数据还在，但重启/切会话后丢失——
      // 降级提示（面板数据仍可继续累积，下次 save 会再试整份）。
      console.warn("[changelog] save session changes failed, rounds will be lost on session switch/restart:", e);
    }
  }

  /** Load rounds from disk when session changes */
  watch(
    () => sessionId(),
    async (newSid) => {
      if (!newSid || newSid === currentSid || isPendingSession(newSid)) return;
      currentSid = newSid;
      roundCounter = 0;
      lastState = "";
      pendingOp = Promise.resolve();
      try {
        const saved = await api.loadSessionChanges(newSid);
        rounds.value = saved;
        if (saved.length > 0) {
          roundCounter = saved[saved.length - 1].index;
        }
      } catch (_) {
        rounds.value = [];
      }
    },
  );

  /**
   * Before Claude starts processing: record the .jsonl file size (for /rewind)
   * and the current git diff snapshot (for per-round delta calculation).
   */
  async function takeSnapshot() {
    const sid = currentSid;
    if (!sid || isPendingSession(sid)) return;
    try {
      pendingRewindPosition = await api.sessionJsonlSize(sid);
      const current = await api.gitDiffFiles();
      snapshotDiff = new Map(
        current.map((f) => [f.path, { additions: f.additions, deletions: f.deletions }]),
      );
    } catch (_) {
      pendingRewindPosition = null;
      snapshotDiff = null;
    }
  }

  /** After Claude finishes: compute what changed this round and create an entry */
  async function captureChanges() {
    if (reverting) return; // 撤回进行中：被杀轮不记录（轮记录已被清理）
    try {
      const current = await api.gitDiffFiles();

      // Compute per-round delta from snapshot
      let files: ChangeFile[];
      if (snapshotDiff && snapshotDiff.size > 0) {
        files = [];
        for (const f of current) {
          const prev = snapshotDiff.get(f.path);
          if (!prev) {
            // New file — wasn't in the snapshot at all
            files.push(f);
          } else if (prev.additions !== f.additions || prev.deletions !== f.deletions) {
            // Same file, incremental change
            files.push({
              ...f,
              additions: f.additions - prev.additions,
              deletions: f.deletions - prev.deletions,
            });
          }
          // else: unchanged since snapshot — skip
        }
      } else {
        // No snapshot (first round or error) — use raw diff
        files = current;
      }
      snapshotDiff = null;

      roundCounter++;
      const now = new Date();
      const time = now.toLocaleTimeString();
      const rewindTo = pendingRewindPosition ?? undefined;
      pendingRewindPosition = null;
      const prompt = getLastDispatchedPrompt(currentSid) || undefined;
      rounds.value.push({ index: roundCounter, time, files, rewindTo, prompt });
      await save();
    } catch (e) {
      // diff 计算或落盘失败：本轮变更记录丢失（内存里未 push 或未持久化）。
      // 降级提示，避免用户以为本轮已记录。
      console.warn("[changelog] captureChanges failed, this round's changes were not recorded:", e);
    }
  }

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
    const sid = currentSid;

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

    reverting = true;
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
      for (const r of rounds.value) {
        if (r.index < round.index) continue;
        for (const f of r.files) {
          await revertFile(f.path);
        }
      }
    } finally {
      reverting = false;
    }
    rounds.value = rounds.value.filter((r) => r.index < round.index);
    roundCounter = rounds.value.length;
    await save();
  }

  /** Revert a single file and remove it from its round */
  async function revertSingleFile(round: ChangeRound, filePath: string) {
    await revertFile(filePath);
    round.files = round.files.filter((f) => f.path !== filePath);
    await save();
  }

  // Watch session state transitions — serialized via pendingOp to prevent
  // race between captureChanges calls within the same round.
  watch(
    () => {
      const sid = sessionId();
      return sid ? sessionState[sid] : undefined;
    },
    (newState) => {
      if (!newState || newState === lastState) return;
      const prev = lastState;
      lastState = newState;

      // Transition: idle/stopped/waiting → running → Claude is about to process.
      // Skip if resuming from "attention" (permission prompt was granted).
      if (newState === "running" && prev !== "attention") {
        pendingOp = pendingOp.then(takeSnapshot, takeSnapshot);
      }
      // Transition: running/attention → stopped → process exited or killed.
      // Capture any remaining changes before the session goes cold.
      if (newState === "stopped" && (prev === "running" || prev === "attention")) {
        pendingOp = pendingOp.then(captureChanges, captureChanges);
      }
      // Transition: running/attention → waiting → Claude just finished a response.
      if (newState === "waiting" && (prev === "running" || prev === "attention")) {
        pendingOp = pendingOp.then(captureChanges, captureChanges);
      }
    },
  );

  return { rounds, revertRound, revertSingleFile };
}
