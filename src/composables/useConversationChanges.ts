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

  /** Before Claude starts processing: stage everything so we can diff later */
  async function takeSnapshot() {
    try {
      await api.gitStageAll();
    } catch (_) { /* best effort */ }
  }

  /** After Claude finishes: compute what changed and create a round entry */
  async function captureChanges() {
    try {
      const files = await api.gitDiffFiles();
      if (files.length === 0) return;

      roundCounter++;
      const now = new Date();
      const time = now.toLocaleTimeString();
      rounds.value.push({ index: roundCounter, time, files });
      await save();
    } catch (_) { /* best effort */ }
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

  // Watch session state transitions — serialized to prevent race between
  // takeSnapshot (git add -A) and captureChanges (git diff --numstat).
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
