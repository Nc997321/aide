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
    // Remove this round and all later rounds (they may depend on reverted state)
    rounds.value = rounds.value.filter((r) => r.index < round.index);
    // Re-adjust counter so next round doesn't overlap
    roundCounter = rounds.value.length;
  }

  /** Revert a single file and remove it from its round */
  async function revertSingleFile(round: ChangeRound, filePath: string) {
    await revertFile(filePath);
    round.files = round.files.filter((f) => f.path !== filePath);
    if (round.files.length === 0) {
      rounds.value = rounds.value.filter((r) => r.index !== round.index);
    }
  }

  // Watch session state transitions
  watch(
    () => {
      const sid = sessionId();
      return sid ? sessionState[sid] : undefined;
    },
    async (newState) => {
      if (!newState || newState === lastState) return;
      const prev = lastState;
      lastState = newState;

      // Transition: idle → running → Claude is about to process
      if (newState === "running" && (prev === "waiting" || prev === "stopped" || prev === "")) {
        await takeSnapshot();
      }
      // Transition: running → waiting → Claude just finished a response
      if (newState === "waiting" && prev === "running") {
        await captureChanges();
      }
    },
  );

  return { rounds, revertRound, revertSingleFile };
}
