import { ref, watch } from "vue";
import { useSessionState } from "./useSessionState";
import { api } from "../api";
import type { ChangeRound, ChangeFile } from "../types";

export type { ChangeRound, ChangeFile };

export function useConversationChanges(sessionId: () => string) {
  const rounds = ref<ChangeRound[]>([]);
  const { state: sessionState } = useSessionState();

  let roundCounter = 0;
  let lastState = "";
  let pendingOp = Promise.resolve();
  let currentSid = "";

  /** Persist rounds to disk */
  async function save() {
    const sid = currentSid;
    if (!sid || sid.startsWith("new_")) return;
    try {
      await api.saveSessionChanges(sid, rounds.value);
    } catch (_) { /* best effort */ }
  }

  /** Load rounds from disk when session changes */
  watch(
    () => sessionId(),
    async (newSid) => {
      if (!newSid || newSid === currentSid || newSid.startsWith("new_")) return;
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
   * Before Claude starts processing: previously staged everything with git add -A.
   * Now a no-op — git_diff_files uses `git diff HEAD` which detects all changes
   * (staged, unstaged, and deletions) without needing a clean index baseline.
   * Removing `git add -A` prevents ephemeral files from being written into the
   * index, which previously made them look "real" to cleanup checks.
   */
  async function takeSnapshot() {
    // intentionally empty — see comment above
  }

  /** After Claude finishes: compute what changed and create a round entry */
  async function captureChanges() {
    try {
      const files = await api.gitDiffFiles();

      // Clean up ephemeral entries from previous rounds before saving new round.
      await cleanupPreviousRounds();

      if (files.length === 0) return;

      roundCounter++;
      const now = new Date();
      const time = now.toLocaleTimeString();
      rounds.value.push({ index: roundCounter, time, files });
      await save();
    } catch (_) { /* best effort */ }
  }

  /**
   * Remove entries from previous rounds for files that no longer exist on disk
   * AND were never committed to HEAD (ephemeral files: created + deleted within a session).
   */
  async function cleanupPreviousRounds() {
    if (rounds.value.length === 0) return;

    let changed = false;
    for (const round of rounds.value) {
      const before = round.files.length;
      // Check each file sequentially (git_has_file is fast: stat + cat-file)
      const kept: ChangeFile[] = [];
      for (const f of round.files) {
        if (await fileIsReal(f.path)) {
          kept.push(f);
        }
      }
      round.files = kept;
      if (round.files.length !== before) changed = true;
    }

    // Drop empty rounds
    const beforeLen = rounds.value.length;
    rounds.value = rounds.value.filter((r) => r.files.length > 0);
    if (rounds.value.length !== beforeLen) changed = true;

    if (changed) await save();
  }

  /** A file is "real" if it exists on disk OR was committed to HEAD at some point */
  async function fileIsReal(relativePath: string): Promise<boolean> {
    try {
      return await api.gitHasFile(relativePath);
    } catch (_) {
      // If the check fails, conservatively keep the entry
      return true;
    }
  }

  /** Revert a single file to its staged (pre-Claude) version */
  async function revertFile(filePath: string) {
    try {
      await api.gitRevertFile(filePath);
    } catch (_) { /* best effort */ }
  }

  /** Revert all files in a round */
  async function revertRound(round: ChangeRound) {
    for (const f of round.files) {
      await revertFile(f.path);
    }
    rounds.value = rounds.value.filter((r) => r.index < round.index);
    roundCounter = rounds.value.length;
    await save();
  }

  /** Revert a single file and remove it from its round */
  async function revertSingleFile(round: ChangeRound, filePath: string) {
    await revertFile(filePath);
    round.files = round.files.filter((f) => f.path !== filePath);
    if (round.files.length === 0) {
      rounds.value = rounds.value.filter((r) => r.index !== round.index);
    }
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
      // Transition: running/attention → waiting → Claude just finished a response.
      if (newState === "waiting" && (prev === "running" || prev === "attention")) {
        pendingOp = pendingOp.then(captureChanges, captureChanges);
      }
    },
  );

  return { rounds, revertRound, revertSingleFile };
}
